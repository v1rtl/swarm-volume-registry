# Contracts

This directory is the Foundry project for `VolumeRegistry`.

## Deploying

Deployments use an explicitly selected constructor-input profile from
[`deployments.toml`](./deployments.toml). Each profile specifies the target chain ID,
`PostageStamp` and BZZ addresses, and `grace_blocks`. The launcher checks that the RPC
chain ID matches the selected profile before running the Foundry script.

Prerequisites:

- Python 3.11 or newer.
- Foundry 1.7.1 or newer.
- An RPC URL for the target chain.
- For a broadcast, a funded account in Foundry's encrypted keystore.

Import a deployment account if necessary:

```sh
cast wallet import volume-registry-deployer
```

From this directory, simulate a deployment without sending a transaction:

```sh
python3 script/deploy.py sepolia-postage-v0.9.4 \
    --rpc-url "$RPC_URL"
```

To deploy, select the named keystore account and add `--broadcast`:

```sh
python3 script/deploy.py sepolia-postage-v0.9.4 \
    --rpc-url "$RPC_URL" \
    --account volume-registry-deployer \
    --broadcast
```

Foundry prompts for the account password. The launcher passes the selected profile's
constructor arguments to `script/DeployVolumeRegistry.s.sol` and lets Foundry derive
the sender from the named account.

## Deployment artifacts

Foundry writes broadcast records beneath:

```text
broadcast/DeployVolumeRegistry.s.sol/<chain-id>/
```

A broadcast creates a timestamped `run-<timestamp>.json` and updates
`run-latest.json`. These production broadcast records are intended to be committed.

Simulations write the equivalent files beneath:

```text
broadcast/DeployVolumeRegistry.s.sol/<chain-id>/dry-run/
```

Foundry also writes matching execution caches beneath
`cache/DeployVolumeRegistry.s.sol/<chain-id>/`. Dry-run records and all cache files are
ignored by Git.
