import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_LINES_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_OTEL_EVIDENCE_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_SUCCEEDED_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionSource,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationUsageMeasurement,
} from "./agent-component-invocation.ts";
import {
  item,
  part,
} from "./agent-component-invocation-schema.test-helpers.ts";
import {
  agentComponentInvocationSyncBatchSchema,
  agentComponentInvocationSyncItemSchema,
  agentComponentInvocationSyncPartSchema,
  canonicalizeAgentComponentInvocationSyncItem,
  canonicalizeAgentComponentInvocationSyncString,
  supportedProtocolVersionAsParsed,
} from "./agent-component-invocation-schema.ts";

function issueMessages(result: {
  success: boolean;
  error?: { issues: readonly { message: string }[] };
}): string[] {
  return result.success
    ? []
    : (result.error?.issues ?? []).map((i) => i.message);
}

describe("agentComponentInvocationSyncItemSchema", () => {
  it("accepts a minimal valid tool item", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse(
      item("inv-1")
    );
    expect(result.success).toBe(true);
  });

  it("rejects an unknown key (.strict())", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      unknownField: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects definitionContent over the byte ceiling", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      definitionContent: "a".repeat(98_305),
    });
    expect(issueMessages(result)).toContain("definition_content_too_large");
  });

  it("accepts definitionContent at the byte ceiling", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Skill,
      definitionContent: "a".repeat(98_304),
    });
    expect(result.success).toBe(true);
  });

  it("rejects subagent-usage fields on a non-usage-bearing kind", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Tool,
      model: "claude-opus-4-5",
    });
    expect(issueMessages(result)).toContain(
      "subagent_usage_requires_subagent_kind"
    );
  });

  it("accepts subagent-usage fields on a usage-bearing kind", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Subagent,
      model: "claude-opus-4-5",
      inputTokens: 10,
      usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
    });
    expect(result.success).toBe(true);
  });

  it("rejects lines on a non-line-bearing kind", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Skill,
      linesAdded: 1,
      linesRemoved: 0,
    });
    expect(issueMessages(result)).toContain("lines_require_line_bearing_kind");
  });

  it("accepts lines on a line-bearing kind", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Tool,
      linesAdded: 3,
      linesRemoved: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a half-populated line pair (linesAdded without linesRemoved)", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Tool,
      linesAdded: 3,
    });
    expect(issueMessages(result)).toContain("lines_require_both_halves");
  });

  it("rejects a half-populated line pair (linesRemoved without linesAdded)", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Tool,
      linesRemoved: 3,
    });
    expect(issueMessages(result)).toContain("lines_require_both_halves");
  });

  it("rejects succeeded on a kind with no adjudicator", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Subagent,
      succeeded: true,
    });
    expect(issueMessages(result)).toContain(
      "succeeded_requires_success_bearing_kind"
    );
  });

  it("accepts succeeded on a success-bearing (hook) kind", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Hook,
      succeeded: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects usageMeasurement with no telemetry present", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Subagent,
      usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
    });
    expect(issueMessages(result)).toContain(
      "usage_measurement_requires_telemetry"
    );
  });

  it("rejects a non-definition kind (tool/mcp/orchestration) with a non-unresolved status", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Mcp,
      status: AgentComponentInvocationAttributionStatus.Matched,
      definitionHash: "a".repeat(64),
      normalizerContractVersion: 1,
    });
    expect(issueMessages(result)).toContain(
      "non_definition_kind_must_be_unresolved"
    );
  });

  it("rejects a non-definition kind carrying provenance evidence", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Orchestration,
      packId: "pack-1",
    });
    expect(issueMessages(result)).toContain(
      "non_definition_kind_has_provenance_evidence"
    );
  });

  it("accepts a definition-bearing kind carrying provenance evidence", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Skill,
      packId: "pack-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a findings pair missing findingsEmitted", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      findingsInvalidated: 1,
    });
    expect(issueMessages(result)).toContain("findings_pair_incomplete");
  });

  it("rejects a findings pair missing findingsInvalidated", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      findingsEmitted: 1,
    });
    expect(issueMessages(result)).toContain("findings_pair_incomplete");
  });

  it("rejects a findings pair where invalidated exceeds emitted", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      findingsEmitted: 1,
      findingsInvalidated: 2,
    });
    expect(issueMessages(result)).toContain(
      "findings_invalidated_exceeds_emitted"
    );
  });

  it("accepts a complete, valid findings pair", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      findingsEmitted: 3,
      findingsInvalidated: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an item with neither findings field", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse(
      item("inv-1")
    );
    expect(result.success).toBe(true);
  });

  it("rejects a matched status missing definitionHash/normalizerContractVersion", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Skill,
      status: AgentComponentInvocationAttributionStatus.Matched,
    });
    expect(issueMessages(result)).toContain(
      "matched_invocation_missing_version"
    );
  });

  it("accepts a matched status with both definitionHash and normalizerContractVersion", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Skill,
      status: AgentComponentInvocationAttributionStatus.Matched,
      definitionHash: "a".repeat(64),
      normalizerContractVersion: 1,
    });
    expect(result.success).toBe(true);
  });

  it("trims a leading/trailing-whitespace componentKey (canonicalization)", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      componentKey: "  Read  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.componentKey).toBe("Read");
    }
  });

  it("rejects a string containing a NUL character", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      componentKey: `Read${"\u0000"}`,
    });
    expect(result.success).toBe(false);
  });

  it("accepts each anchor kind", () => {
    const anchors = [
      {
        kind: AgentComponentInvocationAnchorKind.Event,
        eventId: "e1",
      },
      {
        kind: AgentComponentInvocationAnchorKind.Agent,
        agentId: "a1",
      },
      {
        kind: AgentComponentInvocationAnchorKind.UserTurn,
        userTurnId: "u1",
      },
      {
        kind: AgentComponentInvocationAnchorKind.Timestamp,
        timestamp: "2026-07-22T16:00:00.000Z",
        ordinal: 0,
      },
      { kind: AgentComponentInvocationAnchorKind.Session },
    ];
    for (const anchor of anchors) {
      const result = agentComponentInvocationSyncItemSchema.safeParse({
        ...item("inv-1"),
        anchor,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an anchor with an unknown extra field (.strict() per variant)", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      anchor: {
        kind: AgentComponentInvocationAnchorKind.Event,
        eventId: "e1",
        extra: "nope",
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an OTel-evidence item carrying attributionSource", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Skill,
      evidenceClass: AgentComponentInvocationEvidenceClass.OtelCounter,
      attributionSource: AgentComponentInvocationAttributionSource.HarnessOtel,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a cost that would round on write (non-canonical scale)", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Subagent,
      estimatedCost: 0.123_456_7,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a fractional line count", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Tool,
      linesAdded: 1.5,
      linesRemoved: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an item whose serialized size exceeds the item byte ceiling", () => {
    const result = agentComponentInvocationSyncItemSchema.safeParse({
      ...item("inv-1"),
      definitionContent: "a".repeat(98_304),
      rawName: "b".repeat(60_000),
    });
    expect(issueMessages(result)).toContain("item_too_large");
  });
});

describe("agentComponentInvocationSyncPartSchema", () => {
  it("accepts a minimal valid part", () => {
    const result = agentComponentInvocationSyncPartSchema.safeParse(
      part([item("inv-1")])
    );
    expect(result.success).toBe(true);
  });

  it("rejects partIndex >= partCount", () => {
    const result = agentComponentInvocationSyncPartSchema.safeParse({
      ...part([item("inv-1")]),
      partIndex: 1,
      partCount: 1,
    });
    expect(issueMessages(result)).toContain("part_index_out_of_range");
  });

  it("rejects zero items with partCount other than 1", () => {
    const result = agentComponentInvocationSyncPartSchema.safeParse({
      ...part([]),
      partCount: 2,
    });
    expect(issueMessages(result)).toContain(
      "empty_generation_must_have_one_part"
    );
  });

  it("accepts zero items with partCount 1", () => {
    const result = agentComponentInvocationSyncPartSchema.safeParse(part([]));
    expect(result.success).toBe(true);
  });

  it("rejects an item whose sourceSessionId disagrees with the part's externalSessionId", () => {
    const result = agentComponentInvocationSyncPartSchema.safeParse({
      ...part([{ ...item("inv-1"), sourceSessionId: "other-session" }]),
    });
    expect(issueMessages(result)).toContain("item_session_mismatch");
  });

  it("rejects a telemetry-carrying item declared at v1", () => {
    const result = agentComponentInvocationSyncPartSchema.safeParse({
      ...part([
        {
          ...item("inv-1"),
          kind: AgentComponentInvocationKind.Subagent,
          model: "claude-opus-4-5",
        },
      ]),
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    });
    expect(issueMessages(result)).toContain(
      "telemetry_requires_protocol_version"
    );
  });

  it("accepts a telemetry-carrying item declared at v2", () => {
    const result = agentComponentInvocationSyncPartSchema.safeParse({
      ...part([
        {
          ...item("inv-1"),
          kind: AgentComponentInvocationKind.Subagent,
          model: "claude-opus-4-5",
        },
      ]),
      protocolVersion:
        AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unlabelled telemetry item on a part declared at the measurement version", () => {
    const result = agentComponentInvocationSyncPartSchema.safeParse({
      ...part([
        {
          ...item("inv-1"),
          kind: AgentComponentInvocationKind.Subagent,
          model: "claude-opus-4-5",
        },
      ]),
      protocolVersion:
        AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
    });
    expect(issueMessages(result)).toContain(
      "telemetry_requires_usage_measurement"
    );
  });

  it("accepts a labelled telemetry item on a part declared at the measurement version", () => {
    const result = agentComponentInvocationSyncPartSchema.safeParse({
      ...part([
        {
          ...item("inv-1"),
          kind: AgentComponentInvocationKind.Subagent,
          model: "claude-opus-4-5",
          usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
        },
      ]),
      protocolVersion:
        AGENT_COMPONENT_INVOCATION_SYNC_MEASUREMENT_PROTOCOL_VERSION,
    });
    expect(result.success).toBe(true);
  });

  it("needs no usage label on a hook-only part declared at the succeeded version", () => {
    const result = agentComponentInvocationSyncPartSchema.safeParse({
      ...part([
        {
          ...item("inv-1"),
          kind: AgentComponentInvocationKind.Hook,
          succeeded: true,
        },
      ]),
      protocolVersion:
        AGENT_COMPONENT_INVOCATION_SYNC_SUCCEEDED_PROTOCOL_VERSION,
    });
    expect(result.success).toBe(true);
  });

  it("rejects duplicate externalInvocationId within a part", () => {
    const result = agentComponentInvocationSyncPartSchema.safeParse(
      part([item("dup"), item("dup")])
    );
    expect(issueMessages(result)).toContain("duplicate_invocation_id_in_part");
  });

  it("rejects a part whose serialized size exceeds the part byte ceiling", () => {
    const bigItems = Array.from({ length: 60 }, (_, i) => ({
      ...item(`inv-${i}`),
      kind: AgentComponentInvocationKind.Skill,
      definitionContent: "a".repeat(9000),
    }));
    const result = agentComponentInvocationSyncPartSchema.safeParse(
      part(bigItems)
    );
    expect(issueMessages(result)).toContain("part_too_large");
  });

  it("rejects more items than the max part items ceiling", () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => item(`inv-${i}`));
    const result = agentComponentInvocationSyncPartSchema.safeParse(
      part(tooMany)
    );
    expect(result.success).toBe(false);
  });

  it("requires the lines protocol version once an item carries lines", () => {
    const result = agentComponentInvocationSyncPartSchema.safeParse({
      ...part([
        {
          ...item("inv-1"),
          kind: AgentComponentInvocationKind.Tool,
          linesAdded: 1,
          linesRemoved: 0,
        },
      ]),
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    });
    expect(issueMessages(result)).toContain(
      "telemetry_requires_protocol_version"
    );
  });

  it("accepts an item carrying lines when the part declares the lines protocol version", () => {
    const result = agentComponentInvocationSyncPartSchema.safeParse({
      ...part([
        {
          ...item("inv-1"),
          kind: AgentComponentInvocationKind.Tool,
          linesAdded: 1,
          linesRemoved: 0,
        },
      ]),
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_LINES_PROTOCOL_VERSION,
    });
    expect(result.success).toBe(true);
  });

  it("requires the otel-evidence protocol version for an attributionSource item", () => {
    const result = agentComponentInvocationSyncPartSchema.safeParse({
      ...part([
        {
          ...item("inv-1"),
          evidenceClass: AgentComponentInvocationEvidenceClass.OtelCounter,
          attributionSource:
            AgentComponentInvocationAttributionSource.HarnessOtel,
        },
      ]),
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    });
    expect(issueMessages(result)).toContain(
      "telemetry_requires_protocol_version"
    );
  });

  it("accepts an attributionSource item at the otel-evidence protocol version", () => {
    const result = agentComponentInvocationSyncPartSchema.safeParse({
      ...part([
        {
          ...item("inv-1"),
          kind: AgentComponentInvocationKind.Skill,
          evidenceClass: AgentComponentInvocationEvidenceClass.OtelCounter,
          attributionSource:
            AgentComponentInvocationAttributionSource.HarnessOtel,
        },
      ]),
      protocolVersion:
        AGENT_COMPONENT_INVOCATION_SYNC_OTEL_EVIDENCE_PROTOCOL_VERSION,
    });
    expect(result.success).toBe(true);
  });
});

describe("agentComponentInvocationSyncBatchSchema", () => {
  it("accepts a minimal valid batch", () => {
    const result = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [part([item("inv-1")])],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a batch whose part protocol version disagrees with the envelope", () => {
    const result = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion:
        AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
      parts: [
        {
          ...part([item("inv-1")]),
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        },
      ],
    });
    expect(issueMessages(result)).toContain(
      "batch_part_protocol_version_mismatch"
    );
  });

  it("rejects a batch with other than exactly one part", () => {
    const result = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("supportedProtocolVersionAsParsed", () => {
  it("returns the version unchanged", () => {
    expect(
      supportedProtocolVersionAsParsed(
        AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION
      )
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION);
  });
});

describe("canonicalizeAgentComponentInvocationSyncItem", () => {
  it("trims a canonicalizable field", () => {
    const canonicalized = canonicalizeAgentComponentInvocationSyncItem({
      ...item("inv-1"),
      componentKey: "  Read  ",
    } as unknown as Parameters<
      typeof canonicalizeAgentComponentInvocationSyncItem
    >[0]);
    expect(canonicalized.componentKey).toBe("Read");
  });

  it("returns the input unchanged when it fails to parse", () => {
    const invalid = {
      ...item("inv-1"),
      kind: AgentComponentInvocationKind.Subagent,
      succeeded: true,
    } as unknown as Parameters<
      typeof canonicalizeAgentComponentInvocationSyncItem
    >[0];
    expect(canonicalizeAgentComponentInvocationSyncItem(invalid)).toBe(invalid);
  });
});

describe("canonicalizeAgentComponentInvocationSyncString", () => {
  it("trims a value that parses", () => {
    expect(canonicalizeAgentComponentInvocationSyncString("  Read  ")).toBe(
      "Read"
    );
  });

  it("returns the value unchanged when it fails to parse (empty string)", () => {
    expect(canonicalizeAgentComponentInvocationSyncString("")).toBe("");
  });
});
