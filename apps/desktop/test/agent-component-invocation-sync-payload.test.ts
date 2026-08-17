import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  AGENT_COMPONENT_INVOCATION_DEFINITION_CONTENT_MAX_BYTES,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_PARTS,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_BYTES,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_ITEMS,
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  type AgentComponentInvocationCompleteGeneration,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncItem,
  agentComponentInvocationSyncPartHashPreimage,
} from "@repo/api/src/types/agent-component-invocation";
import {
  AgentComponentInvocationSyncPayloadContractError,
  AgentComponentInvocationSyncPayloadLimitError,
  computeAgentComponentInvocationGenerationId,
  prepareAgentComponentInvocationSyncParts,
} from "../src/main/agent-sync/agent-component-invocation-sync-payload.js";

const DUPLICATE_INVOCATION_ID_RE = /duplicate invocation id/;
const GENERATION_ID_MISMATCH_RE = /generation id does not match/;

describe("agent component invocation sync payload", () => {
  it("canonically orders items and hashes every immutable part", () => {
    const generation = completeGeneration([
      invocation("second", 2),
      invocation("first", 1),
    ]);

    const parts = prepareAgentComponentInvocationSyncParts(generation);

    assert.equal(parts.length, 1);
    assert.deepEqual(
      parts[0].items.map((item) => item.externalInvocationId),
      ["first", "second"]
    );
    const { partHash: _partHash, ...withoutHash } = parts[0];
    assert.equal(
      parts[0].partHash,
      createHash("sha256")
        .update(agentComponentInvocationSyncPartHashPreimage(withoutHash))
        .digest("hex")
    );
  });

  it("omits oversized definition content without dropping exact attribution", () => {
    const item = {
      ...invocation("large", 0),
      kind: AgentComponentInvocationKind.Skill,
      status: AgentComponentInvocationAttributionStatus.Matched,
      evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
      definitionHash: "a".repeat(64),
      normalizerContractVersion: 1,
      definitionContent: "x".repeat(
        AGENT_COMPONENT_INVOCATION_DEFINITION_CONTENT_MAX_BYTES + 1
      ),
    };
    const parts = prepareAgentComponentInvocationSyncParts(
      completeGeneration([item])
    );

    assert.ok(!("definitionContent" in parts[0].items[0]));
    assert.equal(parts[0].items[0].definitionHash, "a".repeat(64));
    assert.equal(
      parts[0].items[0].status,
      AgentComponentInvocationAttributionStatus.Matched
    );
  });

  it("creates an explicit one-part empty generation", () => {
    const parts = prepareAgentComponentInvocationSyncParts(
      completeGeneration([])
    );

    assert.equal(parts.length, 1);
    assert.equal(parts[0].partIndex, 0);
    assert.equal(parts[0].partCount, 1);
    assert.deepEqual(parts[0].items, []);
  });

  it("canonicalizes equivalent ISO timestamp spellings before hashing", () => {
    // Provenance timestamps only belong on a kind that can carry provenance —
    // the shared boundary the producer now runs rejects them on tool/MCP/
    // orchestration rows, exactly as the cloud always has.
    const item = {
      ...invocation("offset-date", 0),
      kind: AgentComponentInvocationKind.Skill,
      invokedAt: "2026-07-22T11:00:00-05:00",
      sourceModifiedAt: "2026-07-22T12:00:00-04:00",
      capturedAt: "2026-07-22T16:00:00Z",
    };

    const parts = prepareAgentComponentInvocationSyncParts(
      completeGeneration([item])
    );

    assert.equal(parts[0].items[0].invokedAt, "2026-07-22T16:00:00.000Z");
    assert.equal(
      parts[0].items[0].sourceModifiedAt,
      "2026-07-22T16:00:00.000Z"
    );
    assert.equal(parts[0].items[0].capturedAt, "2026-07-22T16:00:00.000Z");
  });

  it("splits item-count overflow without changing canonical order", () => {
    const items = Array.from({ length: 501 }, (_, index) =>
      invocation(`invocation-${String(index).padStart(3, "0")}`, index)
    );
    const parts = prepareAgentComponentInvocationSyncParts(
      completeGeneration(items)
    );

    assert.equal(parts.length, 2);
    assert.equal(parts[0].items.length, 500);
    assert.equal(parts[1].items.length, 1);
    assert.ok(parts.every((part) => part.partCount === 2));
  });

  // FEA-4425: `partitionItems` now tracks the in-progress part's serialized byte
  // size with a running total instead of re-serializing the whole growing
  // candidate part per item (which was O(N²) in JSON.stringify work). These
  // tests pin that the incremental total yields the SAME byte-driven part
  // boundaries as full serialization would: each emitted part stays within the
  // cap, AND the boundary is tight — the first item of the next part could not
  // have been appended to the previous part without exceeding the cap.
  it("splits by serialized bytes at boundaries identical to full serialization", () => {
    // Large per-item definition content (kept — exactly at the omission cap) so
    // only a handful of items fit one part by BYTES, well before the 500-item
    // cap. This exercises the byte-driven branch, not the count-driven one.
    const items = Array.from({ length: 40 }, (_, index) =>
      largeInvocation(index)
    );
    const generation = completeGeneration(items);

    const parts = prepareAgentComponentInvocationSyncParts(generation);

    assert.ok(parts.length > 1, "expected a byte-driven split into >1 part");
    for (const part of parts) {
      assert.ok(
        serializedByteLength(part) <=
          AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_BYTES,
        "every emitted part must fit the serialized-byte cap"
      );
      assert.ok(
        part.items.length <= AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_ITEMS
      );
    }
    // Reassembly is loss-free and canonical order is preserved.
    assert.deepEqual(
      parts.flatMap((part) =>
        part.items.map((item) => item.externalInvocationId)
      ),
      items.map((item) => item.externalInvocationId)
    );
    // Boundaries are TIGHT: dropping the first item of part k+1 onto part k
    // would have pushed part k past the byte cap — i.e. the greedy pack filled
    // each part as full as full-serialization sizing allows.
    for (let k = 0; k < parts.length - 1; k += 1) {
      const merged = {
        ...parts[k],
        items: [...parts[k].items, parts[k + 1].items[0]],
      };
      assert.ok(
        serializedByteLength(merged) >
          AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_BYTES,
        `part ${k} was not packed tight against the byte cap`
      );
    }
  });

  it("produces part sizes matching a fresh full-serialization reference pack", () => {
    const items = Array.from({ length: 40 }, (_, index) =>
      largeInvocation(index)
    );
    const generation = completeGeneration(items);

    const parts = prepareAgentComponentInvocationSyncParts(generation);
    const canonicalItems = parts.flatMap((part) => part.items);

    // Independently re-derive the boundaries with the NAIVE full-serialization
    // greedy pack the incremental running-total replaced, and assert identical
    // per-part item counts.
    const expected = referencePartitionSizes(generation, canonicalItems);
    assert.deepEqual(
      parts.map((part) => part.items.length),
      expected
    );
  });

  it("classifies deterministic wire partition limits for local dead-letter handling", () => {
    const items = Array.from({ length: 501 }, (_, index) =>
      invocation(`limited-invocation-${String(index).padStart(3, "0")}`, index)
    );
    const generation = completeGeneration(items);

    assert.throws(
      () =>
        prepareAgentComponentInvocationSyncParts(generation, {
          maxGenerationParts: 1,
        }),
      AgentComponentInvocationSyncPayloadLimitError
    );
  });

  it("rejects duplicate invocation identities and mismatched generation ids", () => {
    assert.throws(
      () => completeGeneration([invocation("same", 0), invocation("same", 1)]),
      DUPLICATE_INVOCATION_ID_RE
    );

    const generation = completeGeneration([invocation("one", 0)]);
    assert.throws(
      () =>
        prepareAgentComponentInvocationSyncParts({
          ...generation,
          externalGenerationId: "f".repeat(64),
        }),
      GENERATION_ID_MISMATCH_RE
    );
  });
});

