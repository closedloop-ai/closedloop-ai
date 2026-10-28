import { createHash } from "node:crypto";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncItem,
  type AgentComponentInvocationSyncPart,
  type AgentComponentInvocationSyncPartWithoutHash,
  AgentComponentInvocationUsageMeasurement,
  agentComponentInvocationSyncPartHashPreimage,
} from "@repo/api/src/types/agent-component-invocation";
import {
  agentComponentInvocationSyncBatchSchema,
  canonicalizeAgentComponentInvocationSyncItem,
  canonicalizeAgentComponentInvocationSyncString,
} from "@repo/api/src/types/agent-component-invocation-schema";
import { describe, expect, it } from "vitest";
import { hasValidPartHash } from "@/app/agent-sessions/service/component-invocation-helpers";

/**
 * ISS-6889. The server verifies `partHash` against the object the shared schema
 * PARSED, and that schema trims. These drive the real `hasValidPartHash` over a
 * batch parsed exactly as `route.ts` parses it, so what is asserted here is the
 * verdict production reaches: reject the pre-canonical hash a Desktop build
 * before this change signed, accept the canonical one. Content binding is
 * covered where it is mutated, in the producer's own suite.
 */
describe("component invocation part hash canonicalization", () => {
  it("rejects a padded part hashed before canonicalization", () => {
    const part = signedPart(paddedItems(), { canonicalize: false });

    expect(hasValidPartHash(ingest(part))).toBe(false);
  });

  it("accepts the same padded part hashed after canonicalization", () => {
    const part = signedPart(paddedItems(), { canonicalize: true });

    expect(hasValidPartHash(ingest(part))).toBe(true);
  });

  // ISS-9174 added rejecting refines to every string and timestamp family of
  // this schema. This is the case that would catch one of them written as a
  // transform or a trim instead: a canonical part carrying every string field,
  // an anchor, and all four timestamps must come back from the boundary
  // byte-identical, and its producer-signed hash must still verify.
  it("hands back a canonical part carrying every field unchanged, hash intact", () => {
    const part = signedPart(everyFieldItems(), {
      canonicalize: true,
      protocolVersion:
        AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
    });

    const ingested = ingest(part);

    expect(ingested).toEqual(part);
    expect(hasValidPartHash(ingested)).toBe(true);
  });
});

/** What `route.ts` hands the service: the batch parsed by the shared boundary. */
function ingest(
  part: AgentComponentInvocationSyncPart
): AgentComponentInvocationSyncPart {
  const parsed = agentComponentInvocationSyncBatchSchema.parse(
    JSON.parse(
      JSON.stringify({
        protocolVersion: part.protocolVersion,
        parts: [part],
      })
    )
  );
  const [first] = parsed.parts;
  if (!first) {
    throw new Error("parsed batch carried no part");
  }
  return first;
}

function signedPart(
  items: AgentComponentInvocationSyncItem[],
  options: {
    canonicalize: boolean;
    protocolVersion?: AgentComponentInvocationSyncPart["protocolVersion"];
  }
): AgentComponentInvocationSyncPart {
  const withoutHash: AgentComponentInvocationSyncPartWithoutHash = {
    protocolVersion:
      options.protocolVersion ??
      AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    externalSessionId: options.canonicalize
      ? canonicalizeAgentComponentInvocationSyncString(PADDED_SESSION_ID)
      : PADDED_SESSION_ID,
    externalGenerationId: "b".repeat(64),
    sourceUpdatedAt: "2026-08-16T12:00:00.000Z",
    dataRevision: 4,
    sourceSequence: 1,
    partIndex: 0,
    partCount: 1,
    items: options.canonicalize
      ? items.map(canonicalizeAgentComponentInvocationSyncItem)
      : items,
  };
  return {
    ...withoutHash,
    partHash: createHash("sha256")
      .update(agentComponentInvocationSyncPartHashPreimage(withoutHash))
      .digest("hex"),
  };
}

function paddedItems(): AgentComponentInvocationSyncItem[] {
  return [
    {
      externalInvocationId: "invocation-1",
      sourceSessionId: PADDED_SESSION_ID,
      kind: AgentComponentInvocationKind.Tool,
      componentKey: "  copilot_tool  ",
      rawName: "  copilot_tool  ",
      relationship: AgentComponentInvocationRelationship.Direct,
      invokedAt: "2026-08-16T12:00:00.000Z",
      sequence: 0,
      anchor: {
        kind: AgentComponentInvocationAnchorKind.Event,
        eventId: "event-1",
      },
      status: AgentComponentInvocationAttributionStatus.Unresolved,
      evidenceClass: AgentComponentInvocationEvidenceClass.None,
    },
  ];
}

const PADDED_SESSION_ID = "  session-1  ";

/**
 * A skill invocation carrying every string field, an anchor with both strings,
 * the three item timestamps (the part supplies `sourceUpdatedAt`) and the full
 * telemetry set. Skill because the provenance
 * fields are refused on tool-kind items and the telemetry on non-usage-bearing
 * kinds; `matched` because that status is what makes `definitionHash` and
 * `normalizerContractVersion` legal. Already canonical: nothing here trims.
 */
function everyFieldItems(): AgentComponentInvocationSyncItem[] {
  return [
    {
      externalInvocationId: "invocation-1",
      sourceSessionId:
        canonicalizeAgentComponentInvocationSyncString(PADDED_SESSION_ID),
      childSessionId: "child-session-1",
      parentExternalInvocationId: "invocation-0",
      externalAgentId: "agent-1",
      kind: AgentComponentInvocationKind.Skill,
      componentKey: "commit",
      rawName: "commit",
      normalizedName: "commit",
      relationship: AgentComponentInvocationRelationship.Direct,
      invokedAt: "2026-08-16T12:00:00.000Z",
      sequence: 0,
      anchor: {
        kind: AgentComponentInvocationAnchorKind.Event,
        eventId: "event-1",
        providerToolUseId: "toolu_1",
      },
      providerInvocationId: "toolu_1",
      status: AgentComponentInvocationAttributionStatus.Matched,
      evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
      definitionHash: "d".repeat(64),
      normalizerContractVersion: 1,
      definitionContent: "---\nname: commit\n---\nCommit the staged changes.",
      definitionFormat: "markdown",
      sourcePath: ".claude/skills/commit/SKILL.md",
      sourceModifiedAt: "2026-08-16T11:00:00.000Z",
      capturedAt: "2026-08-16T12:00:00.000Z",
      repositoryFullName: "closedloop-ai/closedloop-ai",
      repositoryCommit: "e".repeat(40),
      packId: "pack-1",
      branchName: "feat/iss-9174",
      model: "claude-opus-5",
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      estimatedCost: 0.1255,
      footprintTokens: 4096,
      usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
    },
  ];
}
