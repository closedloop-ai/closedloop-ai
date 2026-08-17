import { createHash } from "node:crypto";
import {
  AGENT_COMPONENT_INVOCATION_DEFINITION_CONTENT_MAX_BYTES,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_PARTS,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_ITEM_BYTES,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_BYTES,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_ITEMS,
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  type AgentComponentInvocationCompleteGeneration,
  type AgentComponentInvocationSyncItem,
  type AgentComponentInvocationSyncPart,
  agentComponentInvocationGenerationHashPreimage,
  agentComponentInvocationSyncPartHashPreimage,
  agentComponentInvocationSyncProtocolVersionForItems,
} from "@repo/api/src/types/agent-component-invocation";
import { agentComponentInvocationSyncPartSchema } from "@repo/api/src/types/agent-component-invocation-schema";

const textEncoder = new TextEncoder();
const SHA_256_PLACEHOLDER = "0".repeat(64);

/**
 * Produce immutable, byte-bounded protocol parts from one complete Desktop
 * projection. Definition content above the dedicated cap is omitted before the
 * generation identity is checked, while its exact hash/status remain present.
 */
export function prepareAgentComponentInvocationSyncParts(
  generation: AgentComponentInvocationCompleteGeneration,
  options: AgentComponentInvocationSyncPayloadOptions = {}
): AgentComponentInvocationSyncPart[] {
  const items = canonicalInvocationItems(generation.items);
  const expectedGenerationId = sha256Hex(
    agentComponentInvocationGenerationHashPreimage({
      externalSessionId: generation.externalSessionId,
      items,
    })
  );
  if (generation.externalGenerationId !== expectedGenerationId) {
    throw new Error(
      "invocation generation id does not match its canonical items"
    );
  }

  const itemParts = partitionItems(generation, items);
  const partCount = itemParts.length;
  const maxGenerationParts =
    options.maxGenerationParts ??
    AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_PARTS;
  if (partCount > maxGenerationParts) {
    throw new AgentComponentInvocationSyncPayloadLimitError(
      "invocation generation exceeds the part-count limit"
    );
  }

  return itemParts.map((partItems, partIndex) => {
    const withoutHash = {
      // ISS-4976: chosen from THIS part's own items. A telemetry-free part still
      // declares v1 and an older API accepts it exactly as today; a
      // telemetry-carrying part declares v2, which an older API answers with the
      // retryable `protocol_unsupported` instead of a permanent 400.
      protocolVersion:
        agentComponentInvocationSyncProtocolVersionForItems(partItems),
      externalSessionId: generation.externalSessionId,
      externalGenerationId: generation.externalGenerationId,
      sourceUpdatedAt: generation.sourceUpdatedAt,
      dataRevision: generation.dataRevision,
      sourceSequence: generation.sourceSequence,
      partIndex,
      partCount,
      items: partItems,
    };
    const part: AgentComponentInvocationSyncPart = {
      ...withoutHash,
      partHash: sha256Hex(
        agentComponentInvocationSyncPartHashPreimage(withoutHash)
      ),
    };
    assertSerializedBytes(
      part,
      AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_BYTES,
      "invocation part"
    );
    assertPartSatisfiesWireContract(part);
    return part;
  });
}

/**
 * ISS-4976 (@wongk review): run the SHARED ingest boundary over the part the
 * producer just built, so the producer has the same boundary as the cloud
 * instead of a type-only construction path.
 *
 * Without it, the only thing that ever evaluated the runtime contract was the
 * cloud, which answers 400 — the Desktop client's PERMANENT `validation_failed`
 * — and the generation is dead-lettered after five identical round trips. Here
 * the same verdict is reached before anything is queued, so the failing field
 * path is recorded locally instead of being inferred from a remote 400.
 */
function assertPartSatisfiesWireContract(
  part: AgentComponentInvocationSyncPart
): void {
  const parsed = agentComponentInvocationSyncPartSchema.safeParse(
    JSON.parse(JSON.stringify(part))
  );
  if (parsed.success) {
    return;
  }
  const [issue] = parsed.error.issues;
  throw new AgentComponentInvocationSyncPayloadContractError(
    issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid part"
  );
}

/** Compute the generation identity after producer-side evidence omission. */
export function computeAgentComponentInvocationGenerationId(
  externalSessionId: string,
  items: AgentComponentInvocationSyncItem[]
): string {
  return sha256Hex(
    agentComponentInvocationGenerationHashPreimage({
      externalSessionId,
      items: canonicalInvocationItems(items),
    })
  );
}

function canonicalInvocationItems(
  input: AgentComponentInvocationSyncItem[]
): AgentComponentInvocationSyncItem[] {
  if (input.length > AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS) {
    throw new AgentComponentInvocationSyncPayloadLimitError(
      "invocation generation exceeds the item-count limit"
    );
  }
  const items = input
    .map(canonicalizeInvocationDates)
    .map(omitOversizedDefinitionContent)
    .sort(compareItems);
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.externalInvocationId)) {
      throw new Error(
        "invocation generation contains a duplicate invocation id"
      );
    }
    ids.add(item.externalInvocationId);
    assertSerializedBytes(
      item,
      AGENT_COMPONENT_INVOCATION_SYNC_MAX_ITEM_BYTES,
      "invocation item"
    );
  }
  return items;
}

