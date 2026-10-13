/**
 * The run report as GitHub Actions shows it: a job summary and annotations.
 * Like the Telegram alert, both are renderings of the one {@link KeeperReport}
 * that is also logged, so none of them can say something the others do not.
 */
import { formatEther } from "viem";
import { CHAINS } from "../client.js";
import type { KeeperIssue } from "../keeper/types.js";
import type { KeeperReport } from "../reporting.js";

const ICON = { failure: "🔴", warning: "🟡", ok: "🟢" } as const;

/** GitHub shows at most this many annotations of each level per step. */
export const MAX_ANNOTATIONS = 10;

export function formatSummary(report: KeeperReport): string {
  const chain = report.chainId === undefined ? undefined : CHAINS[report.chainId];
  const explorer = chain?.blockExplorers?.default.url;
  const link = (kind: "tx" | "address", value: string, label = value) =>
    explorer ? `[\`${label}\`](${explorer}/${kind}/${value})` : `\`${label}\``;
  const tx = (hash: string) => link("tx", hash, `${hash.slice(0, 10)}…`);

  const rows: Array<[string, string | undefined]> = [
    ["Deployment", `\`${report.deployment}\``],
    [
      "Chain",
      report.chainId === undefined
        ? "unknown (CHAIN_ID unset or invalid)"
        : `${report.chainName ?? "unsupported chain"} (${report.chainId})`,
    ],
    ["Registry", report.registry ? link("address", report.registry) : "unset"],
    ["Keeper", report.keeper ? link("address", report.keeper) : undefined],
    [
      "Balance",
      report.balanceWei === undefined
        ? undefined
        : `${formatEther(BigInt(report.balanceWei))} ${chain?.nativeCurrency.symbol ?? ""}`.trim(),
    ],
    ["Block", report.blockNumber],
    [
      "Volumes",
      report.volumeCount === undefined
        ? undefined
        : `${report.volumes?.length ?? 0} attempted of ${report.volumeCount} active`,
    ],
    ["Dry run", report.dryRun ? "yes — nothing was sent" : undefined],
    ["Schedule", report.cron ? `\`${report.cron}\`` : "manual"],
    ["Duration", `${(report.durationMs / 1000).toFixed(1)} s`],
  ];

  const out = [
    `## ${ICON[report.status]} ${inline(report.summary)}`,
    "",
    "| | |",
    "|---|---|",
    ...rows.filter(([, v]) => v !== undefined).map(([k, v]) => `| ${k} | ${cell(v!)} |`),
  ];

  const issues = (title: string, list: KeeperIssue[]) => {
    if (list.length === 0) return;
    out.push("", `### ${title}`, "");
    for (const issue of list) {
      const where = [
        ...(issue.volumeId ? [`volume \`${issue.volumeId}\``] : []),
        ...(issue.hash ? [`tx ${tx(issue.hash)}`] : []),
      ];
      out.push(`- ${inline(issue.message)}${where.length ? ` — ${where.join(", ")}` : ""}`);
    }
  };
  issues("Failures", report.failures);
  issues("Warnings", report.warnings);

  if (report.volumes?.length) {
    out.push("", "### Volumes", "", "| Volume | Transaction | Outcome | Detail |", "|---|---|---|---|");
    for (const v of report.volumes) {
      const detail = v.reason ?? (v.amount !== undefined ? `${v.amount} PLUR` : "");
      out.push(
        `| \`${v.volumeId}\` | ${v.status}${v.hash ? ` ${tx(v.hash)}` : ""} | ${v.outcome ?? "—"} | ${cell(detail)} |`,
      );
    }
  }

  return `${out.join("\n")}\n`;
}

/**
 * One workflow command per failure and warning, so they show on the run page
 * without opening the log. Past GitHub's per-step cap, the last slot says how
 * many more there are rather than dropping them silently.
 */
export function annotations(report: KeeperReport): string[] {
  const title = escapeProperty(report.deployment);
  const render = (level: "error" | "warning", list: KeeperIssue[]) => {
    const messages = list.map((issue) =>
      [
        issue.message,
        ...(issue.volumeId ? [`volume ${issue.volumeId}`] : []),
        ...(issue.hash ? [`tx ${issue.hash}`] : []),
      ].join(" — "),
    );
    if (messages.length > MAX_ANNOTATIONS) {
      const shown = messages.slice(0, MAX_ANNOTATIONS - 1);
      shown.push(`… and ${messages.length - shown.length} more — see the job summary`);
      messages.splice(0, messages.length, ...shown);
    }
    return messages.map((m) => `::${level} title=${title}::${escapeData(m)}`);
  };
  return [...render("error", report.failures), ...render("warning", report.warnings)];
}

/** Workflow-command message escaping, as @actions/core does it. */
export const escapeData = (s: string): string =>
  s.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const escapeProperty = (s: string): string =>
  escapeData(s).replaceAll(":", "%3A").replaceAll(",", "%2C");

const inline = (s: string): string => s.replace(/\s*\n\s*/g, " ");
const cell = (s: string): string => inline(s).replaceAll("|", "\\|");
