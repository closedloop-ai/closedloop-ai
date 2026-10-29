import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import {
  AGENT_COMPONENT_INVOCATION_DEFINITION_CONTENT_MAX_BYTES,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_PARTS,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_BYTES,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_ITEMS,
  AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  type AgentComponentInvocationCompleteGeneration,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncItem,
  type AgentComponentInvocationSyncPart,
  AgentComponentInvocationUsageMeasurement,
  agentComponentInvocationGenerationHashPreimage,
  agentComponentInvocationSyncPartHashPreimage,
} from "@repo/api/src/types/agent-component-invocation";
import { agentComponentInvocationSyncBatchSchema } from "@repo/api/src/types/agent-component-invocation-schema";
import { NUL_CHARACTER } from "@repo/api/src/types/postgres-text";
import {
  SYNTHETIC_GITHUB_TOKEN,
  SYNTHETIC_GOOGLE_TOKEN,
} from "@repo/lib/security/synthetic-secrets.test-helpers";
import { describe, it } from "vitest";
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

describe("ISS-4965: definition content is secret-redacted at egress", () => {
  it("ships redacted content fingerprinted as the redacted bytes", () => {
    const raw = `# Deploy\nexport TOKEN=${SYNTHETIC_GITHUB_TOKEN}\n`;
    const redacted = "# Deploy\nexport TOKEN=[REDACTED:ghp]\n";
    const parts = prepareAgentComponentInvocationSyncParts(
      completeGeneration([definitionInvocation(raw)])
    );

    const [shipped] = parts[0].items;
    assert.equal(shipped.definitionContent, redacted);
    assert.equal(
      shipped.definitionHash,
      computeDefinitionHash({
        body: redacted,
        kind: AgentComponentInvocationKind.Skill,
      }).definitionHash
    );
    assert.ok(!JSON.stringify(parts).includes(SYNTHETIC_GITHUB_TOKEN));
  });

  it("leaves clean content and its fingerprint untouched, with no marker", () => {
    const clean = "# Deploy\nRun the release script.\n";
    const item = definitionInvocation(clean);
    const parts = prepareAgentComponentInvocationSyncParts(
      completeGeneration([item])
    );

    const [shipped] = parts[0].items;
    assert.equal(shipped.definitionContent, clean);
    assert.equal(shipped.definitionHash, item.definitionHash);
    assert.ok(!JSON.stringify(parts).includes("[REDACTED:"));
  });

  it("applies the content cap to the redacted bytes, not the raw ones", () => {
    const tail = ` ${SYNTHETIC_GOOGLE_TOKEN}`;
    const raw = `${"x".repeat(
      AGENT_COMPONENT_INVOCATION_DEFINITION_CONTENT_MAX_BYTES - tail.length
    )}${tail}`;
    // Inside the cap raw; the marker outgrows the token and pushes it past.
    assert.equal(
      new TextEncoder().encode(raw).byteLength,
      AGENT_COMPONENT_INVOCATION_DEFINITION_CONTENT_MAX_BYTES
    );

    const parts = prepareAgentComponentInvocationSyncParts(
      completeGeneration([definitionInvocation(raw)])
    );

    const [shipped] = parts[0].items;
    assert.ok(!("definitionContent" in shipped));
    assert.equal(
      shipped.definitionHash,
      computeDefinitionHash({
        body: raw.replace(
          SYNTHETIC_GOOGLE_TOKEN,
          "[REDACTED:google_oauth_token]"
        ),
        kind: AgentComponentInvocationKind.Skill,
      }).definitionHash
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
 * ISS-4976 (@whitlockk T5 / @closedloop-ai-stage T1): a Desktop build shipping
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

  it("declares the measurement version once any item carries a label", () => {
    const parts = prepareAgentComponentInvocationSyncParts(
      completeGeneration([
        invocation("invocation-1", 0),
        {
          ...invocation("invocation-2", 1),
          footprintTokens: 512,
          usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
        },
      ])
    );

    // ISS-7795: telemetry now always carries its measurement label, and the
    // label is a field an API predating it rejects as an unknown key — so the
    // part must clear a version gate that API already has, not v2's.
    assert.equal(
      parts[0]?.protocolVersion,
      AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION
    );
  });

  it("keeps a telemetry-free generation byte-identical to the pre-change wire", () => {
    const [part] = prepareAgentComponentInvocationSyncParts(
      completeGeneration([invocation("invocation-1", 0)])
    );

    assert.equal(JSON.parse(JSON.stringify(part)).protocolVersion, 1);
  });

  /**
   * ISS-4976 (@whitlockk T4): the producer runs the SAME shared ingest boundary the
   * cloud runs, so a part the cloud would 400 is rejected here instead of being
   * queued for five identical round trips ending in a dead-letter.
   */
  it("rejects a part the shared ingest boundary would reject", () => {
    assert.throws(
      () =>
        prepareAgentComponentInvocationSyncParts(
          completeGeneration([
            // Subagent-only usage on a tool invocation: forbidden by both Prisma
            // schemas and by the shared boundary. ISS-7795 supplies the
            // measurement label so the kind gate stays the only rule tripped.
            {
              ...invocation("invocation-1", 0),
              inputTokens: 10,
              usageMeasurement:
                AgentComponentInvocationUsageMeasurement.Measured,
            },
          ])
        ),
      AgentComponentInvocationSyncPayloadContractError
    );
  });
});

/**
 * ISS-6889. The shared wire schema TRIMS every contract string, so a padded
 * field is hashed by the producer BEFORE the trim and by the API AFTER it. The
 * two hashes are then over different bytes, `hasValidPartHash` can never agree,
 * and the whole generation dead-letters as a permanent `validation_failed`.
 * These drive the real producer and the real ingest schema the route parses
 * with, so nothing here can pass by hashing both sides with one helper.
 */
describe("invocation sync hash canonicalization", () => {
  it("hashes the bytes the API verifies when an item field carries padding", () => {
    const [part] = prepareAgentComponentInvocationSyncParts(
      completeGeneration([paddedInvocation("padded-item", 0)])
    );

    const verified = hashesTheApiVerifies(part);

    assert.equal(verified.partHash, part.partHash);
    assert.equal(verified.generationId, part.externalGenerationId);
  });

  it("hashes the bytes the API verifies when the session id carries padding", () => {
    const [part] = prepareAgentComponentInvocationSyncParts(
      paddedSessionGeneration()
    );

    const verified = hashesTheApiVerifies(part);

    assert.equal(verified.partHash, part.partHash);
    assert.equal(verified.generationId, part.externalGenerationId);
  });

  it("canonicalizes padding away instead of hashing it", () => {
    const [padded] = prepareAgentComponentInvocationSyncParts(
      completeGeneration([paddedInvocation("padded-item", 0)])
    );
    const [trimmed] = prepareAgentComponentInvocationSyncParts(
      completeGeneration([
        {
          ...paddedInvocation("padded-item", 0),
          componentKey: "copilot_tool",
          rawName: "copilot_tool",
        },
      ])
    );

    assert.equal(padded.partHash, trimmed.partHash);
    assert.equal(padded.externalGenerationId, trimmed.externalGenerationId);
  });

  it("still hashes genuinely different content differently", () => {
    const [padded] = prepareAgentComponentInvocationSyncParts(
      completeGeneration([paddedInvocation("padded-item", 0)])
    );
    const [other] = prepareAgentComponentInvocationSyncParts(
      completeGeneration([
        { ...paddedInvocation("padded-item", 0), componentKey: "  Write  " },
      ])
    );

    assert.notEqual(padded.partHash, other.partHash);
    assert.notEqual(padded.externalGenerationId, other.externalGenerationId);
  });

  /**
   * The one rejection the producer CURES. The item schema refuses oversized
   * `definitionContent`, so canonicalizing before `omitOversizedDefinitionContent`
   * left exactly these items untrimmed while the very next step made them valid
   * — a part that ships and can never verify.
   */
  it("hashes the bytes the API verifies when oversized content is omitted", () => {
    const [part] = prepareAgentComponentInvocationSyncParts(
      completeGeneration([omittedContentInvocation()])
    );

    const verified = hashesTheApiVerifies(part);

    assert.ok(!("definitionContent" in part.items[0]));
    assert.equal(verified.partHash, part.partHash);
    assert.equal(verified.generationId, part.externalGenerationId);
  });

  /**
   * A string the boundary rejects outright is returned uncanonicalized on
   * purpose, so the producer's own contract check still names the real field
   * instead of a canonicalization error that names nothing.
   */
  it("reports the failing field for a value canonicalization cannot rescue", () => {
    assert.throws(
      () =>
        prepareAgentComponentInvocationSyncParts(
          completeGeneration([
            { ...invocation("blank-key", 0), componentKey: "   " },
          ])
        ),
      (error: unknown) =>
        error instanceof AgentComponentInvocationSyncPayloadContractError &&
        error.message.includes("componentKey")
    );
  });

  it("ISS-9174: rejects a NUL the cloud write would refuse, naming the field", () => {
    // Before the shared boundary carried this refine, the part shipped, failed
    // inside the cloud transaction, and came back as a transient retry forever.
    assert.throws(
      () =>
        prepareAgentComponentInvocationSyncParts(
          completeGeneration([
            { ...invocation("nul-name", 0), rawName: `Re${NUL_CHARACTER}ad` },
          ])
        ),
      (error: unknown) =>
        error instanceof AgentComponentInvocationSyncPayloadContractError &&
        error.message.includes("rawName")
    );
  });
});

/**
 * Re-derive both hashes from the object the API actually verifies: the batch the
 * Desktop client POSTs, parsed by the shared ingest schema exactly as
 * `/desktop/agent-sessions/invocations/sync` parses it, then hashed with the
 * same shared preimages `hasValidPartHash` and the generation reconciliation use.
 */
function hashesTheApiVerifies(part: AgentComponentInvocationSyncPart): {
  partHash: string;
  generationId: string;
} {
  const parsed = agentComponentInvocationSyncBatchSchema.parse(
    JSON.parse(
      JSON.stringify({ protocolVersion: part.protocolVersion, parts: [part] })
    )
  );
  const serverPart = parsed.parts[0];
  const { partHash: _partHash, ...withoutHash } = serverPart;

  return {
    partHash: createHash("sha256")
      .update(agentComponentInvocationSyncPartHashPreimage(withoutHash))
      .digest("hex"),
    generationId: createHash("sha256")
      .update(
        agentComponentInvocationGenerationHashPreimage({
          externalSessionId: serverPart.externalSessionId,
          items: serverPart.items,
        })
      )
      .digest("hex"),
  };
}

/**
 * A Copilot-shaped tool name that reaches the producer with surrounding
 * whitespace. Padding is spread across a required field, an optional one, and a
 * nested anchor field, because every one of them is the same trimming
 * `nonEmptyStringSchema` and any single one of them re-breaks the hash.
 */
function paddedInvocation(
  externalInvocationId: string,
  sequence: number
): AgentComponentInvocationSyncItem {
  return {
    ...invocation(externalInvocationId, sequence),
    componentKey: "  copilot_tool  ",
    rawName: "  copilot_tool  ",
    normalizedName: "  copilot_tool  ",
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: `  event-${externalInvocationId}  `,
    },
  };
}

/** Padded strings on an item whose oversized definition content is stripped before the wire. */
function omittedContentInvocation(): AgentComponentInvocationSyncItem {
  return {
    ...paddedInvocation("omitted-content", 0),
    kind: AgentComponentInvocationKind.Skill,
    status: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    definitionHash: "a".repeat(64),
    normalizerContractVersion: 1,
    sourcePath: "  .claude/skills/copilot.md  ",
    definitionContent: "x".repeat(
      AGENT_COMPONENT_INVOCATION_DEFINITION_CONTENT_MAX_BYTES + 1
    ),
  };
}

function paddedSessionGeneration(): AgentComponentInvocationCompleteGeneration {
  const externalSessionId = "  session-1  ";
  const items = [
    { ...invocation("padded-session", 0), sourceSessionId: externalSessionId },
  ];
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

function definitionInvocation(
  content: string
): AgentComponentInvocationSyncItem {
  return {
    ...invocation("definition", 0),
    kind: AgentComponentInvocationKind.Skill,
    componentKey: "deploy",
    status: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    definitionContent: content,
    ...computeDefinitionHash({
      body: content,
      kind: AgentComponentInvocationKind.Skill,
    }),
  };
}