function invocation(
  externalInvocationId: string,
  sequence: number
): AgentComponentInvocationSyncItem {
  return {
    externalInvocationId,
    sourceSessionId: "session-1",
    kind: AgentComponentInvocationKind.Tool,
    componentKey: "Read",
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: "2026-07-22T16:00:00.000Z",
    sequence,
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: `event-${externalInvocationId}`,
    },
    status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
  };
}

function completeGeneration(
  items: AgentComponentInvocationSyncItem[]
): AgentComponentInvocationCompleteGeneration {
  const externalSessionId = "session-1";
  return {
    externalSessionId,
    externalGenerationId: computeAgentComponentInvocationGenerationId(
      externalSessionId,
      items
    ),
    sourceUpdatedAt: "2026-07-22T16:00:00.000Z",
    dataRevision: 35,
    sourceSequence: 1,
    items,
  };
}

// A kept-content invocation whose serialized size is a large fraction of the
// per-part byte cap, so only a few fit one part by bytes (before the 500-item
// cap), forcing the byte-driven `partitionItems` branch.
function largeInvocation(index: number): AgentComponentInvocationSyncItem {
  return {
    ...invocation(`large-${String(index).padStart(3, "0")}`, index),
    kind: AgentComponentInvocationKind.Skill,
    status: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    definitionHash: "a".repeat(64),
    normalizerContractVersion: 1,
    // Exactly at the omission cap so the content is retained (not stripped).
    definitionContent: "x".repeat(
      AGENT_COMPONENT_INVOCATION_DEFINITION_CONTENT_MAX_BYTES
    ),
  };
}

