import { describe, expect, test } from "bun:test";
import { decodeErrorResult, encodeErrorResult } from "viem";
import { registryAbi } from "../src/abi.js";

// Selectors as the compiler computes them: `forge inspect VolumeRegistry
// errors`, run against contracts/src/VolumeRegistry.sol. A mismatch means the
// hand-written ABI has drifted from the contract — a renamed error or a
// changed argument type — and revert data would silently stop decoding.
type ErrorName = Extract<(typeof registryAbi)[number], { type: "error" }>["name"];

// Exhaustive by construction: adding an error to the ABI without pinning its
// selector here is a type error, not a test that quietly stops covering it.
const SELECTORS: Record<ErrorName, `0x${string}`> = {
  AccountNotActive: "0x4d571464",
  DesignationClearedOnActivate: "0x2b8cb86b",
  GraceBlocksBelowFloor: "0xa728cabc",
  NotAuthorizedToRevoke: "0xb4a8529c",
  NotDesignated: "0x69f3dfcd",
  NotVolumeOwner: "0x431be6b7",
  VolumeNotActive: "0x2f607c28",
  ZeroAddress: "0xd92e233d",
};

const ARGS: Partial<Record<ErrorName, readonly unknown[]>> = {
  GraceBlocksBelowFloor: [1n, 17_280n],
};

describe("registry error ABI", () => {
  const errors = registryAbi.filter((item) => item.type === "error");

  test("carries the contract's whole error set, and nothing invented", () => {
    const names: string[] = errors.map((e) => e.name);
    expect(names.sort()).toEqual(Object.keys(SELECTORS).sort());
  });

  for (const [name, selector] of Object.entries(SELECTORS)) {
    test(`${name} encodes to ${selector}`, () => {
      const args = ARGS[name as ErrorName];
      const data = encodeErrorResult({
        abi: registryAbi,
        errorName: name,
        ...(args ? { args } : {}),
      } as never);
      expect(data.slice(0, 10)).toBe(selector);
    });
  }

  test("revert data decodes to a name, not a blob", () => {
    // What viem hands back off a failed eth_call against the registry.
    expect(decodeErrorResult({ abi: registryAbi, data: "0x2f607c28" })).toMatchObject({
      errorName: "VolumeNotActive",
    });
  });

  test("an error with arguments decodes them too", () => {
    const data = encodeErrorResult({
      abi: registryAbi,
      errorName: "GraceBlocksBelowFloor",
      args: [1n, 17_280n],
    });
    expect(decodeErrorResult({ abi: registryAbi, data })).toMatchObject({
      errorName: "GraceBlocksBelowFloor",
      args: [1n, 17_280n],
    });
  });
});
