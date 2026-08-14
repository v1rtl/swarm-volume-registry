// The VolumeRegistry surface a keeper cycle touches, and nothing more.
// Kept `as const` so viem can infer per-function argument and return types.
//
// Deliberately partial on the call side. Enumeration, the batched write, and
// the events that explain what the write did — that is the whole cycle. The
// contract's full error set is here regardless, because decoding a failure
// costs nothing and is worth having when there is one. `postage()`,
// `graceBlocks()` and `reap()` are absent because nothing here calls them: the
// contract decides what each volume needs, so the keeper never reads
// PostageStamp state to second-guess it. The singular `trigger(bytes32)`
// overload is omitted too — the batched form covers a single id, and one
// signature keeps viem's overload inference simple.

export const registryAbi = [
  {
    type: "function",
    name: "getActiveVolumeCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getActiveVolumes",
    stateMutability: "view",
    inputs: [
      { type: "uint256", name: "offset" },
      { type: "uint256", name: "limit" },
    ],
    outputs: [
      {
        type: "tuple[]",
        name: "",
        components: [
          { name: "volumeId", type: "bytes32" },
          { name: "owner", type: "address" },
          { name: "payer", type: "address" },
          { name: "chunkSigner", type: "address" },
          { name: "createdAt", type: "uint64" },
          { name: "ttlExpiry", type: "uint64" },
          { name: "depth", type: "uint8" },
          { name: "status", type: "uint8" },
          { name: "accountActive", type: "bool" },
        ],
      },
    ],
  },
  // Selected mode only: the ids a caller names are status-checked so the
  // result can report which of them are not Active volumes.
  {
    type: "function",
    name: "getVolume",
    stateMutability: "view",
    inputs: [{ type: "bytes32", name: "volumeId" }],
    outputs: [
      {
        type: "tuple",
        name: "",
        components: [
          { name: "volumeId", type: "bytes32" },
          { name: "owner", type: "address" },
          { name: "payer", type: "address" },
          { name: "chunkSigner", type: "address" },
          { name: "createdAt", type: "uint64" },
          { name: "ttlExpiry", type: "uint64" },
          { name: "depth", type: "uint8" },
          { name: "status", type: "uint8" },
          { name: "accountActive", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "trigger",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes32[]", name: "volumeIds" }],
    outputs: [],
  },
  // Events decoded off the trigger receipt to explain per-volume outcomes.
  {
    type: "event",
    name: "Toppedup",
    inputs: [
      { indexed: true, type: "bytes32", name: "volumeId" },
      { indexed: false, type: "uint256", name: "amount" },
      { indexed: false, type: "uint256", name: "newNormalisedBalance" },
    ],
  },
  {
    type: "event",
    name: "TopupSkipped",
    inputs: [
      { indexed: true, type: "bytes32", name: "volumeId" },
      { indexed: false, type: "uint8", name: "reason" },
    ],
  },
  {
    type: "event",
    name: "VolumeRetired",
    inputs: [
      { indexed: true, type: "bytes32", name: "volumeId" },
      { indexed: false, type: "uint8", name: "reason" },
    ],
  },
  // Custom errors, so a revert prints a name instead of a 4-byte blob. These
  // are a decode table like RETIRE_REASONS below, not call surface: viem
  // matches revert data against them by selector, and they add no way to drive
  // the registry.
  //
  // Against *this* contract they should stay quiet. `trigger(bytes32[])` runs
  // every id as `try this._triggerExt(id) {} catch {}`, so `VolumeNotActive`
  // never reaches the caller, the reads above cannot revert, and a receipt
  // carries no revert data. They earn their place when the configured address
  // is not the registry you think it is — a stale deployment, a wrong chain —
  // which is exactly when a keeper's logs are all you have.
  { type: "error", name: "AccountNotActive", inputs: [] },
  { type: "error", name: "DesignationClearedOnActivate", inputs: [] },
  {
    type: "error",
    name: "GraceBlocksBelowFloor",
    inputs: [
      { type: "uint64", name: "grace" },
      { type: "uint64", name: "floor_" },
    ],
  },
  { type: "error", name: "NotAuthorizedToRevoke", inputs: [] },
  { type: "error", name: "NotDesignated", inputs: [] },
  { type: "error", name: "NotVolumeOwner", inputs: [] },
  { type: "error", name: "VolumeNotActive", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
] as const;

/** Volume.status values (VolumeRegistry.sol). */
export const VOLUME_STATUS = { active: 1, retired: 2 } as const;

/** `VolumeRetired(volumeId, reason)` reason codes, decoded to names. */
export const RETIRE_REASONS: Record<number, string> = {
  1: "OwnerDeleted",
  2: "VolumeExpired",
  3: "BatchDied",
  4: "DepthChanged",
  5: "BatchOwnerMismatch",
};

/** `TopupSkipped(volumeId, reason)` reason codes, decoded to names. */
export const SKIP_REASONS: Record<number, string> = {
  1: "NoAuth",
  2: "PaymentFailed",
};
