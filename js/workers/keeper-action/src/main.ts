import { appendFile } from "node:fs/promises";
import { formatEther, formatGwei, type Hex } from "viem";
import { runKeeperCycle } from "ethswarm-volume-keeper";
import {
  brief,
  buildClient,
  makeScrubber,
  probeEndpoints,
  readConfig,
  type Config,
  type EndpointHealth,
} from "./config.js";

// ---------------------------------------------------------------------------
// GitHub Actions plumbing
// ---------------------------------------------------------------------------

/**
 * Every string leaving this process passes through here. Built from the raw
 * environment rather than the parsed config, so it is armed before the first
 * line of validation can report anything.
 */
const scrub = makeScrubber(
  (process.env.RPC_URL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Workflow commands take their payload percent-encoded, not backslash-escaped. */
const escapeData = (s: string): string =>
  s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

const annotate = (level: "error" | "warning" | "notice", message: string): void => {
  // Annotations surface on the run page and in the commit/PR timeline. They are
  // the only part of this output anyone sees without opening the logs.
  console.log(`::${level}::${escapeData(scrub(message))}`);
};

const summaryLines: string[] = [];
const summary = (line = ""): void => {
  summaryLines.push(scrub(line));
};

async function flushSummary(): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path || summaryLines.length === 0) return;
  try {
    await appendFile(path, `${summaryLines.join("\n")}\n`);
  } catch (err) {
    // A summary that cannot be written must never fail the keeper run.
    console.log(`could not write step summary: ${err instanceof Error ? err.message : err}`);
  }
}

const short = (id: Hex): string => `${id.slice(0, 10)}…${id.slice(-6)}`;

const bigintJson = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------

const OUTCOME_LABEL: Record<string, string> = {
  toppedUp: "topped up",
  retired: "retired",
  topupSkipped: "not funded",
  noop: "no action needed",
};

function reportEndpoints(health: EndpointHealth[], warnings: string[]): string[] {
  summary("### RPC endpoints");
  summary();
  summary("| Endpoint | Status | Chain | Block | Latency |");
  summary("|---|---|---|---|---|");
  for (const h of health) {
    summary(
      `| \`${h.redacted}\` | ${h.ok ? "ok" : `**failed** — ${h.error ?? "unknown"}`} | ${
        h.chainId ?? "—"
      } | ${h.blockNumber ?? "—"} | ${h.latencyMs} ms |`,
    );
  }
  summary();

  const usable = health.filter((h) => h.ok);
  for (const bad of health.filter((h) => !h.ok)) {
    warnings.push(`RPC ${bad.redacted} is unusable: ${brief(bad.error ?? "unknown")}`);
  }
  // KEEPERS.md: emit a warning whenever a fallback endpoint was required. The
  // primary being down is survivable and invisible unless something says so.
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

async function run(config: Config): Promise<{ ok: boolean; warnings: string[] }> {
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
  summary("### Keeper cycle");
  summary();
  summary(`- Registry \`${config.registry}\` on ${config.chain.name} (${config.chain.id})`);
  summary(`- Keeper \`${keeper}\` — balance ${formatEther(balance)}${runway}`);
  summary(`- Mode \`${result.mode}\`${config.dryRun ? " (dry run — nothing sent)" : ""}`);
  summary(
    `- ${result.volumeCount} active volume(s) at block ${result.blockNumber ?? "?"}, ${result.volumes.length} attempted in ${result.durationMs} ms`,
  );
  summary();

  if (result.volumes.length > 0) {
    summary("| Volume | Status | Outcome | Detail |");
    summary("|---|---|---|---|");
    for (const v of result.volumes) {
      const detail =
        v.amount !== undefined
          ? `${v.amount} BZZ-wei`
          : (v.reason ?? v.error ?? (v.hash ? short(v.hash) : "—"));
      summary(
        `| \`${short(v.volumeId)}\` | ${v.status} | ${
          v.outcome ? OUTCOME_LABEL[v.outcome] : "—"
        } | ${detail} |`,
      );
    }
    summary();
  }

  if (result.skipped) summary(`Nothing to do: ${result.skipped}`);
  if (result.error) summary(`**Cycle error:** ${result.error}`);

  // One machine-readable line, so the raw log is greppable the same way the
  // Worker's is. Scrubbed like everything else: `result.error` and each
  // volume's `error` are viem's words, and viem names the endpoint it used.
  console.log(
    scrub(
      JSON.stringify(
        {
          kind: "keeper-action/cycle",
          chainId: config.chain.id,
          registry: config.registry,
          keeper,
          balance,
          endpoints: health.map((h) => ({ endpoint: h.redacted, ok: h.ok })),
          ...result,
          warnings,
        },
        bigintJson,
      ),
    ),
  );

  if (result.error) annotate("error", `keeper cycle failed: ${result.error}`);
  for (const volumeId of result.failed) {
    const v = result.volumes.find((x) => x.volumeId === volumeId);
    annotate("error", `volume ${volumeId} ${v?.status ?? "failed"}: ${v?.error ?? "reverted"}`);
  }

  return { ok: result.ok, warnings };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  let config: Config;
  try {
    config = readConfig(process.env);
  } catch (err) {
    // Invalid configuration is a failure, per KEEPERS.md — never a quiet skip.
    const message = err instanceof Error ? err.message : String(err);
    annotate("error", `configuration error: ${message}`);
    summary(`### Keeper cycle\n\n**Configuration error:** ${message}`);
    return 1;
  }

  try {
    const { ok, warnings } = await run(config);
    for (const w of warnings) annotate("warning", w);

    if (warnings.length > 0) {
      summary();
      summary("### Warnings");
      summary();
      for (const w of warnings) summary(`- ${w}`);
    }

    if (!ok) return 1;
    // GitHub only notifies on a *failed* run, so a warning is invisible unless
    // someone opens the page. Where the built-in notification is the only alert
    // channel, FAIL_ON_WARNING turns "balance is nearly out" into something
    // that actually reaches a human.
    if (config.failOnWarning && warnings.length > 0) {
      annotate(
        "error",
        `failing the run because FAIL_ON_WARNING is set and ${warnings.length} warning(s) were raised`,
      );
      return 1;
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    annotate("error", message);
    summary(`\n**Failed:** ${message}`);
    return 1;
  }
}

const code = await main();
await flushSummary();
process.exitCode = code;

// Nothing here schedules a timer, so a clean run ends on its own. Keep-alive
// sockets can still hold the loop open for a while; this unref'd timer does not
// keep the process alive by itself, but fires if something else is, so a run
// cannot sit burning the job's clock after the work is done.
setTimeout(() => process.exit(code), 5_000).unref();
