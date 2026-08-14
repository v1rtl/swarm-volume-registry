import { describe, expect, test } from "bun:test";
import { collectActiveVolumes } from "../src/actions/collectActiveVolumes.js";
import { getActiveVolumeCount } from "../src/actions/getActiveVolumeCount.js";
import { trigger } from "../src/actions/trigger.js";
import { runKeeperCycle } from "../src/index.js";
import { REGISTRY, mockChain, volumeId, type MockVolume } from "./mock-chain.js";

const GRACE = 17_280n;
const PRICE = 44_445n;
const OUT = 1_000_000n;
const TARGET = GRACE * PRICE;

// The mock serves real PostageStamp state for these fixtures. The keeper never
// reads it — that is the point of `funded` and `due` looking different here and
// producing identical batches below.
const funded = (n: number): MockVolume => ({
  volumeId: volumeId(n),
  batch: { normalisedBalance: OUT + TARGET * 2n },
});

const due = (n: number): MockVolume => ({
  volumeId: volumeId(n),
  batch: { normalisedBalance: OUT + 1n },
});

describe("read actions", () => {
  test("getActiveVolumeCount counts the index", async () => {
    const { client } = mockChain({ volumes: [funded(1), funded(2)] });
    expect(await getActiveVolumeCount(client, { registry: REGISTRY })).toBe(2n);
  });

  test("collectActiveVolumes pages 150 volumes through multicall", async () => {
    const volumes = Array.from({ length: 150 }, (_, i) => funded(i + 1));
    const chain = mockChain({ volumes });
    const { client } = chain;

    const collected = await collectActiveVolumes(client, { registry: REGISTRY });
    expect(collected).toHaveLength(150);
    expect(chain.multicallCount).toBeGreaterThan(0);
  });

  test("collectActiveVolumes on an empty registry does no page reads", async () => {
    const { client } = mockChain({ volumes: [] });
    expect(await collectActiveVolumes(client, { registry: REGISTRY })).toEqual([]);
  });
});

describe("trigger", () => {
  test("sends the ids it was given", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    const { client } = chain;
    const hash = await trigger(client, {
      registry: REGISTRY,
      volumeIds: [volumeId(1)],
    });

    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(chain.triggerCalls).toEqual([[volumeId(1)]]);
  });

  test("an explicit gas limit skips estimation", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    const { client } = chain;
    await trigger(client, {
      registry: REGISTRY,
      volumeIds: [volumeId(1)],
      gas: 1_000_000n,
    });
    expect(chain.calls).not.toContain("eth_estimateGas");
    expect(chain.sentGas[0]).toBe(1_000_000n);
  });

  // trigger() has no top-level revert to catch — every id runs inside the
  // contract's own try/catch — so a simulate pass would only cost a round trip.
  test("does not spend an eth_call simulating first", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    await trigger(chain.client, { registry: REGISTRY, volumeIds: [volumeId(1)] });

    expect(chain.calls).toContain("eth_estimateGas");
    expect(chain.calls).not.toContain("eth_call");
  });

  // An under-estimate does not revert: the inner call OOGs, the catch swallows
  // it, and the transaction succeeds having topped up nothing. So the estimate
  // is scaled, and there is no cap that could silently claw it back.
  test("scales the estimate by gasMultiplier", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    await trigger(chain.client, { registry: REGISTRY, volumeIds: [volumeId(1)] });
    expect(chain.sentGas[0]).toBe((500_000n * 12n) / 10n); // mock estimates 500k

    const custom = mockChain({ volumes: [due(1)] });
    await trigger(custom.client, {
      registry: REGISTRY,
      volumeIds: [volumeId(1)],
      gasMultiplier: 2,
    });
    expect(custom.sentGas[0]).toBe(1_000_000n);
  });

  test("a large batch is not clamped", async () => {
    const chain = mockChain({ volumes: [due(1)], estimateGas: 40_000_000n });
    await trigger(chain.client, { registry: REGISTRY, volumeIds: [volumeId(1)] });
    expect(chain.sentGas[0]).toBe(48_000_000n);
  });
});

