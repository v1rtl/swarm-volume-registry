/**
 * The keeper as a GitHub Actions job: the adapter in src/gha/, whole runs
 * through it against the mock chain, and the workflow that schedules it.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { KeeperEnv } from "../src/config.js";
import {
  DEPLOYMENTS,
  bindings,
  maskCommands,
  readDeployment,
  runInActions,
  type DeploymentConfig,
} from "../src/gha/run.js";
import { MAX_ANNOTATIONS, annotations, formatSummary } from "../src/gha/summary.js";
import type { KeeperReport } from "../src/reporting.js";
import { cronIntervalSeconds, runBudgetMs } from "../src/schedule.js";
import { REGISTRY, mockChain, volumeId, type MockVolume } from "./mock-chain.js";

/** anvil account #1 — a well-known throwaway key, test fixtures only. */
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TOKEN = "123456789:AAtest-BOTSECRET-fixtures-only";
const LIVE = "https://live.example/v3/LIVESECRET";
const DEAD = "https://dead.example/v3/DEADSECRET";
const HEARTBEAT = "https://hc.example/ping/BEATSECRET-0000";
const SECRETS = ["LIVESECRET", "DEADSECRET", "BOTSECRET", "BEATSECRET", KEY.slice(2)];
const RUN_URL = "https://github.com/owner/repo/actions/runs/42";

const due = (n: number): MockVolume => ({
  volumeId: volumeId(n),
  batch: { normalisedBalance: 1_000_000n + 1n },
});

/** What the workflow's `Run keeper` step puts in the environment. */
const jobEnv = (overrides: Record<string, string | undefined> = {}) => ({
  KEEPER_ENV: "sepolia",
  KEEPER_CRON: "17 * * * *",
  DRY_RUN: "",
  PRIVATE_KEY: KEY,
  RPC_URL: LIVE,
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_CHAT_ID: "-1001234567890",
  HEARTBEAT_URL: HEARTBEAT,
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_RUN_ID: "42",
  // Present on every runner; none of it may reach the Worker's bindings.
  HOME: "/home/runner",
  GITHUB_TOKEN: "ghs_not-a-binding",
  ...overrides,
});

/** The committed Sepolia deployment, pointed at the mock chain's registry. */
const onMockChain = (name: string): DeploymentConfig => {
  const deployment = readDeployment(name);
  return { ...deployment, vars: { ...deployment.vars, REGISTRY_ADDRESS: REGISTRY } };
};

// --- the network ------------------------------------------------------------

type Chain = ReturnType<typeof mockChain>;
let rpc: Map<string, Chain | "down">;
let telegram: string[];
let heartbeat: { status: number; pings: number };
let rpcRequests: number;

function serve(url: string, init?: RequestInit): Promise<Response> | Response {
  if (url.startsWith("https://api.telegram.org/")) {
    telegram.push(JSON.parse(String(init?.body)).text);
    return new Response('{"ok":true}');
  }
  if (url === HEARTBEAT) {
    heartbeat.pings++;
    return new Response("", { status: heartbeat.status });
  }
  const route = rpc.get(url);
  if (!route) throw new Error(`no route for ${url}`);
  rpcRequests++;
  if (route === "down") return new Response("bad gateway", { status: 502 });
  const { id, method, params } = JSON.parse(String(init?.body));
  return route.request({ method, params }).then(
    (result) => Response.json({ jsonrpc: "2.0", id, result }),
    (err: Error & { code?: number }) =>
      Response.json({ jsonrpc: "2.0", id, error: { code: err.code ?? -32000, message: err.message } }),
  );
}

// --- the job ----------------------------------------------------------------

let stdout: string[];
let summary: string[];
let logs: string[];
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  rpc = new Map();
  telegram = [];
  heartbeat = { status: 200, pings: 0 };
  rpcRequests = 0;
  stdout = [];
  summary = [];
  logs = [];
  for (const level of ["log", "warn", "error"] as const) {
    spies.push(spyOn(console, level).mockImplementation((line: unknown) => void logs.push(String(line))));
  }
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(((input: RequestInfo | URL, init?: RequestInit) =>
      serve(String(input), init)) as typeof fetch),
  );
});

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

