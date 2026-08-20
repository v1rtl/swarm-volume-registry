# ethswarm-volume-keeper

One keeper cycle against a [Swarm](https://www.ethswarm.org/) Volume Registry: enumerate the active volumes and trigger them.

Not a registry SDK. The export surface is the cycle and the types it returns — the reads, the ABI and the batching behind it are internal, so there is no second way to drive the registry that has to be kept honest against the contract. Deployment concerns are yours too: no transports, chain table, RPC list, key handling or env parsing in here. [`workers/gas-boy`](../../workers/gas-boy) is the reference bot that supplies them.

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
| `maxIdsPerTx` | `50` | |
| `maxTxPerCycle` | `8` | overflow defers to the next cycle, noted in `warnings` |
| `gasMultiplier` | `1.2` | headroom over the estimate — load-bearing, see below |
| `confirmations` | `1` | |
| `receiptTimeout` / `cycleTimeout` | `60_000` / `120_000` | ms |
| `dryRun` | `false` | simulate everything, send nothing |

## Result

```ts
{
  ok, error?, skipped?, durationMs
  mode, blockNumber?, volumeCount
  txs: [{ volumeIds, status, hash?, blockNumber?, gasUsed?, error? }]
  toppedUp: [{ volumeId, amount }]
  retired: [{ volumeId, reason }]       // OwnerDeleted | VolumeExpired | …
  topupSkipped: [{ volumeId, reason }]  // NoAuth | PaymentFailed
  notActive, warnings
}
```

## Worth knowing

- **`runKeeperCycle` never throws.** Failures land in `ok`/`error` — throwing out of a cron handler causes retry storms.
- **Reverts decode to names.** The bundled ABI carries VolumeRegistry's full error set, so an `error` string reads `VolumeNotActive` rather than `0x2f607c28`. Against this contract they should stay quiet — batched `trigger` catches per-item reverts and the reads can't fail — so seeing one means the configured address isn't the registry you expect.
- **No client-side filtering, by construction.** Every Active volume goes into the batch; the contract tops up a real deficit, retires a dead batch, and answers `TopupSkipped` otherwise. A volume needing nothing is a silent no-op costing ~28k gas. Nothing here reads PostageStamp or `graceBlocks` — the package carries no PostageStamp ABI at all — so the keeper cannot form a second opinion that disagrees with the chain.
- **A mined `trigger` doesn't mean anything was funded.** The contract swallows per-item failures; `topupSkipped` is where it explains itself. `NoAuth` = payer revoked, `PaymentFailed` = payer out of BZZ or allowance zeroed.
- **Reads are pinned to one block.** The active index is swap-and-pop, so paging across block heights can silently skip a volume. The cycle pins its own enumeration.
- **Running short on gas fails silently.** Each id runs in a `try/catch` and an inner call gets 63/64 of the remaining gas, so an under-estimate makes inner calls OOG, get swallowed, and the transaction succeed having done nothing. Hence `gasMultiplier`, and deliberately no gas cap — a ceiling below what the batch needs would drop volumes just as quietly. Bound work with `maxIdsPerTx`; unused gas is refunded, so over-estimating is free.
- **Safe to run two keepers.** `trigger` tops up to a target, so the second computes a zero deficit. Redundancy, not double-spend.
- **Failover is yours:** `fallback([http(primary), http(secondary)], { rank: … })`. `rank` keeps a timer alive, so a one-shot script needs `process.exit()`.

Contract semantics — volume lifecycle, the owner/payer handshake, retirement edges, the `graceBlocks` guarantee — live in [`docs/DESIGN.md`](../../docs/DESIGN.md); `trigger` is specified in §8. This package assumes that contract and doesn't extend it.
