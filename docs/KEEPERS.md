# Running a keeper

A keeper is an off-chain job that periodically calls `trigger()` to maintain one or
more volumes. Calling `trigger()` is permissionless: the keeper needs no authorization
from the volume owner and pays only transaction gas. BZZ top-ups are drawn separately
from the volume's configured payer.

Users should run their own keeper, or arrange for one they trust. Any keeper operated
by the registry project is altruistic and best-effort.

## Required resources

A keeper needs:

- The target chain ID and `VolumeRegistry` address.
- The volume IDs it is responsible for.
- At least one RPC endpoint, preferably several from independent providers.
- A transaction-signing wallet funded with the chain's native gas token.
- A scheduler or other way to run periodically.
- Somewhere to send failure and warning signals, such as logs or an alerting service.

The keeper wallet should be dedicated to this purpose. It does not need BZZ, registry
authorization, or ownership of the volumes.

The volume payer separately needs sufficient BZZ and allowance for the registry. A
keeper cannot compensate for missing payer authorization, allowance, or funds.

## Calling the contract

For v2, call `trigger(bytes32)` separately for each volume.

Do not use `trigger(bytes32[])` in a v2 keeper. Its gas accounting and per-item error
handling make failures difficult to detect reliably. This interface is expected to
improve in v3.

Process every configured volume even if an earlier volume fails, but report the overall
keeper run as failed and identify which volumes were affected.

## Scheduling

Run the keeper substantially more frequently than the runway represented by the
registry's `graceBlocks`.

Do not treat `graceBlocks × expected block time` as a precise operational deadline.
Block production, transaction inclusion, gas prices, RPC availability, and the postage
price can all vary. Leave enough margin for multiple missed runs and delayed
transactions.

Prevent overlapping invocations when they share a wallet, unless the implementation
deliberately supports concurrent nonce management.

## Deployment approaches

The keeper is stateless apart from its configuration and list of volume IDs. It does
not need a database.

Two common deployment approaches are:

- A scheduled serverless function on a cloud platform. Store the signing key and RPC
  credentials using the platform's secret-management system, and route each
  invocation's output to its logging or alerting service. Check the platform's
  execution-time limits and cron frequency.
- A cronjob or systemd timer on an always-on home server or VPS. Store the key with
  restricted filesystem permissions and arrange for failed jobs and warnings to reach
  a log, email address, or monitoring service.

Other deployment models are possible. Reliability depends more on scheduling, RPC
selection, wallet funding, and monitoring than on the particular runtime.

## RPC reliability

RPC failure is not limited to a connection being refused. An endpoint may be stale,
rate-limited, internally inconsistent, unable to estimate gas correctly, or accept a
transaction without propagating it successfully.

Use RPC endpoints from multiple independent providers. Failover should be simple and
observable; code cannot reliably classify every possible form of bad RPC behavior.

In particular:

- Verify that the RPC reports the expected chain ID.
- Wait for a transaction receipt rather than treating submission as success.
- Retain transaction hashes so uncertain submissions can be checked through another
  endpoint.
- Avoid blindly resubmitting an uncertain transaction with a new nonce.
- Emit a warning whenever a fallback RPC was required.
- Fail the keeper run when no configured endpoint can complete the operation.
- Use enough confirmations for the deployment's risk tolerance.

Endpoints operated by the same provider may share infrastructure and failure modes.

## Keeper wallet funding

Monitor the keeper wallet's native-token balance and warn well before it reaches zero.
A scheduled job can continue starting normally while being unable to submit any
transactions.

Choose the warning threshold using:

- The expected gas used per volume.
- The number of volumes maintained.
- The keeper frequency.
- Current and unusually high base fees.
- The desired time available to replenish the wallet.

It can also be useful to warn when the current base fee is substantially higher than
the keeper normally sees.

If wallet funding is automated, secure the funding mechanism separately and limit the
amount it can expose. Replenishing a dedicated keeper wallet manually may be preferable
for small deployments.

## Outcomes

Keeper calls may produce:

- `Toppedup`: BZZ was added to the postage batch.
- `VolumeRetired`: the volume no longer exists.
- `TopupSkipped`: the volume still exists, but no payment was made.

`TopupSkipped` can indicate that the owner's account is no longer active or that
payment failed because of payer balance, allowance, or token behavior. These conditions
require action by the user or payer, not the keeper.

Record the transaction hash and decoded outcome for each volume. Repeated skips should
produce a warning or alert.

A healthy volume may need no top-up and emit no event. A confirmed, successful
single-volume transaction is still a successful keeper operation in that case.

## Failure and warning signals

Each scheduled invocation should produce a clear machine-readable or human-readable
result that the scheduler can route to logs or alerts.

Treat at least the following as failures:

- Invalid configuration.
- Unexpected chain ID or registry address.
- Inability to connect to any RPC.
- Failure to sign or submit a transaction.
- Insufficient gas funds.
- A reverted transaction.
- A transaction that does not receive a receipt within the configured timeout.

Useful warnings include:

- Keeper wallet balance below its configured threshold.
- Base fee substantially above its expected range.
- Primary RPC failure or frequent failover.
- Slow transaction confirmation.
- `TopupSkipped`.
- A volume that has disappeared.

Do not catch these conditions and then report a successful cron invocation. If several
volumes are processed in one run, report partial results while ensuring the run itself
indicates that at least one operation failed.

Monitoring should answer "did the latest scheduled keeper run maintain its volumes?"
rather than merely "is a process running?"

## Testing on Sepolia

Test keeper deployments against the Sepolia `VolumeRegistry` before relying on them
elsewhere.

Sepolia ETH for the keeper wallet is available from the
[Google Cloud Web3 Faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia)
and may also be available from the user's RPC provider.

Creating and topping up a real volume also requires Sepolia BZZ (sBZZ). There is no
sBZZ faucet. The practical way to obtain sBZZ is currently to ask in the
[official Swarm Discord](https://docs.ethswarm.org/docs/references/faq/).

There is a small
[sBZZ/WETH Uniswap v3 pool on Sepolia](https://sepolia.etherscan.io/address/0x88A3f8097f091f457a3bf22e9BECAbCbE873eC1b),
but it lacks convenient frontend support and its liquidity is not guaranteed. Treat it
as an advanced fallback rather than part of the normal testing procedure.

Without sBZZ, some operational behavior can still be tested:

- Incorrect chain or registry configuration.
- Primary RPC failure and fallback behavior.
- Wallet balance warnings.
- High-fee warnings.
- Scheduler output and alert routing.
- Receipt timeouts and process restarts.

A complete end-to-end test requires an actual volume funded with sBZZ. With one
available, also verify:

- A successful `trigger(bytes32)` transaction.
- Receipt and event handling.
- Processing continues when one configured volume fails.
- Missed scheduled runs leave the intended safety margin.
