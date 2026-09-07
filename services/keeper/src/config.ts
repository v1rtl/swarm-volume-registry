import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  isAddress,
  isHex,
  publicActions,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gnosis, sepolia } from "viem/chains";
import type { KeeperMode } from "ethswarm-volume-keeper";

/**
 * Chains this runner can be pointed at. Add one here to support it — its viem
 * `Chain` must carry `contracts.multicall3`, which is how every read is
 * batched.
 */
const CHAINS: Record<number, Chain> = {
  [gnosis.id]: gnosis,
  [sepolia.id]: sepolia,
};

export interface Config {
  chain: Chain;
  privateKey: Hex;
  /** Tried in order. The first is the primary. */
  endpoints: string[];
  registry: Address;
  mode: KeeperMode;
  dryRun: boolean;
  maxVolumesPerCycle?: number;
  pageSize?: number;
  confirmations?: number;
  receiptTimeout?: number;
  cycleTimeout: number;
  /** Warn when the keeper's native balance drops below this. 0 disables. */
  minBalanceWei: bigint;
  /** Escalate warnings to a failing exit code — see the README on notifications. */
  failOnWarning: boolean;
}

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const num = (raw: string | undefined): number | undefined =>
  raw && raw.trim() ? Number(raw) : undefined;

const bool = (raw: string | undefined): boolean =>
  !!raw && !["", "false", "0", "no"].includes(raw.trim().toLowerCase());

/**
 * Hide the path of an RPC URL, which usually *is* the API key.
 *
 * GitHub masks registered secrets in logs, but only on exact match — a URL
 * assembled or split anywhere along the way can slip through, and on a public
 * repository the logs are world-readable. Cheap insurance.
 */
export const redact = (url: string): string => {
  try {
    const u = new URL(url);
    return u.pathname === "/" && !u.search
      ? `${u.protocol}//${u.host}`
      : `${u.protocol}//${u.host}/…`;
  } catch {
    return "<malformed url>";
  }
};

/**
 * Replace every configured endpoint URL with its redacted form, anywhere in a
 * string.
 *
 * Redacting at the point where *we* print a URL is not enough: viem embeds the
 * full endpoint in its error messages ("URL: https://…/<api key>"), and those
 * messages travel into warnings, annotations, the JSON line and the Telegram
 * ping. So scrubbing happens at the output boundary instead, over text nobody
 * here composed.
 */
export function makeScrubber(endpoints: string[]): (text: string) => string {
  const pairs: Array<[string, string]> = [];
  for (const url of endpoints) {
    const replacement = redact(url);
    const variants = new Set<string>([url, url.replace(/\/+$/, "")]);
    try {
      variants.add(new URL(url).href);
    } catch {
      // Unparseable: the raw form is still worth masking.
    }
    for (const variant of variants) {
      if (variant) pairs.push([variant, replacement]);
    }
  }
  // Longest first, so a shorter variant never masks part of a longer match.
  pairs.sort((a, b) => b[0].length - a[0].length);
  return (text) =>
    pairs.reduce((acc, [from, to]) => acc.split(from).join(to), text);
}

