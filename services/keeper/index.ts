/**
 * One keeper cycle, run by .github/workflows/keeper.yml on a cron schedule.
 *
 * The whole run is here rather than split across `run:` steps in the workflow:
 * the conditions worth reporting — a failover, a payer that stopped paying, a
 * wallet running dry — are ones this process knows and YAML does not.
 */
import { runKeeperCycle } from "ethswarm-volume-keeper";
import { formatEther, formatGwei } from "viem";
import {
  brief,
  buildClient,
  makeScrubber,
  probeEndpoints,
  readConfig,
  type Config,
  type EndpointHealth,
} from "./src/config.ts";
import { OUTCOME_LABEL, Report, short } from "./src/report.ts";
import { notify, readNotifyConfig, type Notification } from "./src/notify.ts";

/**
 * Built from the raw environment, not the parsed config, so it is armed before
 * the first line of validation can report anything.
 */
const scrub = makeScrubber(
  (process.env.RPC_URL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const report = new Report(scrub);

/** Endpoint health, as a summary table plus whatever it is worth warning about. */
function reportEndpoints(health: EndpointHealth[], warnings: string[]): string[] {
  report.line("### RPC endpoints");
  report.line();
  report.table(
    ["Endpoint", "Status", "Chain", "Block", "Latency"],
    health.map((h) => [
      `\`${h.redacted}\``,
      h.ok ? "ok" : `**failed** — ${brief(h.error ?? "unknown", 80)}`,
      String(h.chainId ?? "—"),
      String(h.blockNumber ?? "—"),
      `${h.latencyMs} ms`,
    ]),
  );

  const usable = health.filter((h) => h.ok);
  for (const bad of health.filter((h) => !h.ok)) {
    warnings.push(`RPC ${bad.redacted} is unusable: ${brief(bad.error ?? "unknown")}`);
  }
  // KEEPERS.md: warn whenever a fallback endpoint was required. The primary
  // being down is survivable, and invisible unless something says so.
  if (usable.length > 0 && !health[0]!.ok) {
    warnings.push(
      `primary RPC ${health[0]!.redacted} is down; failing over to ${usable[0]!.redacted}`,
    );
  }
  if (health.length === 1 && usable.length === 1) {
    warnings.push(
      "only one RPC endpoint is configured — a single provider outage stops this keeper",
    );
  }
  return usable.map((h) => h.url);
}

async function runCycle(config: Config): Promise<{ ok: boolean; warnings: string[] }> {
  const warnings: string[] = [];

  const health = await probeEndpoints(config.endpoints, config.chain);
  const usable = reportEndpoints(health, warnings);
  if (usable.length === 0) {
    throw new Error(
      `no usable RPC endpoint: all ${health.length} configured endpoint(s) failed the pre-flight check`,
    );
  }

  const client = buildClient(config, usable);
  const keeper = client.account.address;

  const result = await runKeeperCycle(client, {
    registry: config.registry,
    mode: config.mode,
    dryRun: config.dryRun,
    maxVolumesPerCycle: config.maxVolumesPerCycle,
    pageSize: config.pageSize,
    confirmations: config.confirmations,
    receiptTimeout: config.receiptTimeout,
    cycleTimeout: config.cycleTimeout,
  });
  warnings.push(...result.warnings);

  // --- wallet runway ------------------------------------------------------
  const balance = await client.getBalance({ address: keeper });
  const gasUsed = result.volumes.reduce((sum, v) => sum + (v.gasUsed ?? 0n), 0n);
  let runway = "";
  if (gasUsed > 0n) {
    const gasPrice = await client.getGasPrice();
    const spent = gasUsed * gasPrice;
    if (spent > 0n) {
      runway = ` — about ${balance / spent} more cycle(s) at ${formatGwei(gasPrice)} gwei`;
    }
  }
  if (config.minBalanceWei > 0n && balance < config.minBalanceWei) {
    warnings.push(
      `keeper balance ${formatEther(balance)} is below the floor of ${formatEther(
        config.minBalanceWei,
      )}${runway}`,
    );
  }

  // --- summary ------------------------------------------------------------
  report.line("### Keeper cycle");
  report.line();
  report.line(
    `- Registry \`${config.registry}\` on ${config.chain.name} (${config.chain.id})`,
  );
  report.line(`- Keeper \`${keeper}\` — balance ${formatEther(balance)}${runway}`);
  report.line(
    `- Mode \`${result.mode}\`${config.dryRun ? " (dry run — nothing sent)" : ""}`,
  );
  report.line(
    `- ${result.volumeCount} active volume(s) at block ${result.blockNumber ?? "?"}, ${result.volumes.length} attempted in ${result.durationMs} ms`,
  );
  report.line();

  if (result.volumes.length > 0) {
    report.table(
      ["Volume", "Status", "Outcome", "Detail"],
      result.volumes.map((v) => [
        `\`${short(v.volumeId)}\``,
        v.status,
        v.outcome ? (OUTCOME_LABEL[v.outcome] ?? v.outcome) : "—",
        v.amount !== undefined
          ? `${v.amount} BZZ-wei`
          : (v.reason ?? (v.error ? brief(v.error, 80) : v.hash ? short(v.hash) : "—")),
      ]),
    );
  }

  if (result.skipped) report.line(`Nothing to do: ${result.skipped}`);
  if (result.error) report.line(`**Cycle error:** ${result.error}`);

  report.json({
    kind: "keeper/cycle",
    chainId: config.chain.id,
    registry: config.registry,
    keeper,
    balance,
    endpoints: health.map((h) => ({ endpoint: h.redacted, ok: h.ok })),
    ...result,
    warnings,
  });

  if (result.error) report.annotate("error", `keeper cycle failed: ${result.error}`);
  for (const volumeId of result.failed) {
    const v = result.volumes.find((x) => x.volumeId === volumeId);
    report.annotate(
      "error",
      `volume ${volumeId} ${v?.status ?? "failed"}: ${v?.error ?? "reverted"}`,
    );
  }

  return { ok: result.ok, warnings };
}

async function main(): Promise<number> {
  const notifyConfig = readNotifyConfig(process.env);

  const send = async (notification: Notification): Promise<void> => {
    const { sent, reason } = await notify(notifyConfig, notification);
    if (!sent && reason && reason !== "no notification channel configured") {
      report.annotate("warning", `could not send notification: ${reason}`);
    }
  };

  let config: Config;
  try {
    config = readConfig(process.env);
  } catch (err) {
    // Invalid configuration is a failure, per KEEPERS.md — never a quiet skip.
    const message = err instanceof Error ? err.message : String(err);
    report.annotate("error", `configuration error: ${message}`);
    report.line(`### Keeper cycle`);
    report.line();
    report.line(`**Configuration error:** ${message}`);
    await send({
      severity: "failure",
      title: "Keeper is misconfigured and did not run",
      details: [message],
    });
    return 1;
  }

  const where = `${config.chain.name} (chain ${config.chain.id})`;

  try {
    const { ok, warnings } = await runCycle(config);
    for (const w of warnings) report.annotate("warning", w);

    if (warnings.length > 0) {
      report.line();
      report.line("### Warnings");
      report.line();
      for (const w of warnings) report.line(`- ${w}`);
    }

    if (!ok) {
      await send({
        severity: "failure",
        title: `Keeper cycle failed on ${where}`,
        details: warnings.slice(0, 6),
      });
      return 1;
    }

    // GitHub only notifies on a *failed* run, so a warning is invisible unless
    // someone opens the page. FAIL_ON_WARNING turns "balance is nearly out"
    // into something that reaches a human — and composes with the notifier
    // below, since both key off the same verdict.
    if (config.failOnWarning && warnings.length > 0) {
      report.annotate(
        "error",
        `failing the run because FAIL_ON_WARNING is set and ${warnings.length} warning(s) were raised`,
      );
      await send({
        severity: "warning",
        title: `Keeper raised ${warnings.length} warning(s) on ${where}`,
        details: warnings.slice(0, 6),
      });
      return 1;
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.annotate("error", message);
    report.line();
    report.line(`**Failed:** ${message}`);
    await send({
      severity: "failure",
      title: `Keeper cycle failed on ${where}`,
      details: [scrub(brief(message, 300))],
    });
    return 1;
  }
}

const code = await main();
await report.flush();
process.exitCode = code;

// Nothing here schedules a timer, so a clean run ends on its own. Keep-alive
// sockets can still hold the loop open; this unref'd timer does not keep the
// process alive by itself, but fires if something else is, so a finished run
// cannot sit burning the job's clock.
setTimeout(() => process.exit(code), 5_000).unref();
