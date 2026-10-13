import { PROBE_TIMEOUT_MS } from "./client.js";

/**
 * The cron shapes the deployments use, read the same way by the budget check
 * in test/config.test.ts and by the GitHub Actions schedule check in
 * test/gha.test.ts, so every schedule a deployment runs on is one its budget
 * was checked against.
 */

/** Cron Triggers stop a run at 15 minutes regardless of schedule. */
export const MAX_RUN_SECONDS = 15 * 60;

/** Everything around the cycle: reads, the balance check, the alert. */
export const SLACK_MS = 5_000;

/**
 * Seconds between runs. Anything other than the shapes below fails loudly, so
 * the budget checks cannot be skipped by accident.
 */
export function cronIntervalSeconds(expr: string): number {
  const [minute, hour] = fields(expr);
  if (hour === "*" && minute === "*") return 60;
  if (hour === "*" && /^\*\/\d+$/.test(minute)) return Number(minute.slice(2)) * 60;
  if (hour === "*" && /^\d+$/.test(minute)) return 3600;
  throw new Error(`unsupported cron: ${expr} — teach cronIntervalSeconds about it`);
}

/**
 * The longest one run can take: the RPC probe, then `CYCLE_TIMEOUT_MS` (no new
 * transaction starts after it), then `RECEIPT_TIMEOUT_MS` for the last one,
 * then {@link SLACK_MS}.
 */
export function runBudgetMs(vars: Record<string, string>): number {
  return (
    PROBE_TIMEOUT_MS + Number(vars.CYCLE_TIMEOUT_MS) + Number(vars.RECEIPT_TIMEOUT_MS) + SLACK_MS
  );
}

function fields(expr: string): [string, string] {
  const parts = expr.trim().split(/\s+/);
  const [minute, hour, dom, month, dow] = parts;
  if (parts.length !== 5 || [dom, month, dow].some((f) => f !== "*")) {
    throw new Error(`unsupported cron: ${expr}`);
  }
  return [minute!, hour!];
}
