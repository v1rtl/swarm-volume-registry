# keeper-action

A one-shot keeper cycle driven by [`.github/workflows/keeper.yml`](../../../.github/workflows/keeper.yml), as an alternative runtime to the Cloudflare Worker in [`gas-boy`](../gas-boy). Same [`ethswarm-volume-keeper`](../../packages/ethswarm-volume-keeper) library, same registry, deliberately different infrastructure — two variants fail in different ways, which is the point of running both.

`src/config.ts` reads the environment and builds the client; `src/main.ts` runs one cycle, writes a job summary, raises annotations and exits non-zero if anything failed.

## Read this before relying on it

**GitHub's scheduler is the weakest part of this design, and it fails quietly.**

- `schedule` fires **only on the repository's default branch**. On any other branch this workflow does nothing, no matter what its cron says.
- GitHub **disables scheduled workflows after 60 days** with no repository activity. A keeper that switches itself off is the worst failure mode here, because nothing reports it.
- Scheduled runs are **frequently late** — commonly 5–15 minutes, occasionally much more — and can be **dropped entirely** under load. The advertised minimum interval is 5 minutes; the delivered interval is not.

So this variant suits a registry whose `graceBlocks` gives hours of runway, not minutes.

Concretely: **it cannot keep a Sepolia volume alive.** Sepolia's `graceBlocks` is 12 (≈ 2.4 min); a top-up buys less runway than the scheduler's typical jitter. It is still a perfectly good target for exercising the whole path — secrets, RPC failover, signing, receipt decoding, alerting — which is why the workflow defaults to it. Gnosis (`graceBlocks` 17280, ≈ 24 h) is the deployment an hourly cron can genuinely maintain.

## Setup

Create a [GitHub Environment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment) named `sepolia` or `gnosis` — the job selects one by name, so the testnet and mainnet keepers cannot share a key by accident.

Environment **secrets**:

| | |
|---|---|
| `PRIVATE_KEY` | The keeper EOA. Generate a fresh one (`cast wallet new`) and reuse nothing. It only pays gas: it never holds or moves BZZ and needs no registry authorization. |
| `RPC_URL` | Required — no endpoints ship here. Comma-separate several from **independent providers** to fail over between them. |

Environment **variables**:

| | | |
|---|---|---|
| `CHAIN_ID` | required | `100` (Gnosis) or `11155111` (Sepolia) |
| `REGISTRY_ADDRESS` | required | the `VolumeRegistry` — see [`docs/usage.md`](../../../docs/usage.md) §2 |
| `VOLUME_IDS` | optional | comma-separated; maintain only these instead of the whole registry |
| `MIN_BALANCE_WEI` | optional | warn below this native balance |
| `MAX_VOLUMES_PER_CYCLE` | optional | default 50; overflow defers to the next run |
| `CYCLE_TIMEOUT_MS` | optional | default 300000 — no *new* transaction starts past it |
| `FAIL_ON_WARNING` | optional | see below |
| `TELEGRAM_CHAT_ID` | optional | with a `TELEGRAM_BOT_TOKEN` secret, pings on failure |

Then fund the keeper EOA with xDAI (or Sepolia ETH) and nothing else.

## Alerting

GitHub emails you when a workflow run **fails**. It does not notify on warnings, so by default a message like "keeper balance is nearly out" lands in a job summary nobody opens — precisely the signal you wanted a week before it mattered.

Two ways to close that:

- Set `FAIL_ON_WARNING=true`. Any warning — low balance, an RPC failover, `TopupSkipped`, a deferred volume — exits non-zero and you get the standard failed-run email. Noisier, but nothing important is silent.
- Set a `TELEGRAM_BOT_TOKEN` secret and `TELEGRAM_CHAT_ID` variable. The workflow's last step pings on failure, and combines with `FAIL_ON_WARNING` to cover warnings too.

Either way, check the **job summary** for the per-volume table: every volume, its transaction status, and what the contract actually did (`topped up`, `retired`, `not funded`, `no action needed`). Failures also appear as run annotations.

## Differences from gas-boy

Both run `runKeeperCycle`. What changes is everything around it:

| | `gas-boy` (Worker) | `keeper-action` |
|---|---|---|
| Schedule | Cloudflare cron, punctual, down to 1 min | GitHub cron, late and skippable, default branch only |
| Process | Long-lived isolate, warm across ticks | Fresh runner every time, nothing cached |
| RPC failover | viem `fallback` with `rank`, learned over ticks | Pre-flight health probe of every endpoint, then ordered `fallback` |
| Cycle budget | Tight; `cycleTimeout` defaults to 120 s | Minutes of wall clock; defaults to 300 s under a 15 min job timeout |
| Failure signal | A log line you must go and read | Non-zero exit → red run → GitHub's own email |
| Secrets | `wrangler secret put` | Environment secrets, masked in logs |

The `rank` difference is not cosmetic. Ranking learns which endpoint is slow by sampling over time, which a process that lives for one cycle cannot do — and it schedules an interval that would hold the process open past its work. So this variant probes every endpoint once, up front, and reports the result. That turns a silent failover into a line in the log, which is what [`docs/KEEPERS.md`](../../../docs/KEEPERS.md) asks for.

RPC URLs are redacted to scheme and host wherever they are printed. The path usually *is* the API key, and on a public repository the run logs are world-readable.

## Running it locally

```bash
cd js/workers/keeper-action

CHAIN_ID=11155111 \
REGISTRY_ADDRESS=0x33a53c79a08ed1f863905cd4c6ce036a4c493729 \
RPC_URL="https://…,https://…" \
PRIVATE_KEY=0x… \
DRY_RUN=true \
bun run start
```

`DRY_RUN=true` enumerates and simulates without sending, which is the safe way to validate a new environment's secrets and variables. Outside Actions the job summary is skipped and the annotations are just lines on stdout; the JSON line (`kind: "keeper-action/cycle"`) is the same either way. The exit code is the run's verdict in both places.
