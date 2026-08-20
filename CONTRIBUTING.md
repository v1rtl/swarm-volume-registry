# Contributing

## Prerequisites

- [Foundry](https://book.getfoundry.sh/) v1.7.1 (`forge`, `cast`, `anvil`).
- Git submodules initialised:
  ```sh
  git submodule update --init --recursive
  ```

## Build & test

From `contracts/`:

```sh
forge build
forge test
```

Fork tests against a live chain. Configured via env vars; silently
skipped when `FORK_POSTAGE_STAMP` is unset or has no code at the
configured address.

```sh
FORK_POSTAGE_STAMP=0x... FORK_BZZ=0x... \
    forge test --fork-url $RPC_URL \
    --match-path test/fork/ForkRegistry.t.sol
```

See [`contracts/test/README.md`](./contracts/test/README.md#fork-tests)
for the full env-var list (`FORK_MULTICALL3`, `FORK_GRACE_BLOCKS`) and
[`docs/usage.md`](./docs/usage.md) §2 for current addresses per chain.

See [`contracts/test/README.md`](./contracts/test/README.md) for the
testing strategy, how each section of `DESIGN.md` maps to test files,
and the file-level breakdown of the example, invariant, and fork
suites.

Format check (also enforced in CI):

```sh
forge fmt --check
```

## Deploy

Select a named constructor-input profile from
[`contracts/deployments.toml`](./contracts/deployments.toml). Profiles are independent
of chain IDs, so the file can hold multiple relevant `PostageStamp` deployments on the
same chain. The launcher verifies that the selected profile's chain ID matches the RPC.

```sh
python3 script/deploy.py sepolia-postage-v0.9.4 \
    --rpc-url "$RPC_URL" \
    --account swarm-volume-registry-deployer \
    --broadcast
```

The account must already exist in Foundry's encrypted keystore. Foundry 1.7.1 or newer
automatically uses the single named account as the script sender; the launcher rejects
older versions that require a duplicate `--sender` argument.

The configured `grace_blocks` must be at least
`PostageStamp.minimumValidityBlocks()` on the target chain or the constructor reverts.
See [`docs/DESIGN.md`](./docs/DESIGN.md) §10 for semantics and §10.1 for the survival
bound the value implies.

## Dependencies

- [`forge-std`](https://github.com/foundry-rs/forge-std) — Foundry stdlib.
- [`ethersphere/storage-incentives`](https://github.com/ethersphere/storage-incentives), pinned to the tag of the live `PostageStamp` deployment (currently `v0.9.4`). Tests import `PostageStamp`, `PriceOracle`, and `TestToken` from this submodule so the suite runs against real bytecode rather than mocks.
- [`OpenZeppelin/openzeppelin-contracts`](https://github.com/OpenZeppelin/openzeppelin-contracts), pinned to `v4.8.2`. `VolumeRegistry` itself does not depend on OpenZeppelin, but `storage-incentives` is a Hardhat project that imports `@openzeppelin/contracts/...` and resolves it from `node_modules/` at its own build time. When `forge` compiles those same sources here, it has no npm awareness, so the dependency must be supplied as a submodule with a matching remapping in `remappings.txt`. The pin tracks `storage-incentives@v0.9.4`'s `package.json`; bump it together with `storage-incentives` whenever a new PostageStamp deployment lands.

## Keeper package

`js/packages/ethswarm-volume-keeper` (the keeper cycle) and `js/workers/gas-boy`
(the reference Cloudflare Worker) form a Bun workspace rooted at `js/`.

```sh
cd js
bun install
bun run typecheck
bun test packages/
bun run build          # tsc → packages/ethswarm-volume-keeper/dist
```

The worker imports the package's `dist/`, so its scripts build the package
first. It needs no chain access to typecheck; `bun run dev` in
`js/workers/gas-boy` starts `wrangler dev` against `.dev.vars` (see
`.dev.vars.example`).

The package is deliberately free of transports, chain definitions, RPC
endpoints, key handling and environment parsing — actions take a viem client
the caller supplies. Those concerns belong in a bot, e.g. `js/workers/gas-boy`.