function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

// Naive full-serialization greedy pack — the O(N²) reference `partitionItems`
// replaced with an incremental running byte total. Re-serializes the whole
// growing candidate part per item; asserted to yield the SAME per-part sizes.
function referencePartitionSizes(
  generation: AgentComponentInvocationCompleteGeneration,
  items: AgentComponentInvocationSyncItem[]
): number[] {
  const sizes: number[] = [];
  let current: AgentComponentInvocationSyncItem[] = [];
  for (const item of items) {
    const candidate = [...current, item];
    if (
      candidate.length <= AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_ITEMS &&
      referencePartBytes(generation, candidate) <=
        AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_BYTES
    ) {
      current = candidate;
      continue;
    }
    sizes.push(current.length);
    current = [item];
  }
  sizes.push(current.length);
  return sizes;
}

function referencePartBytes(
  generation: AgentComponentInvocationCompleteGeneration,
  items: AgentComponentInvocationSyncItem[]
): number {
  return serializedByteLength({
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    externalSessionId: generation.externalSessionId,
    externalGenerationId: generation.externalGenerationId,
    sourceUpdatedAt: generation.sourceUpdatedAt,
    dataRevision: generation.dataRevision,
    sourceSequence: generation.sourceSequence,
    partIndex: AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_PARTS - 1,
    partCount: AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_PARTS,
    partHash: "0".repeat(64),
    items,
  });
}

/**
 * ISS-4976 (@wongk T5 / @closedloop-ai-stage T1): a Desktop build shipping
 * ahead of the API must not have its telemetry-carrying generations
 * dead-lettered. The producer declares the version per part, so an older API
 * answers the retryable `protocol_unsupported` for a telemetry part while a
 * telemetry-free part is still accepted on v1 exactly as before.
 */
describe("invocation sync part protocol version", () => {
  it("declares the telemetry-free version when no item carries telemetry", () => {
    const parts = prepareAgentComponentInvocationSyncParts(
      completeGeneration([invocation("invocation-1", 0)])
    );

    assert.equal(parts.length, 1);
    assert.equal(
      parts[0]?.protocolVersion,
      AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION
    );
  });

  it("declares the telemetry version once any item carries telemetry", () => {
    const parts = prepareAgentComponentInvocationSyncParts(
      completeGeneration([
        invocation("invocation-1", 0),
        { ...invocation("invocation-2", 1), footprintTokens: 512 },
      ])
    );

    assert.equal(
      parts[0]?.protocolVersion,
      AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION
    );
  });

  it("keeps a telemetry-free generation byte-identical to the pre-change wire", () => {
    const [part] = prepareAgentComponentInvocationSyncParts(
      completeGeneration([invocation("invocation-1", 0)])
    );

    assert.equal(JSON.parse(JSON.stringify(part)).protocolVersion, 1);
  });

  /**
   * ISS-4976 (@wongk T4): the producer runs the SAME shared ingest boundary the
   * cloud runs, so a part the cloud would 400 is rejected here instead of being
   * queued for five identical round trips ending in a dead-letter.
   */
  it("rejects a part the shared ingest boundary would reject", () => {
    assert.throws(
      () =>
        prepareAgentComponentInvocationSyncParts(
          completeGeneration([
            // Subagent-only usage on a tool invocation: forbidden by both Prisma
            // schemas and by the shared boundary.
            { ...invocation("invocation-1", 0), inputTokens: 10 },
          ])
        ),
      AgentComponentInvocationSyncPayloadContractError
    );
  });
});
