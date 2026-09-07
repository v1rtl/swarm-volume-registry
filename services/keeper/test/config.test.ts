import { describe, expect, test } from "bun:test";
import { brief, makeScrubber, readConfig, redact } from "../src/config.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const REGISTRY = "0x33a53c79a08ed1f863905cd4c6ce036a4c493729";

const env = (overrides: Record<string, string | undefined> = {}) =>
  ({
    CHAIN_ID: "11155111",
    REGISTRY_ADDRESS: REGISTRY,
    RPC_URL: "https://rpc.example",
    PRIVATE_KEY: KEY,
    ...overrides,
  }) as NodeJS.ProcessEnv;

describe("redact", () => {
  test("keeps the host and drops the path, which is usually the key", () => {
    expect(redact("https://eth.example.com/v3/SECRET")).toBe("https://eth.example.com/…");
  });

  test("a bare origin has nothing to hide", () => {
    expect(redact("https://rpc.gnosischain.com")).toBe("https://rpc.gnosischain.com");
  });

  test("a key in the query string is dropped too", () => {
    expect(redact("https://eth.example.com/?apikey=SECRET")).toBe(
      "https://eth.example.com/…",
    );
  });

  test("something unparseable is not echoed back", () => {
    expect(redact("not a url")).toBe("<malformed url>");
  });
});

// The scrubber is what stands between an API key and a world-readable Actions
// log, and most of what it cleans is text viem wrote, not us.
describe("makeScrubber", () => {
  const url = "https://eth.example.com/v3/SUPERSECRET";
  const scrub = makeScrubber([url]);

  test("masks the endpoint inside a viem error message", () => {
    const viemError = `HTTP request failed.\n\nURL: ${url}\nRequest body: {}`;
    const scrubbed = scrub(viemError);
    expect(scrubbed).not.toContain("SUPERSECRET");
    expect(scrubbed).toContain("https://eth.example.com/…");
  });

  test("masks the trailing-slash form viem normalises to", () => {
    expect(scrub(`URL: ${url}/`)).not.toContain("SUPERSECRET");
  });

  test("masks every occurrence, not just the first", () => {
    const twice = scrub(`${url} and again ${url}`);
    expect(twice).not.toContain("SUPERSECRET");
    expect(twice.split("https://eth.example.com/…")).toHaveLength(3);
  });

  test("leaves unrelated text alone", () => {
    expect(scrub("nothing secret here")).toBe("nothing secret here");
  });

  test("a longer endpoint is not partly masked by a shorter prefix", () => {
    const both = makeScrubber([
      "https://eth.example.com",
      "https://eth.example.com/v3/SUPERSECRET",
    ]);
    expect(both(`URL: ${url}`)).not.toContain("SUPERSECRET");
  });

  test("no endpoints configured is a no-op, not a crash", () => {
    expect(makeScrubber([])("anything")).toBe("anything");
  });
});

describe("brief", () => {
  test("takes the headline off a multi-line viem error", () => {
    expect(brief("HTTP request failed.\n\nURL: x\nDetails: y")).toBe(
      "HTTP request failed.",
    );
  });

  test("truncates a long single line", () => {
    expect(brief("x".repeat(300)).length).toBe(160);
  });
});

describe("readConfig", () => {
  test("accepts a minimal valid environment", () => {
    const config = readConfig(env());
    expect(config.chain.id).toBe(11155111);
    expect(config.registry).toBe(REGISTRY);
    expect(config.mode).toEqual({ type: "all" });
    expect(config.dryRun).toBe(false);
    expect(config.minBalanceWei).toBe(0n);
  });

  test("VOLUME_IDS switches to selected mode", () => {
    const a = `0x${"11".repeat(32)}` as const satisfies `0x${string}`;
    const b = `0x${"22".repeat(32)}` as const satisfies `0x${string}`;
    expect(readConfig(env({ VOLUME_IDS: `${a}, ${b}` })).mode).toEqual({
      type: "selected",
      volumeIds: [a, b],
    });
  });

  test("several RPC endpoints are kept in order", () => {
    const config = readConfig(env({ RPC_URL: "https://a.example, https://b.example" }));
    expect(config.endpoints).toEqual(["https://a.example", "https://b.example"]);
  });

  // "false" arriving from an unset workflow input must not read as truthy.
  test.each(["false", "0", "no", ""])("DRY_RUN=%p is false", (value) => {
    expect(readConfig(env({ DRY_RUN: value })).dryRun).toBe(false);
  });

  test.each(["true", "1", "yes"])("DRY_RUN=%p is true", (value) => {
    expect(readConfig(env({ DRY_RUN: value })).dryRun).toBe(true);
  });

  // Unset repository variables arrive as empty strings, not as absent keys.
  test("empty optional variables fall back to defaults", () => {
    const config = readConfig(
      env({ MAX_VOLUMES_PER_CYCLE: "", PAGE_SIZE: "", MIN_BALANCE_WEI: "" }),
    );
    expect(config.maxVolumesPerCycle).toBeUndefined();
    expect(config.pageSize).toBeUndefined();
    expect(config.minBalanceWei).toBe(0n);
  });

  test.each([
    ["CHAIN_ID", { CHAIN_ID: "1" }, /unsupported CHAIN_ID/],
    ["PRIVATE_KEY", { PRIVATE_KEY: "0xdead" }, /PRIVATE_KEY/],
    ["RPC_URL", { RPC_URL: "" }, /RPC_URL is required/],
    ["REGISTRY_ADDRESS", { REGISTRY_ADDRESS: "nope" }, /not an address/],
    ["VOLUME_IDS", { VOLUME_IDS: "0x1234" }, /not a 32-byte hex string/],
  ])("rejects a bad %s", (_name, overrides, message) => {
    expect(() => readConfig(env(overrides))).toThrow(message);
  });
});
