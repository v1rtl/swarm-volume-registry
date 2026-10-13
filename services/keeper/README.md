# keeper

The Swarm `VolumeRegistry` keeper: one Cloudflare Worker, deployed once per chain. Each scheduled run enumerates the registry's active volumes, sends `trigger(bytes32)` for each — one transaction per volume, per [`docs/KEEPERS.md`](../../docs/KEEPERS.md) — and reports what the contract did.

Each deployment runs on exactly one platform: its Cloudflare Cron Trigger (the default), or a scheduled GitHub Actions job running the same code — see [Running on GitHub Actions](#running-on-github-actions). The repository variable `KEEPER_PLATFORM_<ENV>` (`cloudflare` or `github`) says which.

| Deployment | Worker | Chain | Registry | Schedule |
|---|---|---|---|---|
| `sepolia` | `keeper-sepolia` | Sepolia (11155111) | v2-rc2 `0x00f72ee2…3c5a4177` | every 10 minutes (Cloudflare only) |
| `gnosis` | `keeper-gnosis` | Gnosis (100) | v1 `0x9639ae4c…ddd02aad` | hourly (Cloudflare `:00`, or GitHub `:17`) |

Both are envs in [`wrangler.jsonc`](./wrangler.jsonc), with independent wallets and RPC credentials, and that file is their configuration on either platform. They may share one Telegram group; every alert names its deployment, chain and registry.

## Layout

| | |
|---|---|
| `src/index.ts` | `scheduled()` and `GET /health` |
| `src/config.ts` | validates the Worker's bindings into a config, reporting every problem at once |
| `src/client.ts` | supported chains, the per-run RPC probe, the viem client |
| `src/keeper/` | the keeper cycle: enumerate at a pinned block, trigger each volume, decode each receipt |
| `src/reporting.ts` | the one structured report per run that logs and alerts are both rendered from |
| `src/notifications/telegram.ts` | formats that report for Telegram and sends it |
| `src/gha/` | the GitHub Actions runner: reads a deployment from `wrangler.jsonc`, masks its secrets, runs it, writes the job summary |
| `src/schedule.ts` | cron intervals and the run budget, shared by both platforms' checks |

## What a run reports

Every run writes one JSON object to Workers Logs (`kind: "keeper/run"`) at the level matching its `status`:

- **`failure`** (`console.error`) — invalid configuration, no usable RPC endpoint, the registry unreadable, or any volume whose transaction failed, reverted, or went unconfirmed within `RECEIPT_TIMEOUT_MS`. One failed volume does not stop the rest being attempted. The invocation itself then fails, so Cron Events shows it too.
- **`warning`** (`console.warn`) — a failover to a secondary RPC, the wallet below `MIN_BALANCE_WEI`, a `TopupSkipped` (`NoAuth`: payer revoked; `PaymentFailed`: out of BZZ or allowance), a retirement, deferred work, or dry-run mode.
- **`ok`** (`console.log`).

`failures` and `warnings` each list `{ message, volumeId?, hash? }`; `volumes` has the per-volume detail, including the healthy `noop`s. In the Workers Logs query builder, filter on `status` or `deployment`.

Failures and warnings go to Telegram in both deployments. `NOTIFY_WARNINGS` remains configurable, but defaults to `true` so skipped top-ups, retirements and RPC failovers are visible.

A failed run is not retried by the platform (`noRetry()`): the next tick is the retry, and an overlapping one would race the same wallet's nonce. `trigger` is idempotent, so nothing is lost by waiting.

RPC URLs are reduced to scheme and host, and the bot token and private key are masked, everywhere a report goes — viem puts the full endpoint URL in its error text.

## Configuration

Secrets, per deployment — never shared between them:

| | |
|---|---|
| `PRIVATE_KEY` | The keeper wallet. Generate a fresh one (`cast wallet new`). It only pays gas: fund it with Sepolia ETH or xDAI and nothing else. |
| `RPC_URL` | Comma-separated, from independent providers. Probed every run — chain id included — and tried in order. |
| `TELEGRAM_BOT_TOKEN` | From @BotFather. |
| `TELEGRAM_CHAT_ID` | Numeric user or private-group chat ID. Both deployments may post to the same group, but store it independently. |

Declared in `secrets.required`, so `wrangler deploy` refuses to ship a deployment with any of them unset. The Worker validates their shape too: a key or URL set to the wrong thing fails the run and alerts, rather than passing for an idle keeper.

Variables, in `wrangler.jsonc` per env: `DEPLOYMENT_NAME`, `CHAIN_ID`, `REGISTRY_ADDRESS`, `NOTIFY_WARNINGS`, `MIN_BALANCE_WEI` (0 disables the warning), and the cycle limits `MAX_VOLUMES_PER_CYCLE`, `CYCLE_TIMEOUT_MS`, `RECEIPT_TIMEOUT_MS`, `CONFIRMATIONS`. Not set by either deployment, but accepted: `DRY_RUN`, `VOLUME_IDS` (maintain only these), `PAGE_SIZE`.

**A run must fit inside its cron interval**, so two runs never share the wallet at once: 5 s of RPC probing, plus `CYCLE_TIMEOUT_MS` (no new transaction starts after it), plus `RECEIPT_TIMEOUT_MS` for the last one, plus 5 s of slack. `test/config.test.ts` holds each env to that, and to the 15-minute Cron Trigger limit. On Sepolia that is about 35 volumes per run at 12 s blocks, capped at 30. Volumes are sent one at a time, so a run reaches roughly `CYCLE_TIMEOUT_MS / block time` of them. The rest are deferred, with a warning, and each run starts at a different point in the list so the same volumes are not deferred every time. If the active set outgrows that, raise the budget.

Every RPC request counts against the platform's per-invocation subrequest cap: 50 on Workers Free, 10,000 on Workers Paid. A run spends about 20 on fixed work (probing each endpoint twice, enumeration, nonce and fees once per cycle, the balance check, the alert), then several per volume: its gas estimate, its send, and the receipt wait. On Workers Free, runs reached about 3 volumes, whatever `CYCLE_TIMEOUT_MS` allowed.

## Setting up a deployment

Needs Workers Paid: a run signs and sends transactions, which the Free plan's 10 ms CPU and 50 subrequests per invocation do not cover.

### Initial worker deployment

A new Worker cannot take `wrangler secret put` before it exists, and `secrets.required` blocks deploying without them — so the first deploy carries secrets inline:

```bash
cd services/keeper && bun install
printf 'PRIVATE_KEY=0x…\nRPC_URL=https://…,https://…\nTELEGRAM_BOT_TOKEN=…\nTELEGRAM_CHAT_ID=-100…\n' > .secrets.sepolia
bunx wrangler deploy --env sepolia --secrets-file .secrets.sepolia
rm .secrets.sepolia
```

Then fund the wallet:

```bash
curl https://keeper-sepolia.<subdomain>.workers.dev/health
```

`GET /health` returns the wallet address to fund (and `503` with every validation problem if the configuration is invalid, without making RPC calls). Fund it with Sepolia ETH or xDAI — it pays gas only, never holds BZZ.

Finally, configure CI for all later deploys (so you never deploy from a laptop again): in repository settings create Environments `sepolia` and `gnosis` (give `gnosis` required reviewers), add repository/Environment secret `CLOUDFLARE_API_TOKEN` (from the *Edit Cloudflare Workers* token template) and variable `CLOUDFLARE_ACCOUNT_ID`. From then on every `push` to `main` auto-deploys `keeper-sepolia`; `keeper-gnosis` deploys only by manual `workflow_dispatch` of `keeper-deploy`.

### Worker code update

1. Edit `services/keeper/src/**` (cycle logic lives in `src/keeper/`, Worker wiring in `src/index.ts`/`src/config.ts`/`src/client.ts`/`src/reporting.ts`).
2. Verify locally:

   ```bash
   bun install
   bun test               # includes whole scheduled runs against mock-chain
   bun run typecheck
   bun run check:deploy   # wrangler deploy --dry-run for both envs
   ```

   If you changed `wrangler.jsonc`, run `bun run types` and commit the regenerated `worker-configuration.d.ts` (CI fails if stale).

3. Push to a branch — `keeper-ci.yml` runs install/typecheck/test/dry-run for both `sepolia` and `gnosis` envs (and `keeper-deploy.yml` never runs a keeper cycle — it only deploys). A deployment on GitHub Actions picks up the change from `main` at its next scheduled run; there is nothing to deploy.
4. Push/merge to `main` auto-deploys `keeper-sepolia` via `keeper-deploy.yml`. Deploy `keeper-gnosis` by manual `workflow_dispatch` (choose `gnosis` under *Run workflow*), after Environment required reviewers approve. Or deploy by hand:

   ```bash
   bunx wrangler deploy --env sepolia
   bunx wrangler deploy --env gnosis   # after manual approval
   ```

### Secret rotation

Secrets are never in `wrangler.jsonc` or git — they live in Cloudflare Workers Secrets per env (`secrets.required: PRIVATE_KEY, RPC_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID`).

Rotate one value without redeploying code:

```bash
# single value
bunx wrangler secret put PRIVATE_KEY --env sepolia
bunx wrangler secret put RPC_URL --env sepolia          # comma-separated, independent providers
bunx wrangler secret put TELEGRAM_BOT_TOKEN --env gnosis
bunx wrangler secret put TELEGRAM_CHAT_ID --env gnosis

# or atomically via file (avoids typing a key into shell history)
printf 'PRIVATE_KEY=0x…\nRPC_URL=https://…,https://…\nTELEGRAM_BOT_TOKEN=…\nTELEGRAM_CHAT_ID=-100…\n' > .secrets.sepolia
bunx wrangler deploy --env sepolia --secrets-file .secrets.sepolia
rm .secrets.sepolia
```

Validate immediately:

```bash
curl https://keeper-sepolia.<subdomain>.workers.dev/health   # 200 + wallet if ok, 503 with every problem if not
bunx wrangler tail --env sepolia   # then force a cycle: curl "localhost:8787/cdn-cgi/local/scheduled?format=json" in dev, or wait one cron tick
```

Notes:

* `wrangler deploy` refuses if any `secrets.required` entry is missing; the Worker itself re-validates shape (e.g. `PRIVATE_KEY` is `0x`-hex, `RPC_URL` parses) and **fails the run and alerts** rather than reporting `ok` with no work — a bad rotation is never silent.
* `HEALTH` is unauthenticated and reveals only the wallet address, not secret values.
* Keep `PRIVATE_KEY` per deployment (Sepolia vs Gnosis keys never shared). `TELEGRAM_CHAT_ID` is also a per-deployment secret, even when both deployments post to the same group.
* After rotation, the next cron tick uses the new value; no Workers restart needed. Old secrets are overwritten in place — delete the local `.secrets.*` file after.

## Running on GitHub Actions

[`keeper-run.yml`](../../.github/workflows/keeper-run.yml) runs one keeper cycle per job: `src/gha/main.ts` reads the deployment's env from `wrangler.jsonc` (by wrangler itself, so the platforms cannot drift), takes only the secrets from the job, and calls the Worker's own `runScheduled`. The run is logged and alerted on exactly as on Cloudflare, and additionally:

- **Failure is the exit code**, so a failed run is a red job and GitHub's own failure email fires alongside Telegram.
- Failures and warnings become annotations on the run, and the **job summary** has the per-volume table, with explorer links.
- Telegram alerts link to the run.

### What the scheduler can and cannot do

GitHub's scheduler is the weak part, and it fails quietly:

- `schedule` fires **only on the default branch**.
- Runs are routinely **5–15 minutes late**, occasionally dropped. The minimum interval is 5 minutes.
- In a public repository, scheduled workflows are **disabled after 60 days without repository activity**.

So only **Gnosis** is ever scheduled here: hourly, at `:17` (`:00` is the most delayed slot), against ~24 h of `graceBlocks`. **Sepolia cannot be maintained this way** — its `graceBlocks` (~2.4 min) is shorter than the scheduler's ordinary delay — so it stays on Cloudflare, and `keeper-run` only dispatches it by hand to exercise the path.

**Set `HEARTBEAT_URL`.** Telegram cannot say that nothing ran. The runner requests `HEARTBEAT_URL` after every run that maintained its volumes — not a failed run, not a dry run — so a dead-man's-switch service (e.g. [healthchecks.io](https://healthchecks.io) with a 1 h period and ~1 h grace) alerts when the schedule stops firing *or* keeps failing. If the workflow was disabled for inactivity, re-enable it with `gh workflow enable keeper-run.yml`.

### Setup

In repository settings, create Environment **`keeper-<env>`** (`keeper-gnosis`, `keeper-sepolia`) — distinct from the `sepolia`/`gnosis` deploy environments:

- *Deployment branches*: selected, `main` only — so no other branch can run with the key.
- **No required reviewers** — a reviewer gate would hold every scheduled run.
- Secrets: `PRIVATE_KEY`, `RPC_URL` (as for the Worker, above), and optionally `HEARTBEAT_URL`.

`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are **repository** secrets, shared by both deployments since they post to one group; an Environment secret of the same name overrides one for its deployment. Keep `TELEGRAM_CHAT_ID` a *secret*, not a variable: the workflow reads only `secrets.*`, and a step's variables are printed in clear at the top of its public log.

Run logs of this public repository are world-readable. GitHub masks a secret only as the whole stored string, so the runner masks each `RPC_URL` entry, the key with and without `0x`, the token's secret half and `HEARTBEAT_URL` before anything runs; the report scrubber stays behind that.

Then dispatch **keeper-run** (*Run workflow*, choose the deployment). `dry_run` defaults to on. A real run against a deployment that still runs on Cloudflare is only safe with a **different wallet** from the Worker's — the run warns about it.

### Moving `keeper-gnosis` to GitHub Actions

1. Create `keeper-gnosis` as above. Reuse the Worker's funded `PRIVATE_KEY`, or use a fresh key and fund it.
2. Dispatch `keeper-run` for `gnosis` with `dry_run` on. Check the summary: right registry, wallet and balance, every endpoint healthy.
3. Stop the Worker: `bunx wrangler delete --env gnosis` (or remove its Cron Trigger in the dashboard). This also deletes its Cloudflare secrets — make sure the key is stored in the Environment first.
4. Set the **repository** variable `KEEPER_PLATFORM_GNOSIS=github` (the job's `if` cannot see Environment variables). From now on `keeper-run` schedules it, and `keeper-deploy` refuses to recreate the Worker.
5. Watch the next run at `:17` and the heartbeat.

Stop the Worker *before* setting the variable: the gap is at most an hour against ~24 h of runway, whereas two schedulers on one wallet race for its nonce.

To move back: set `KEEPER_PLATFORM_GNOSIS=cloudflare` (or delete it) so `keeper-run` stops scheduling, then recreate the Worker with the [initial deployment](#initial-worker-deployment) steps.

## Working on it

```bash
bun install
bun test               # includes whole scheduled runs against a mock chain
bun run typecheck
bun run check:deploy   # bundles both envs, as CI does
```

After changing `wrangler.jsonc`, run `bun run types` and commit `worker-configuration.d.ts`; CI fails if it is stale.

To run it locally against a real chain, put the four secrets in `.dev.vars` (see `.dev.vars.example`), then:

```bash
bun run dev --var DRY_RUN:true          # wrangler dev --env sepolia
curl "localhost:8787/cdn-cgi/local/scheduled?format=json"
```

`DRY_RUN` simulates each trigger and sends nothing — the safe way to check a new deployment's RPC and registry. Only `secrets.required` names are read from `.dev.vars`; override anything else with `--var NAME:value`.

The GitHub Actions runner runs locally too, with the secrets in the environment:

```bash
KEEPER_ENV=sepolia DRY_RUN=true PRIVATE_KEY=0x… RPC_URL=https://… \
  TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… bun run start:gha
```
