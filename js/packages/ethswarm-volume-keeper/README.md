# ethswarm-volume-keeper

One keeper cycle against a [Swarm](https://www.ethswarm.org/) Volume Registry: enumerate the active volumes and trigger them.

Not a registry SDK. The export surface is the cycle and the types it returns — the reads, the ABI and the send loop behind it are internal, so there is no second way to drive the registry that has to be kept honest against the contract. Deployment concerns are yours too: no transports, chain table, RPC list, key handling or env parsing in here. Two reference bots supply them: [`workers/gas-boy`](../../workers/gas-boy) (Cloudflare Worker) and [`workers/keeper-action`](../../workers/keeper-action) (GitHub Actions cron).

Targets VolumeRegistry v2 and follows the keeper conventions in [`docs/KEEPERS.md`](../../../docs/KEEPERS.md).

```bash
bun add ethswarm-volume-keeper viem   # viem is a peer dependency
```

## Usage

The client must be able to both read and write — a wallet client extended with `publicActions`.

```ts
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gnosis } from "viem/chains";
import { runKeeperCycle } from "ethswarm-volume-keeper";

const client = createWalletClient({
  account: privateKeyToAccount(process.env.PRIVATE_KEY),
  chain: gnosis,
  transport: http(process.env.RPC_URL),
}).extend(publicActions);

const result = await runKeeperCycle(client, { registry: "0x…" });
```

## Modes

```ts
mode: { type: "all" }                                  // default — the whole active index
mode: { type: "selected", volumeIds: ["0x…", "0x…"] }  // only these
```

`selected` reads each id directly. Ids that aren't `Active` volumes come back in `notActive` and are ignored; nothing else in the registry is touched.

## Options

| | Default | |
|---|---|---|
| `registry` | — | required |
| `mode` | `{ type: "all" }` | |
| `pageSize` | `100` | volumes per read page, `all` mode |
| `maxVolumesPerCycle` | `50` | overflow defers to the next cycle, noted in `warnings` |
| `gasMultiplier` | `1.2` | headroom over the estimate |
| `gasFloor` | `300_000n` | lower bound on the scaled estimate — load-bearing, see below |
| `confirmations` | `1` | |
| `receiptTimeout` / `cycleTimeout` | `60_000` / `120_000` | ms |
| `dryRun` | `false` | simulate everything, send nothing |

## Result

```ts
{
  ok, error?, skipped?, durationMs
  mode, blockNumber?, volumeCount
  volumes: [{ volumeId, status, outcome?, amount?, reason?, hash?, blockNumber?, gasUsed?, error? }]
  toppedUp: [{ volumeId, amount }]
  retired: [{ volumeId, reason }]       // OwnerDeleted | VolumeExpired | …
  topupSkipped: [{ volumeId, reason }]  // NoAuth | PaymentFailed
  noop: [volumeId]                      // needed nothing — the healthy majority
  failed: [volumeId]                    // reverted, unmined, or unconfirmed
  notActive, warnings
}
```

`status` is the transaction's fate (`success` | `reverted` | `simulated` | `failed`); `outcome` is what the contract did (`toppedUp` | `retired` | `topupSkipped` | `noop`), present on `success`.

## Worth knowing

- **One transaction per volume.** This is the v2 convention, and it costs real gas relative to `trigger(bytes32[])`. It buys the thing a keeper exists to produce: the batched overload runs each id as `try this._triggerExt(id) {} catch {}`, and an inner call gets 63/64 of the remaining gas — so a short limit makes the inner call OOG, the `catch` swallow it, and the transaction *succeed* having funded nothing. One volume per transaction means one receipt per volume, and `noop` becomes a real answer rather than an ambiguous silence. `trigger(bytes32[])` is not in the bundled ABI, so nothing here can fall back to it.
- **`runKeeperCycle` never throws.** Failures land in `ok`/`error` — throwing out of a cron handler causes retry storms. Volumes are processed sequentially and every one is attempted even after an earlier one fails; `ok` then reports the run as failed and `failed` names the volumes.
- **Sequential is a throughput ceiling.** Each volume waits for its receipt before the next is sent, which is what keeps nonces safe without this package managing them. A cycle handles roughly `cycleTimeout / confirmation time` volumes; the rest is deferred with a warning and picked up next cycle. Size the schedule against `graceBlocks` accordingly.
- **`gasFloor`, not just `gasMultiplier`.** `_triggerOne` branches on state read at execution time, so a volume that estimates as a ~28k no-op needs the full `transferFrom` → `approve` → `topUp` path if the postage price moves before inclusion. Scaling a cheap estimate doesn't cover the expensive branch; the floor does. Unused gas is refunded, so it costs nothing on the no-op path it usually lands on.
- **Reverts decode to names.** The bundled ABI carries VolumeRegistry's full error set, so an `error` string reads `VolumeNotActive` rather than `0x2f607c28`.
- **A volume can retire between enumeration and its send.** Reads are pinned to one block; if the volume retires before its transaction, estimation reverts `VolumeNotActive` and it lands in `failed` with that error. Benign and self-healing — the next cycle won't see it at all — but it is reported as a failure because the keeper cannot tell that race apart from a genuinely misconfigured id.
- **No client-side filtering, by construction.** Every Active volume is triggered; the contract tops up a real deficit, retires a dead batch, and answers `TopupSkipped` otherwise. Nothing here reads PostageStamp or `graceBlocks` — the package carries no PostageStamp ABI at all — so the keeper cannot form a second opinion that disagrees with the chain.
- **`TopupSkipped` is a warning, not a failure.** `NoAuth` = payer revoked, `PaymentFailed` = payer out of BZZ or allowance zeroed. Only the user or payer can fix either, so the cycle stays `ok` and says so in `warnings`.
- **Reads are pinned to one block.** The active index is swap-and-pop, so paging across block heights can silently skip a volume. The cycle pins its own enumeration.
- **Safe to run two keepers.** `trigger` tops up to a target, so the second computes a zero deficit. Redundancy, not double-spend.
- **Failover is yours:** `fallback([http(primary), http(secondary)], { rank: … })`. `rank` keeps a timer alive, so a one-shot script needs `process.exit()`.

Contract semantics — volume lifecycle, the owner/payer handshake, retirement edges, the `graceBlocks` guarantee — live in [`docs/DESIGN.md`](../../../docs/DESIGN.md); `trigger` is specified in §8. Operational guidance for running a keeper is in [`docs/KEEPERS.md`](../../../docs/KEEPERS.md). This package assumes that contract and doesn't extend it.
