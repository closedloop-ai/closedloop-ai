import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_DURATION_PROTOCOL_VERSION,
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  agentComponentInvocationSyncProtocolVersionForItems,
} from "../agent-component-invocation.ts";
import { invocationDurationFields } from "../agent-component-invocation-duration.ts";
import { agentComponentInvocationSyncItemSchema } from "../agent-component-invocation-schema.ts";

const item = {
  externalInvocationId: "call-a",
  sourceSessionId: "session-a",
  kind: AgentComponentInvocationKind.Tool,
  componentKey: "Read",
  relationship: AgentComponentInvocationRelationship.Direct,
  invokedAt: "2026-10-19T12:00:00.000Z",
  sequence: 0,
  anchor: { kind: AgentComponentInvocationAnchorKind.Session },
  status: AgentComponentInvocationAttributionStatus.Unresolved,
  evidenceClass: AgentComponentInvocationEvidenceClass.None,
};

describe("measured invocation timing contract", () => {
  it("preserves omission for older producers and measured zero for timed calls", () => {
    expect(
      agentComponentInvocationSyncItemSchema.parse(item)
    ).not.toHaveProperty("durationMs");
    expect(invocationDurationFields(null)).toEqual({});
    expect(invocationDurationFields(undefined)).toEqual({});
    for (const durationMs of [0, 1234, Number.MAX_SAFE_INTEGER]) {
      expect(
        agentComponentInvocationSyncItemSchema.parse({ ...item, durationMs })
          .durationMs
      ).toBe(durationMs);
      expect(invocationDurationFields(BigInt(durationMs))).toEqual({
        durationMs,
      });
    }
  });

  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "",
    "123",
    null,
  ])("rejects malformed wire timing %s", (durationMs) => {
    expect(
      agentComponentInvocationSyncItemSchema.safeParse({ ...item, durationMs })
        .success
    ).toBe(false);
  });

  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "",
    "123",
    -1n,
  ])("surfaces corrupt stored timing %s", (value) => {
    expect(() => invocationDurationFields(value)).toThrow(RangeError);
  });

  it("declares a new protocol only for duration-bearing parts", () => {
    expect(agentComponentInvocationSyncProtocolVersionForItems([item])).toBe(
      AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION
    );
    expect(
      agentComponentInvocationSyncProtocolVersionForItems([
        { ...item, durationMs: 0 },
      ])
    ).toBe(AGENT_COMPONENT_INVOCATION_SYNC_DURATION_PROTOCOL_VERSION);
  });
});
