/**
 * The keeper as a GitHub Actions job: the Worker's own `runScheduled`, behind a
 * thin adapter. `.github/workflows/keeper-run.yml` stands in for Cron Triggers.
 *
 * Each deployment's configuration is its env in wrangler.jsonc, read by
 * wrangler itself — never copied into repository variables, so the two
 * platforms cannot drift apart. Only the secrets come from the job's
 * environment, from the GitHub Environment the workflow selects.
 *
 * Run logs of a public repository are world-readable. GitHub masks a secret
 * only as the whole string it was stored as, so every piece of one that could
 * be printed on its own — each `RPC_URL` entry above all — is masked
 * explicitly before anything runs. The report scrubber stays as a second
 * layer behind that.
 */
import { join } from "node:path";
import { unstable_readConfig } from "wrangler";
import type { KeeperEnv } from "../config.js";
import { runScheduled } from "../index.js";
import { makeScrubber, type KeeperReport } from "../reporting.js";
import { annotations, escapeData, formatSummary } from "./summary.js";

export const DEPLOYMENTS = ["sepolia", "gnosis"] as const;

const WRANGLER = join(import.meta.dir, "..", "..", "wrangler.jsonc");

/** The Worker's optional overrides, which no committed deployment sets. */
const OVERRIDES = ["DRY_RUN", "VOLUME_IDS", "PAGE_SIZE"] as const;

/** Shorter than this is not a real secret, and masking it would shred the log. */
const MIN_MASK_LENGTH = 8;

export interface DeploymentConfig {
  /** The env's `vars`, exactly as `wrangler deploy --env <name>` would ship them. */
  vars: Record<string, string>;
  /** Its `secrets.required`: the only names read from the job's environment. */
  secrets: string[];
}

/** A deployment's committed configuration, resolved by wrangler. */
export function readDeployment(name: string): DeploymentConfig {
  if (!(DEPLOYMENTS as readonly string[]).includes(name)) {
    throw new Error(
      `KEEPER_ENV must be one of ${DEPLOYMENTS.join(", ")}, got ${name ? `"${name}"` : "nothing"}`,
    );
  }
  const config = unstable_readConfig({ config: WRANGLER, env: name });
  const vars = Object.fromEntries(
    Object.entries(config.vars ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
  return { vars, secrets: [...(config.secrets?.required ?? [])] };
}

/**
 * The bindings a Worker of this deployment would see: its committed vars, plus
 * its secrets and the optional overrides from the job's environment. Nothing
 * else in the environment gets through, and nothing in it can override a
 * committed var.
 */
export function bindings(
  deployment: DeploymentConfig,
  processEnv: Record<string, string | undefined>,
): KeeperEnv {
  const env: Record<string, string> = { ...deployment.vars };
  for (const name of [...deployment.secrets, ...OVERRIDES]) {
    if (name in deployment.vars) continue;
    const value = processEnv[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return env as unknown as KeeperEnv;
}

/** `::add-mask::` for every secret, and every printable piece of one. */
export function maskCommands(env: KeeperEnv, extra: readonly string[] = []): string[] {
  const values = new Set<string>();
  for (const raw of (env.RPC_URL ?? "").split(",")) {
    const url = raw.trim();
    values.add(url);
    values.add(url.replace(/\/+$/, ""));
    try {
      values.add(new URL(url).href);
    } catch {
      // Unparseable: the raw form is still worth masking.
    }
  }
  const key = env.PRIVATE_KEY?.trim() ?? "";
  values.add(key).add(key.replace(/^0x/i, ""));
  const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  values.add(token).add(token.split(":").slice(1).join(":"));
  for (const value of extra) values.add(value.trim());

  return [...values]
    .filter((v) => v.length >= MIN_MASK_LENGTH)
    .map((v) => `::add-mask::${escapeData(v)}`);
}

export interface ActionsIO {
  /** One line to the job log: workflow commands and annotations. */
  write(line: string): void;
  /** Append to the job summary. Absent outside Actions. */
  summary?(markdown: string): void;
  fetch?: typeof fetch;
}

/**
 * One keeper run in a GitHub Actions job. Returns the process exit code: 1
 * when the run failed, so the job does too and GitHub's own failure email
 * fires alongside Telegram.
 */
export async function runInActions(
  processEnv: Record<string, string | undefined>,
  io: ActionsIO,
  read: (name: string) => DeploymentConfig = readDeployment,
): Promise<number> {
  let deployment: DeploymentConfig;
  try {
    deployment = read(processEnv.KEEPER_ENV?.trim() ?? "");
  } catch (err) {
    io.write(`::error title=keeper::${escapeData(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }

  const env = bindings(deployment, processEnv);
  const heartbeat = processEnv.HEARTBEAT_URL?.trim() || undefined;
  for (const line of maskCommands(env, heartbeat ? [heartbeat] : [])) io.write(line);

  const report = await runScheduled(env, {
    ...(processEnv.KEEPER_CRON ? { cron: processEnv.KEEPER_CRON } : {}),
    ...runUrl(processEnv),
  });

  for (const line of annotations(report)) io.write(line);
  io.summary?.(formatSummary(report));

  if (heartbeat && maintained(report)) {
    const problem = await ping(heartbeat, io.fetch ?? fetch);
    if (problem) {
      const scrub = makeScrubber({ rpcUrls: [heartbeat] });
      io.write(`::warning title=heartbeat::${escapeData(scrub(`heartbeat ping failed: ${problem}`))}`);
    }
  }

  return report.status === "failure" ? 1 : 0;
}

/**
 * Whether the run kept its volumes alive — what the heartbeat vouches for. A
 * failed run already alerts; a dry run maintained nothing.
 */
const maintained = (report: KeeperReport): boolean =>
  report.status !== "failure" && !report.dryRun;

function runUrl(processEnv: Record<string, string | undefined>): { runUrl?: string } {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: id } = processEnv;
  return server && repo && id ? { runUrl: `${server}/${repo}/actions/runs/${id}` } : {};
}

/** A dead-man's switch: it alerts when these stop, which nothing else can. */
async function ping(url: string, doFetch: typeof fetch): Promise<string | undefined> {
  try {
    const response = await doFetch(url, { signal: AbortSignal.timeout(10_000) });
    return response.ok ? undefined : `HTTP ${response.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