/** Match the canonical ISO representation produced by cloud DateTime columns. */
function canonicalizeInvocationDates(
  item: AgentComponentInvocationSyncItem
): AgentComponentInvocationSyncItem {
  return {
    ...item,
    invokedAt: canonicalIsoDate(item.invokedAt),
    ...(item.sourceModifiedAt === undefined
      ? {}
      : { sourceModifiedAt: canonicalIsoDate(item.sourceModifiedAt) }),
    ...(item.capturedAt === undefined
      ? {}
      : { capturedAt: canonicalIsoDate(item.capturedAt) }),
  };
}

function canonicalIsoDate(value: string): string;
function canonicalIsoDate(value: string | null): string | null;
function canonicalIsoDate(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function omitOversizedDefinitionContent(
  item: AgentComponentInvocationSyncItem
): AgentComponentInvocationSyncItem {
  if (
    item.definitionContent === undefined ||
    textEncoder.encode(item.definitionContent).byteLength <=
      AGENT_COMPONENT_INVOCATION_DEFINITION_CONTENT_MAX_BYTES
  ) {
    return item;
  }
  const { definitionContent: _definitionContent, ...withoutContent } = item;
  return withoutContent;
}

function compareItems(
  left: AgentComponentInvocationSyncItem,
  right: AgentComponentInvocationSyncItem
): number {
  const bySequence = left.sequence - right.sequence;
  return bySequence === 0
    ? left.externalInvocationId.localeCompare(right.externalInvocationId)
    : bySequence;
}

function partitionItems(
  generation: AgentComponentInvocationCompleteGeneration,
  items: AgentComponentInvocationSyncItem[]
): AgentComponentInvocationSyncItem[][] {
  if (items.length === 0) {
    return [[]];
  }
  // FEA-4425: track the in-progress part's serialized byte size with a running
  // total instead of re-serializing the whole GROWING candidate part on every
  // item. The previous greedy loop called
  // `estimatedPartBytes(generation, [...current, item])` per item —
  // `JSON.stringify` over the entire prefix each time — which is O(N²) in
  // serialization work and, on a large generation (up to
  // AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS), dominates the sync
  // payload build. Because `JSON.stringify` emits no whitespace, a part's exact
  // serialized byte length is the empty-part base (the envelope plus the empty
  // `"items":[]`) plus each item's own JSON byte length plus one separator (`,`)
  // byte between items — identical arithmetic to `estimatedPartBytes`, so part
  // boundaries are byte-for-byte unchanged.
  const baseBytes = estimatedPartBytes(generation, []);
  const parts: AgentComponentInvocationSyncItem[][] = [];
  let current: AgentComponentInvocationSyncItem[] = [];
  let currentBytes = baseBytes;
  for (const item of items) {
    const itemBytes = serializedBytes(item);
    // A leading separator byte is only added once the part already holds an item.
    const marginalBytes = current.length > 0 ? itemBytes + 1 : itemBytes;
    if (
      current.length + 1 <= AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_ITEMS &&
      currentBytes + marginalBytes <=
        AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_BYTES
    ) {
      current.push(item);
      currentBytes += marginalBytes;
      continue;
    }
    if (current.length === 0) {
      throw new AgentComponentInvocationSyncPayloadLimitError(
        "invocation item cannot fit in one protocol part"
      );
    }
    parts.push(current);
    current = [item];
    currentBytes = baseBytes + itemBytes;
    if (currentBytes > AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_BYTES) {
      throw new AgentComponentInvocationSyncPayloadLimitError(
        "invocation item cannot fit in one protocol part"
      );
    }
  }
  parts.push(current);
  return parts;
}

function estimatedPartBytes(
  generation: AgentComponentInvocationCompleteGeneration,
  items: AgentComponentInvocationSyncItem[]
): number {
  return serializedBytes({
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    externalSessionId: generation.externalSessionId,
    externalGenerationId: generation.externalGenerationId,
    sourceUpdatedAt: generation.sourceUpdatedAt,
    dataRevision: generation.dataRevision,
    sourceSequence: generation.sourceSequence,
    partIndex: AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_PARTS - 1,
    partCount: AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_PARTS,
    partHash: SHA_256_PLACEHOLDER,
    items,
  });
}

function assertSerializedBytes(
  value: unknown,
  maxBytes: number,
  label: string
): void {
  if (serializedBytes(value) > maxBytes) {
    throw new AgentComponentInvocationSyncPayloadLimitError(
      `${label} exceeds its serialized byte limit`
    );
  }
}

function serializedBytes(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type AgentComponentInvocationSyncPayloadOptions = {
  maxGenerationParts?: number;
};

export class AgentComponentInvocationSyncPayloadLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentComponentInvocationSyncPayloadLimitError";
  }
}

/** A built part the shared ingest boundary rejects; see {@link assertPartSatisfiesWireContract}. */
export class AgentComponentInvocationSyncPayloadContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentComponentInvocationSyncPayloadContractError";
  }
}