const run = (env = jobEnv(), read = onMockChain) =>
  runInActions(
    env,
    { write: (line) => void stdout.push(line), summary: (md) => void summary.push(md) },
    read,
  );

/** The run's report, as it was logged. */
function logged(): KeeperReport {
  const reports = logs.map((l) => JSON.parse(l)).filter((e) => e.kind === "keeper/run");
  expect(reports).toHaveLength(1);
  return reports[0];
}

/** Everything a reader of the public run page, or the group, could see. */
const visible = () =>
  [...stdout.filter((l) => !l.startsWith("::add-mask::")), ...logs, ...summary, ...telegram].join("\n");

// --- configuration ----------------------------------------------------------

describe("readDeployment", () => {
  test.each([...DEPLOYMENTS])("%s resolves to its committed env", (name) => {
    const { vars, secrets } = readDeployment(name);
    expect(vars.DEPLOYMENT_NAME).toBe(`keeper-${name}`);
    expect(secrets.sort()).toEqual(["PRIVATE_KEY", "RPC_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);
  });

  test.each(["", "mainnet", "SEPOLIA"])("rejects %p", (name) => {
    expect(() => readDeployment(name)).toThrow(/KEEPER_ENV must be one of sepolia, gnosis/);
  });
});

describe("bindings", () => {
  const deployment = readDeployment("gnosis");

  test("committed vars, plus only the secrets and the Worker's overrides", () => {
    const env = bindings(deployment, jobEnv({ VOLUME_IDS: `0x${"11".repeat(32)}`, PAGE_SIZE: "25" }));
    expect(Object.keys(env).sort()).toEqual(
      [
        ...Object.keys(deployment.vars),
        ...deployment.secrets,
        "VOLUME_IDS",
        "PAGE_SIZE",
      ].sort(),
    );
    expect(env.CHAIN_ID).toBe("100");
    expect(env.PRIVATE_KEY).toBe(KEY);
  });

  // Configuration is wrangler.jsonc's, whichever platform runs it.
  test("the job's environment cannot override a committed var", () => {
    const env = bindings(deployment, jobEnv({ CHAIN_ID: "11155111", MAX_VOLUMES_PER_CYCLE: "1000" }));
    expect(env.CHAIN_ID).toBe("100");
    expect(env.MAX_VOLUMES_PER_CYCLE).toBe(deployment.vars.MAX_VOLUMES_PER_CYCLE!);
  });

  // A scheduled run has no inputs, so `inputs.dry_run` renders as "".
  test("an empty value is unset", () => {
    expect(bindings(deployment, jobEnv({ DRY_RUN: "" }))).not.toHaveProperty("DRY_RUN");
    expect(bindings(deployment, jobEnv({ DRY_RUN: "true" })).DRY_RUN).toBe("true");
  });
});

describe("maskCommands", () => {
  const env = {
    PRIVATE_KEY: KEY,
    RPC_URL: ` ${DEAD}/ , ${LIVE}`,
    TELEGRAM_BOT_TOKEN: TOKEN,
  } as KeeperEnv;
  const masked = maskCommands(env, [HEARTBEAT]).map((l) => l.replace("::add-mask::", ""));

  // GitHub masks a secret only as the whole string it was stored as: one entry
  // of a comma-separated RPC_URL would otherwise print in the clear.
  test("masks each RPC entry on its own", () => {
    expect(masked).toContain(LIVE);
    expect(masked).toContain(DEAD);
    expect(masked).toContain(`${DEAD}/`);
  });

  test("masks the key with and without 0x, the token's secret half, and extras", () => {
    expect(masked).toContain(KEY);
    expect(masked).toContain(KEY.slice(2));
    expect(masked).toContain(TOKEN);
    expect(masked).toContain(TOKEN.split(":")[1]!);
    expect(masked).toContain(HEARTBEAT);
  });

  test("never masks something too short to be a secret", () => {
    const short = maskCommands({ PRIVATE_KEY: "0x1", RPC_URL: "", TELEGRAM_BOT_TOKEN: "1:a" } as KeeperEnv);
    expect(short).toEqual([]);
  });
});

// --- whole runs -------------------------------------------------------------

describe("runInActions", () => {
  test("a healthy run exits 0, summarises, and sends the heartbeat", async () => {
    const chain = mockChain({ volumes: [due(1), due(2)] });
    rpc.set(LIVE, chain);

    expect(await run()).toBe(0);

    expect(chain.triggerCalls).toEqual([volumeId(1), volumeId(2)]);
    expect(logged()).toMatchObject({
      status: "ok",
      deployment: "keeper-sepolia",
      cron: "17 * * * *",
      runUrl: RUN_URL,
    });
    expect(stdout.every((l) => l.startsWith("::add-mask::"))).toBe(true);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain("## 🟢 keeper-sepolia: 2 volumes of 2 triggered");
    expect(summary[0]).toContain(`| \`${volumeId(1)}\` | success [`);
    expect(heartbeat.pings).toBe(1);
    expect(telegram).toEqual([]);
  });

  // Masks must be registered before anything the run prints.
  test("masks come first", async () => {
    rpc.set(LIVE, mockChain({ volumes: [due(1)], revertTx: true }));
    await run();
    const firstOther = stdout.findIndex((l) => !l.startsWith("::add-mask::"));
    expect(firstOther).toBeGreaterThan(0);
    expect(stdout.slice(firstOther).some((l) => l.startsWith("::add-mask::"))).toBe(false);
  });

  test("a failed volume exits 1, annotates it, links the run, and skips the heartbeat", async () => {
    rpc.set(LIVE, mockChain({ volumes: [due(1)], revertTx: true }));

    expect(await run()).toBe(1);

    const errors = stdout.filter((l) => l.startsWith("::error"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith("::error title=keeper-sepolia::transaction reverted — volume ");
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toContain(`Run: ${RUN_URL}`);
    expect(heartbeat.pings).toBe(0);
  });

  test("a dry run maintains nothing, so it sends no heartbeat", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    rpc.set(LIVE, chain);

    expect(await run(jobEnv({ DRY_RUN: "true" }))).toBe(0);

    expect(chain.calls).not.toContain("eth_sendRawTransaction");
    expect(stdout).toContain("::warning title=keeper-sepolia::dry run: nothing was sent");
    expect(heartbeat.pings).toBe(0);
  });

  test("missing secrets fail the run without touching an RPC", async () => {
    expect(await run(jobEnv({ PRIVATE_KEY: "", RPC_URL: undefined }))).toBe(1);
    expect(rpcRequests).toBe(0);
    expect(logged().failures.map((f) => f.message)).toEqual([
      "PRIVATE_KEY is required",
      "RPC_URL is required",
    ]);
    expect(telegram[0]).toContain("PRIVATE_KEY is required");
  });

  test("an unknown deployment fails before anything runs", async () => {
    expect(await run(jobEnv({ KEEPER_ENV: "mainnet" }), readDeployment)).toBe(1);
    expect(stdout).toEqual([
      '::error title=keeper::KEEPER_ENV must be one of sepolia, gnosis, got "mainnet"',
    ]);
    expect(rpcRequests).toBe(0);
    expect(telegram).toEqual([]);
  });

  test("a failed heartbeat is a warning, not a failed run", async () => {
    rpc.set(LIVE, mockChain({ volumes: [due(1)] }));
    heartbeat.status = 500;

    expect(await run()).toBe(0);
    expect(stdout.at(-1)).toBe("::warning title=heartbeat::heartbeat ping failed: HTTP 500");
  });

  test("without HEARTBEAT_URL there is nothing to ping", async () => {
    rpc.set(LIVE, mockChain({ volumes: [due(1)] }));
    expect(await run(jobEnv({ HEARTBEAT_URL: "" }))).toBe(0);
    expect(heartbeat.pings).toBe(0);
  });

  // Run logs of a public repository are world-readable.
  test("no secret reaches the log, the summary or the group", async () => {
    rpc.set(DEAD, "down");
    rpc.set(LIVE, mockChain({ volumes: [due(1)], revertTx: true }));

    expect(await run(jobEnv({ RPC_URL: `${DEAD},${LIVE}` }))).toBe(1);

    const output = visible();
    expect(output).toContain("dead.example");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });
});

// --- rendering --------------------------------------------------------------

describe("summary and annotations", () => {
  const report = (overrides: Partial<KeeperReport> = {}): KeeperReport => ({
    kind: "keeper/run",
    status: "failure",
    summary: "keeper-test: run failed",
    deployment: "keeper-test",
    failures: [],
    warnings: [],
    durationMs: 1200,
    ...overrides,
  });

  test("past GitHub's cap, the last annotation says how many more", () => {
    const failures = Array.from({ length: 15 }, (_, i) => ({ message: `failure ${i}` }));
    const lines = annotations(report({ failures }));
    expect(lines).toHaveLength(MAX_ANNOTATIONS);
    expect(lines.at(-1)).toBe("::error title=keeper-test::… and 6 more — see the job summary");
  });

  test("annotations escape what would end or split the command", () => {
    const [line] = annotations(
      report({ deployment: "a:b,c", failures: [{ message: "100% bad\nsecond line" }] }),
    );
    expect(line).toBe("::error title=a%3Ab%2Cc::100%25 bad%0Asecond line");
  });

  test("table cells cannot break the table", () => {
    const md = formatSummary(report({ summary: "x | y\nz" }));
    expect(md).toStartWith("## 🔴 x | y z\n");
    expect(md).not.toContain("\nz");
  });

  test("without a known chain, nothing is linked", () => {
    const md = formatSummary(report({ chainId: 1, registry: REGISTRY }));
    expect(md).toContain(`| Registry | \`${REGISTRY}\` |`);
    expect(md).not.toContain("](");
  });
});

// --- the workflow -----------------------------------------------------------

const WORKFLOW = join(import.meta.dir, "..", "..", "..", ".github", "workflows", "keeper-run.yml");

/** Checkout, toolchain and install, ahead of the run itself. */
const SETUP_MS = 5 * 60_000;

describe("keeper-run.yml", async () => {
  // Parsed YAML is untyped; the assertions below are its schema.
  const workflow: any = Bun.YAML.parse(await Bun.file(WORKFLOW).text());
  const job = workflow.jobs.run;
  const step = job.steps.find((s: { name?: string }) => s.name === "Run keeper");
  const crons: string[] = workflow.on.schedule.map((s: { cron: string }) => s.cron);

  // Sepolia's graceBlocks (~2.4 min) is shorter than GitHub's minimum
  // interval: a schedule here could only look like it maintains it.
  test("schedules keeper-gnosis alone, and only while its platform is github", () => {
    expect(job.if).toBe(
      "github.event_name == 'workflow_dispatch' || vars.KEEPER_PLATFORM_GNOSIS == 'github'",
    );
    expect(step.env.KEEPER_ENV).toBe("${{ inputs.environment || 'gnosis' }}");
    expect(job.environment.name).toBe("keeper-${{ inputs.environment || 'gnosis' }}");
    expect(workflow.concurrency.group).toBe("keeper-run-${{ inputs.environment || 'gnosis' }}");
  });

  // KEEPERS.md: prevent overlapping invocations that share a wallet.
  test("never cancels a run, and a whole run fits the job and the interval", () => {
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(crons).toHaveLength(1);
    const intervalMs = cronIntervalSeconds(crons[0]!) * 1000;
    const timeoutMs = job["timeout-minutes"] * 60_000;
    expect(runBudgetMs(readDeployment("gnosis").vars) + SETUP_MS).toBeLessThanOrEqual(timeoutMs);
    expect(timeoutMs).toBeLessThanOrEqual(intervalMs);
  });

  test("dispatches either deployment, dry run by default", () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs.environment.options).toEqual([...DEPLOYMENTS]);
    expect(inputs.environment.default).toBe("sepolia");
    expect(inputs.dry_run.default).toBe(true);
    expect(step.env.DRY_RUN).toBe("${{ inputs.dry_run }}");
  });

  test("passes every deployment's required secrets, from the environment's secrets", () => {
    for (const name of DEPLOYMENTS) {
      for (const secret of readDeployment(name).secrets) {
        expect(step.env[secret]).toBe(`\${{ secrets.${secret} }}`);
      }
    }
  });

  test("holds no more permission than reading the repository", () => {
    expect(workflow.permissions).toEqual({});
    expect(job.permissions).toEqual({ contents: "read" });
    for (const s of job.steps.filter((s: { uses?: string }) => s.uses)) {
      expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