/** viem errors run to many lines; a warning wants the headline. */
export const brief = (message: string, max = 160): string => {
  const line = message
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)[0];
  const text = line ?? message;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const chainId = Number(env.CHAIN_ID);
  const chain = CHAINS[chainId];
  if (!chain) {
    throw new Error(
      `unsupported CHAIN_ID ${env.CHAIN_ID ?? "(unset)"} (supported: ${Object.keys(CHAINS).join(", ")})`,
    );
  }

  const privateKey = env.PRIVATE_KEY ?? "";
  if (!isHex(privateKey) || privateKey.length !== 66) {
    throw new Error("PRIVATE_KEY must be a 0x-prefixed 32-byte hex string");
  }

  const endpoints = list(env.RPC_URL);
  if (endpoints.length === 0) throw new Error("RPC_URL is required");

  const registry = env.REGISTRY_ADDRESS ?? "";
  if (!isAddress(registry)) {
    throw new Error(`REGISTRY_ADDRESS is not an address: ${registry || "(unset)"}`);
  }

  const volumeIds = list(env.VOLUME_IDS);
  for (const id of volumeIds) {
    if (!isHex(id) || id.length !== 66) {
      throw new Error(`VOLUME_IDS entry is not a 32-byte hex string: ${id}`);
    }
  }

  return {
    chain,
    privateKey,
    endpoints,
    registry,
    mode: volumeIds.length
      ? { type: "selected", volumeIds: volumeIds as Hex[] }
      : { type: "all" },
    dryRun: bool(env.DRY_RUN),
    maxVolumesPerCycle: num(env.MAX_VOLUMES_PER_CYCLE),
    pageSize: num(env.PAGE_SIZE),
    confirmations: num(env.CONFIRMATIONS),
    receiptTimeout: num(env.RECEIPT_TIMEOUT_MS),
    // A runner has minutes of wall clock, not a Worker's tight budget, so the
    // default is well above the package's 120s. `timeout-minutes` on the job is
    // the real backstop; this one exits cleanly and reports what it deferred.
    cycleTimeout: num(env.CYCLE_TIMEOUT_MS) ?? 300_000,
    minBalanceWei: env.MIN_BALANCE_WEI?.trim()
      ? BigInt(env.MIN_BALANCE_WEI.trim())
      : 0n,
    failOnWarning: bool(env.FAIL_ON_WARNING),
  };
}

export interface EndpointHealth {
  url: string;
  redacted: string;
  ok: boolean;
  chainId?: number;
  blockNumber?: bigint;
  latencyMs: number;
  error?: string;
}

/**
 * Check every endpoint before the cycle starts, and report what it found.
 *
 * The Worker keeps one isolate alive across ticks, so it can let viem's
 * `fallback` rank endpoints over time and learn which is slow. A run that lives
 * for one cycle learns nothing it can keep, and `rank` schedules an interval
 * that would hold the process open past the work. So this runner ranks nothing
 * and probes instead: one round trip per endpoint, up front, turning "we
 * quietly failed over" into a line in the log.
 *
 * A wrong `chainId` is treated as unusable rather than merely noted. An
 * endpoint on the wrong network answers reads confidently and wrongly, which
 * looks exactly like an empty registry.
 */
export async function probeEndpoints(
  endpoints: string[],
  chain: Chain,
  timeout = 10_000,
): Promise<EndpointHealth[]> {
  return Promise.all(
    endpoints.map(async (url): Promise<EndpointHealth> => {
      const startedAt = Date.now();
      const redacted = redact(url);
      try {
        const client = createPublicClient({
          chain,
          transport: http(url, { retryCount: 0, timeout }),
        });
        const [chainId, blockNumber] = await Promise.all([
          client.getChainId(),
          client.getBlockNumber({ cacheTime: 0 }),
        ]);
        const latencyMs = Date.now() - startedAt;
        if (chainId !== chain.id) {
          return {
            url,
            redacted,
            ok: false,
            chainId,
            latencyMs,
            error: `reports chain id ${chainId}, expected ${chain.id}`,
          };
        }
        return { url, redacted, ok: true, chainId, blockNumber, latencyMs };
      } catch (err) {
        return {
          url,
          redacted,
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

/**
 * A wallet client with public actions — what `runKeeperCycle` expects.
 *
 * `endpoints` should be the healthy ones from {@link probeEndpoints}, still in
 * configured order. Each gets `retryCount: 0` so a dead one is abandoned
 * immediately and `fallback` owns the retry budget as it walks the list. No
 * `rank`: see {@link probeEndpoints}.
 */
export function buildClient(config: Config, endpoints: string[]) {
  return createWalletClient({
    account: privateKeyToAccount(config.privateKey),
    chain: config.chain,
    transport: fallback(
      endpoints.map((url) => http(url, { retryCount: 0, timeout: 15_000 })),
      { retryCount: 2 },
    ),
  }).extend(publicActions);
}
