/** Entry point for `.github/workflows/keeper-run.yml` — see ./run.ts. */
import { appendFileSync } from "node:fs";
import { runInActions } from "./run.js";

const summaryPath = process.env.GITHUB_STEP_SUMMARY;

process.exitCode = await runInActions(process.env, {
  write: (line) => process.stdout.write(`${line}\n`),
  ...(summaryPath ? { summary: (markdown) => appendFileSync(summaryPath, markdown) } : {}),
});
