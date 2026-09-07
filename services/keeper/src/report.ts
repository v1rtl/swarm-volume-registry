import { appendFile } from "node:fs/promises";
import type { Hex } from "viem";

/**
 * Everything this process says to GitHub Actions.
 *
 * Two surfaces, and they are not interchangeable. **Annotations** appear on the
 * run page and in the commit timeline without anyone opening the logs — that is
 * where a failure has to land. The **job summary** is a markdown report on the
 * run page, which is where the per-volume detail belongs.
 *
 * Both go through `scrub`, because most of what gets reported here is viem's
 * words rather than ours, and viem names the RPC endpoint it used.
 */
export class Report {
  readonly #scrub: (text: string) => string;
  readonly #lines: string[] = [];

  constructor(scrub: (text: string) => string) {
    this.#scrub = scrub;
  }

  /** Workflow commands take their payload percent-encoded, not backslash-escaped. */
  static #escape(s: string): string {
    return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  }

  annotate(level: "error" | "warning" | "notice", message: string): void {
    console.log(`::${level}::${Report.#escape(this.#scrub(message))}`);
  }

  /** Append a line to the job summary. No argument writes a blank line. */
  line(text = ""): void {
    this.#lines.push(this.#scrub(text));
  }

  /** A markdown table, written in one go so the header can never drift. */
  table(headers: string[], rows: string[][]): void {
    this.line(`| ${headers.join(" | ")} |`);
    this.line(`|${headers.map(() => "---").join("|")}|`);
    for (const row of rows) this.line(`| ${row.join(" | ")} |`);
    this.line();
  }

  /** One machine-readable line, so the raw log stays greppable. */
  json(payload: unknown): void {
    console.log(
      this.#scrub(
        JSON.stringify(payload, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ),
    );
  }

  /**
   * Flush the summary to `$GITHUB_STEP_SUMMARY`.
   *
   * Outside Actions the variable is unset and this is a no-op — the annotations
   * and the JSON line still go to stdout, so a local run reports the same
   * things. A summary that cannot be written must never fail the keeper run.
   */
  async flush(): Promise<void> {
    const path = process.env.GITHUB_STEP_SUMMARY;
    if (!path || this.#lines.length === 0) return;
    try {
      await appendFile(path, `${this.#lines.join("\n")}\n`);
    } catch (err) {
      console.log(
        `could not write step summary: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

/** `0x1234abcd…9f0e` — long enough to identify, short enough for a table cell. */
export const short = (id: Hex): string => `${id.slice(0, 10)}…${id.slice(-6)}`;

/** What the contract did, in words an operator reads rather than field names. */
export const OUTCOME_LABEL: Record<string, string> = {
  toppedUp: "topped up",
  retired: "retired",
  topupSkipped: "not funded",
  noop: "no action needed",
};
