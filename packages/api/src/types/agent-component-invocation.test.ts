import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncAck,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncItem,
  agentComponentInvocationGenerationHashPreimage,
  agentComponentInvocationSyncPartHashPreimage,
} from "./agent-component-invocation";

describe("agent component invocation contract", () => {
  it("pins the dedicated v1 values independently of session sync", () => {
    expect(AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION).toBe(1);
    expect(Object.values(AgentComponentInvocationKind)).toEqual([
      "tool",
      "mcp",
      "orchestration",
      "command",
      "skill",
      "subagent",
      "hook",
    ]);
    expect(Object.values(AgentComponentInvocationAttributionStatus)).toEqual([
      "matched",
      "unresolved",
      "unmatched",
      "ambiguous",
    ]);
  });

  it("omits absent optional wire evidence instead of serializing null", () => {
    const item: AgentComponentInvocationSyncItem = {
      externalInvocationId: "inv-1",
      sourceSessionId: "session-1",
      kind: AgentComponentInvocationKind.Tool,
      componentKey: "Read",
      relationship: AgentComponentInvocationRelationship.Direct,
      invokedAt: null,
      sequence: 0,
      anchor: { kind: AgentComponentInvocationAnchorKind.Session },
      status: AgentComponentInvocationAttributionStatus.Unresolved,
      evidenceClass: AgentComponentInvocationEvidenceClass.None,
    };

    expect(JSON.parse(JSON.stringify(item))).toEqual(item);
    expect(JSON.stringify(item)).not.toContain("definitionContent");
    expect(JSON.stringify(item)).not.toContain("definitionHash");
  });

  it("echoes the exact generation, part index, and part hash in acknowledgements", () => {
    const ack: AgentComponentInvocationSyncAck = {
      accepted: true,
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      externalGenerationId: "generation-hash",
      partIndex: 2,
      partHash: "part-hash",
      state: AgentComponentInvocationSyncAckState.Activated,
    };

    expect(ack).toMatchObject({
      externalGenerationId: "generation-hash",
      partIndex: 2,
      partHash: "part-hash",
      state: "activated",
    });
  });

  it("builds a stable part hash preimage and omits undefined item evidence", () => {
    const item: AgentComponentInvocationSyncItem = {
      externalInvocationId: "inv-1",
      sourceSessionId: "session-1",
      kind: AgentComponentInvocationKind.Skill,
      componentKey: "review",
      relationship: AgentComponentInvocationRelationship.Direct,
      invokedAt: "2026-07-22T10:00:00.000Z",
      sequence: 0,
      anchor: {
        kind: AgentComponentInvocationAnchorKind.Event,
        eventId: "event-1",
      },
      status: AgentComponentInvocationAttributionStatus.Unresolved,
      evidenceClass: AgentComponentInvocationEvidenceClass.None,
      definitionContent: undefined,
    };
    const part = {
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      externalSessionId: "session-1",
      externalGenerationId: "generation-1",
      sourceUpdatedAt: "2026-07-22T10:00:01.000Z",
      dataRevision: 35,
      sourceSequence: 1,
      partIndex: 0,
      partCount: 1,
      items: [item],
    };

    const first = agentComponentInvocationSyncPartHashPreimage(part);
    const second = agentComponentInvocationSyncPartHashPreimage({
      ...part,
      items: [{ ...item }],
    });
    expect(first).toBe(second);
    expect(first).not.toContain("definitionContent");
  });

  it("keys complete generations by session plus ordered items, not freshness", () => {
    const items: AgentComponentInvocationSyncItem[] = [];
    expect(
      agentComponentInvocationGenerationHashPreimage({
        externalSessionId: "session-1",
        items,
      })
    ).not.toBe(
      agentComponentInvocationGenerationHashPreimage({
        externalSessionId: "session-2",
        items,
      })
    );
  });
});
