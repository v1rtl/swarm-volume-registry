# keeper

A one-shot keeper cycle, run by [`.github/workflows/keeper.yml`](../../.github/workflows/keeper.yml) on a cron schedule. An alternative runtime to the Cloudflare Worker in [`js/workers/gas-boy`](../../js/workers/gas-boy) — same [`ethswarm-volume-keeper`](../../js/packages/ethswarm-volume-keeper) library, same registry, deliberately different infrastructure, because two variants fail in different ways.

A standalone Bun project rather than a member of the `js/` workspace: it is a thing we deploy, not a thing we publish.

| | |
|---|---|
| `index.ts` | the run — probe, cycle, report, notify, exit code |
| `src/config.ts` | environment parsing, endpoint health, client construction, log scrubbing |
| `src/report.ts` | annotations and the job summary |
| `src/notify.ts` | Telegram push, on conditions the keeper knows about |

## Read this before relying on it

**GitHub's scheduler is the weakest part of this design, and it fails quietly.**

- `schedule` fires **only on the repository's default branch**. On any other branch this workflow does nothing, no matter what its cron says.
- GitHub **disables scheduled workflows after 60 days** with no repository activity. A keeper that switches itself off is the worst failure mode here, because nothing reports it.
- Scheduled runs are **frequently late** — commonly 5–15 minutes, occasionally much more — and can be **dropped entirely** under load. The advertised minimum interval is 5 minutes; the delivered interval is not.

So this variant suits a registry whose `graceBlocks` gives hours of runway, not minutes.

Concretely: **it cannot keep a Sepolia volume alive.** Sepolia's `graceBlocks` is 12 (≈ 2.4 min); a top-up buys less runway than the scheduler's ordinary jitter. It is still a good target for exercising the whole path — secrets, RPC failover, signing, receipt decoding, alerting — which is why the workflow defaults to it. Gnosis (`graceBlocks` 17280, ≈ 24 h) is the deployment an hourly cron can genuinely maintain.

## Setup

Create a [GitHub Environment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment) named `sepolia` or `gnosis` — the job selects one by name, so the testnet and mainnet keepers cannot share a key by accident.

Environment **secrets**:

| | |
|---|---|
| `PRIVATE_KEY` | The keeper EOA. Generate a fresh one (`cast wallet new`) and reuse nothing. It only pays gas: it never holds or moves BZZ and needs no registry authorization. |
| `RPC_URL` | Required — no endpoints ship here. Comma-separate several from **independent providers** to fail over between them. |
| `TELEGRAM_BOT_TOKEN` | Optional; see Alerting. |

Environment **variables**:

| | | |
|---|---|---|
| `CHAIN_ID` | required | `100` (Gnosis) or `11155111` (Sepolia) |
| `REGISTRY_ADDRESS` | required | the `VolumeRegistry` — see [`docs/usage.md`](../../docs/usage.md) §2 |
| `VOLUME_IDS` | optional | comma-separated; maintain only these instead of the whole registry |
| `MIN_BALANCE_WEI` | optional | warn below this native balance |
| `MAX_VOLUMES_PER_CYCLE` | optional | default 50; overflow defers to the next run |
| `CYCLE_TIMEOUT_MS` | optional | default 300000 — no *new* transaction starts past it |
| `FAIL_ON_WARNING` | optional | see Alerting |
| `TELEGRAM_CHAT_ID` | optional | see Alerting |

Then fund the keeper EOA with xDAI (or Sepolia ETH) and nothing else.

## Alerting

GitHub emails you when a workflow run **fails**. It does not notify on warnings, so by default a message like "keeper balance is nearly out" lands in a job summary nobody opens — precisely the signal you wanted a week before it mattered.

Two ways to close that, which compose:

- **`FAIL_ON_WARNING=true`** — any warning (low balance, an RPC failover, `TopupSkipped`, a deferred volume) exits non-zero, so you get the standard failed-run email. Noisier, but nothing important is silent.
- **`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`** — a push on the same verdict, with the failing detail and a link to the run. Unset, it is inert; it never fails a run because it could not send.

Either way, the **job summary** carries the per-volume table: every volume, its transaction status, and what the contract actually did (`topped up`, `retired`, `not funded`, `no action needed`). Failures also appear as run annotations, which show up without opening the logs.

## Differences from gas-boy

Both run `runKeeperCycle`. What changes is everything around it:

| | `gas-boy` (Worker) | `services/keeper` |
|---|---|---|
| Schedule | Cloudflare cron, punctual, down to 1 min | GitHub cron, late and skippable, default branch only |
| Process | Long-lived isolate, warm across ticks | Fresh runner every time, nothing cached |
| RPC failover | viem `fallback` with `rank`, learned over ticks | Pre-flight health probe of every endpoint, then ordered `fallback` |
| Cycle budget | Tight; `cycleTimeout` defaults to 120 s | Minutes of wall clock; defaults to 300 s under a 15 min job timeout |
| Failure signal | A log line you must go and read | Non-zero exit → red run → GitHub's email, plus optional Telegram |
| Secrets | `wrangler secret put` | Environment secrets, masked in logs |

The `rank` difference is not cosmetic. Ranking learns which endpoint is slow by sampling over time, which a process that lives for one cycle cannot do — and it schedules an interval that would hold the process open past its work. So this variant probes every endpoint once, up front, chain id included, and reports the result. That turns a silent failover into a line in the log, which is what [`docs/KEEPERS.md`](../../docs/KEEPERS.md) asks for.

RPC URLs are scrubbed to scheme and host on every output path. Redacting where *we* print a URL is not enough — viem embeds the full endpoint in its error text, and those errors travel into warnings, annotations, the JSON line and the Telegram message. On a public repository the run logs are world-readable.

## Working on it

```bash
cd js && bun install && bun run build   # the library, whose dist/ is not committed
cd ../services/keeper && bun install

bun test
bun run typecheck
```

The library is a path dependency and Bun installs it by copying, so **rerun `bun run build` in `js/` and `bun install` here after changing the library** — otherwise this project keeps using the previous build.

`viem` is pinned to an exact version that matches the `js/` workspace. It has to: `runKeeperCycle` takes a viem client, so its public types *are* viem types, and two different viem versions across the two lockfiles produce two incompatible `Client` types and a typecheck failure that has nothing to do with this code. Bump both together.

## Running one cycle locally

```bash
CHAIN_ID=11155111 \
REGISTRY_ADDRESS=0x33a53c79a08ed1f863905cd4c6ce036a4c493729 \
RPC_URL="https://…,https://…" \
PRIVATE_KEY=0x… \
DRY_RUN=true \
bun run start
```

`DRY_RUN=true` enumerates and simulates without sending, which is the safe way to validate a new environment's secrets and variables. Outside Actions the job summary is skipped and annotations are just lines on stdout; the JSON line (`kind: "keeper/cycle"`) and the exit code are the same either way.