describe("runKeeperCycle", () => {
  test("an empty registry sends nothing", async () => {
    const chain = mockChain({ volumes: [] });
    const { client } = chain;
    const result = await runKeeperCycle(client, { registry: REGISTRY });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe("no active volumes");
    expect(chain.triggerCalls).toHaveLength(0);
  });

  // No client-side filtering: the contract decides what each id needs, and a
  // fully-funded volume is a silent no-op on chain.
  test("a fully-funded registry still triggers every volume", async () => {
    const chain = mockChain({ volumes: [funded(1), funded(2)] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(true);
    expect(result.volumeCount).toBe(2);
    expect(chain.triggerCalls).toEqual([[volumeId(1), volumeId(2)]]);
  });

  test("every active volume goes into the batch, due or not", async () => {
    const chain = mockChain({ volumes: [funded(1), due(2), funded(3)] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.ok).toBe(true);
    expect(result.volumeCount).toBe(3);
    expect(chain.triggerCalls).toEqual([[volumeId(1), volumeId(2), volumeId(3)]]);
    expect(result.txs[0]?.status).toBe("success");
  });

  // The package carries no PostageStamp ABI at all, and this is why: nothing on
  // the cycle path may form a second opinion about what a volume needs.
  test("reads no PostageStamp state — the contract does that itself", async () => {
    const chain = mockChain({ volumes: [funded(1), due(2)] });
    await runKeeperCycle(chain.client, { registry: REGISTRY });

    // Enumeration only: no batches()/lastPrice()/graceBlocks() round trips.
    expect(chain.postageReads).toBe(0);
  });

  test("receipt events land in the result", async () => {
    const { client } = mockChain({ volumes: [due(1)] });
    const result = await runKeeperCycle(client, { registry: REGISTRY });
    expect(result.toppedUp).toEqual([{ volumeId: volumeId(1), amount: 1000n }]);
  });

  test("a volume with no batch is sent so the contract can retire it", async () => {
    const chain = mockChain({ volumes: [{ volumeId: volumeId(1) }] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.volumeCount).toBe(1);
    expect(chain.triggerCalls).toEqual([[volumeId(1)]]);
  });

  test("volumes with no active account are sent; the contract decides", async () => {
    const chain = mockChain({ volumes: [{ ...due(1), accountActive: false }] });
    const result = await runKeeperCycle(chain.client, { registry: REGISTRY });

    expect(result.volumeCount).toBe(1);
    expect(chain.triggerCalls).toEqual([[volumeId(1)]]);
  });

  test("ids are chunked across transactions", async () => {
    const volumes = Array.from({ length: 5 }, (_, i) => due(i + 1));
    const chain = mockChain({ volumes });
    const { client } = chain;
    const result = await runKeeperCycle(client, {
      registry: REGISTRY,
      maxIdsPerTx: 2,
    });

    expect(chain.triggerCalls.map((ids) => ids.length)).toEqual([2, 2, 1]);
    expect(result.txs).toHaveLength(3);
  });

  test("hitting maxTxPerCycle defers the rest and says so", async () => {
    const volumes = Array.from({ length: 5 }, (_, i) => due(i + 1));
    const chain = mockChain({ volumes });
    const { client } = chain;
    const result = await runKeeperCycle(client, {
      registry: REGISTRY,
      maxIdsPerTx: 2,
      maxTxPerCycle: 1,
    });

    expect(chain.triggerCalls).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("deferred");
  });

  test("a reverted transaction fails the cycle without throwing", async () => {
    const { client } = mockChain({ volumes: [due(1)], revertTx: true });
    const result = await runKeeperCycle(client, { registry: REGISTRY });

    expect(result.ok).toBe(false);
    expect(result.txs[0]?.status).toBe("reverted");
    expect(result.txs[0]?.hash).toBeDefined();
  });

  test("a dead RPC produces an error result, not a throw", async () => {
    const { client } = mockChain({ volumes: [due(1)], failWith: "socket hang up" });
    const result = await runKeeperCycle(client, { registry: REGISTRY });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("socket hang up");
  });

  test("a stuck transaction keeps its hash for follow-up", async () => {
    const { client } = mockChain({ volumes: [due(1)], dropReceipts: true });
    const result = await runKeeperCycle(client, {
      registry: REGISTRY,
      receiptTimeout: 300,
    });

    expect(result.ok).toBe(false);
    expect(result.txs[0]?.status).toBe("failed");
    expect(result.txs[0]?.hash).toBeDefined();
  });

  test("dryRun simulates and sends nothing", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    const { client } = chain;
    const result = await runKeeperCycle(client, {
      registry: REGISTRY,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.volumeCount).toBe(1);
    expect(result.txs[0]?.status).toBe("simulated");
    expect(chain.triggerCalls).toHaveLength(0);
    expect(chain.calls).not.toContain("eth_sendRawTransaction");
  });

  test("selected mode leaves other people's due volumes alone", async () => {
    const chain = mockChain({ volumes: [due(1), due(2)] });
    const { client } = chain;
    const result = await runKeeperCycle(client, {
      registry: REGISTRY,
      mode: { type: "selected", volumeIds: [volumeId(1)] },
    });

    expect(result.mode).toBe("selected");
    expect(chain.triggerCalls).toEqual([[volumeId(1)]]);
  });

  test("selected mode flags ids that are not Active volumes", async () => {
    const chain = mockChain({ volumes: [due(1)] });
    const result = await runKeeperCycle(chain.client, {
      registry: REGISTRY,
      mode: { type: "selected", volumeIds: [volumeId(1), volumeId(99)] },
    });

    expect(result.notActive).toEqual([volumeId(99)]);
    expect(chain.triggerCalls).toEqual([[volumeId(1)]]);
  });
});
