import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  agentComponentInvocationSyncProtocolVersionForItems,
} from "../agent-component-invocation.ts";
import { agentComponentInvocationSyncBatchSchema } from "../agent-component-invocation-schema.ts";

describe("agent component invocation sync schema", () => {
  it("accepts a dedicated empty complete generation independently of session v2", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [part([])],
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts branch context on an unresolved non-versionable occurrence", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [
        part([
          {
            ...item("invocation-1"),
            repositoryFullName: "closedloop-ai/symphony-alpha",
            branchName: "feat/fea-3294",
          },
        ]),
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts an additive transcript file identity on agent anchors", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [
        part([
          {
            ...item("invocation-1"),
            anchor: {
              kind: AgentComponentInvocationAnchorKind.Agent,
              agentId: "local-agent-1",
              externalAgentId: "provider-agent-1",
              transcriptFileId: "agent-transcript-1",
            },
          },
        ]),
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects version attribution on tool, MCP, and orchestration occurrences", () => {
    for (const kind of [
      AgentComponentInvocationKind.Tool,
      AgentComponentInvocationKind.Mcp,
      AgentComponentInvocationKind.Orchestration,
    ]) {
      const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        parts: [
          part([
            {
              ...item("invocation-1"),
              kind,
              status: AgentComponentInvocationAttributionStatus.Matched,
              definitionHash: "b".repeat(64),
              normalizerContractVersion: 1,
            },
          ]),
        ],
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("rejects all provenance evidence on non-versionable occurrences", () => {
    const provenanceFields: Record<string, unknown>[] = [
      {
        evidenceClass: AgentComponentInvocationEvidenceClass.CollectorSnapshot,
      },
      { definitionHash: "b".repeat(64) },
      { normalizerContractVersion: 1 },
      { definitionContent: "definition" },
      { definitionFormat: "markdown" },
      { sourcePath: "skills/review/SKILL.md" },
      { sourceModifiedAt: "2026-07-22T15:59:00.000Z" },
      { capturedAt: "2026-07-22T16:00:01.000Z" },
      { repositoryCommit: "abc123" },
      { packId: "pack-1" },
    ];

    for (const kind of [
      AgentComponentInvocationKind.Tool,
      AgentComponentInvocationKind.Mcp,
      AgentComponentInvocationKind.Orchestration,
    ]) {
      for (const provenance of provenanceFields) {
        const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          parts: [
            part([
              {
                ...item("invocation-1"),
                ...provenance,
                kind,
              },
            ]),
          ],
        });

        expect(parsed.success).toBe(false);
      }
    }
  });

  it("rejects null optional fields and duplicate invocation ids", () => {
    const withNull = {
      ...item("invocation-1"),
      childSessionId: null,
    };
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        parts: [part([withNull])],
      }).success
    ).toBe(false);

    const duplicate = item("same");
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        parts: [part([duplicate, duplicate])],
      }).success
    ).toBe(false);
  });

  it("rejects an empty part inside a multipart generation", () => {
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        parts: [{ ...part([]), partCount: 2 }],
      }).success
    ).toBe(false);
  });

  it("rejects multiple independently acknowledged parts in one request", () => {
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        parts: [part([]), part([])],
      }).success
    ).toBe(false);
  });

  it("rejects subagent-only usage on a non-subagent kind and keeps footprint kind-agnostic", () => {
    const usageFields = [
      { model: "claude-opus-4" },
      { inputTokens: 10 },
      { outputTokens: 10 },
      { cacheReadTokens: 10 },
      { cacheWriteTokens: 10 },
      { estimatedCost: 0.5 },
    ];

    for (const usage of usageFields) {
      const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion:
          AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
        parts: [telemetryPart([{ ...item("invocation-1"), ...usage }])],
      });

      expect(parsed.success).toBe(false);
    }

    // footprintTokens is the kind-agnostic context-footprint metric.
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion:
          AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
        parts: [
          telemetryPart([{ ...item("invocation-1"), footprintTokens: 512 }]),
        ],
      }).success
    ).toBe(true);
  });

  it("accepts subagent-turn usage on a subagent invocation", () => {
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion:
          AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
        parts: [
          telemetryPart([
            {
              ...item("invocation-1"),
              kind: AgentComponentInvocationKind.Subagent,
              inputTokens: 100,
              outputTokens: 20,
              estimatedCost: 0.1255,
              model: "claude-opus-4",
            },
          ]),
        ],
      }).success
    ).toBe(true);
  });

  it("rejects telemetry declared under the telemetry-free protocol version", () => {
    const parsed = agentComponentInvocationSyncBatchSchema.safeParse({
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      parts: [part([{ ...item("invocation-1"), footprintTokens: 512 }])],
    });

    expect(parsed.success).toBe(false);
    expect(
      parsed.error?.issues.some(
        (issue) => issue.message === "telemetry_requires_protocol_version"
      )
    ).toBe(true);
  });

  it("still accepts a telemetry-free part on the v1 protocol version", () => {
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        parts: [part([item("invocation-1")])],
      }).success
    ).toBe(true);
  });

  it("rejects an envelope whose version understates the part it carries", () => {
    expect(
      agentComponentInvocationSyncBatchSchema.safeParse({
        protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
        parts: [
          telemetryPart([{ ...item("invocation-1"), footprintTokens: 512 }]),
        ],
      }).success
    ).toBe(false);
  });

  it("derives the protocol version a part must declare from its own items", () => {
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([item("a")])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION);
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        { ...item("a"), footprintTokens: 1 },
      ])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION);
  });
});

function part(items: unknown[]) {
  return {
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    externalSessionId: "session-1",
    externalGenerationId: "a".repeat(64),
    sourceUpdatedAt: "2026-07-22T16:00:00.000Z",
    dataRevision: 35,
    sourceSequence: 1,
    partIndex: 0,
    partCount: 1,
    partHash: "c".repeat(64),
    items,
  };
}

function telemetryPart(items: unknown[]) {
  return {
    ...part(items),
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_TELEMETRY_PROTOCOL_VERSION,
  };
}

function item(externalInvocationId: string) {
  return {
    externalInvocationId,
    sourceSessionId: "session-1",
    kind: AgentComponentInvocationKind.Tool,
    componentKey: "Read",
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: "2026-07-22T16:00:00.000Z",
    sequence: 0,
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: "event-1",
    },
    status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
  };
}
