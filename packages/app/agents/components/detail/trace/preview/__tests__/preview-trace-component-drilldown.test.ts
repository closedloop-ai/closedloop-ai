import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import { buildSessionTrace } from "../../../../../lib/session-trace/build-session-trace";
import type { SessionTraceInvocation } from "../../../../../lib/session-trace/session-trace-node";
import {
  buildComponentDrilldown,
  decodeComponentRef,
  encodeComponentRef,
} from "../preview-trace-component-drilldown";

const ORIGIN = Date.parse("2026-08-20T14:00:00.000Z");

function row(
  id: string,
  offsetMs: number,
  overrides: Partial<SessionTraceInvocation> = {}
): SessionTraceInvocation {
  return {
    externalInvocationId: id,
    kind: AgentComponentInvocationKind.Tool,
    componentKey: id,
    sequence: Number(id.replace(/\D/g, "")) || 0,
    invokedAt: new Date(ORIGIN + offsetMs).toISOString(),
    attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    ...overrides,
  };
}

const nested = buildSessionTrace([
  row("n1", 0, {
    componentKey: "/cmd",
    kind: AgentComponentInvocationKind.Command,
    durationMs: 5000,
  }),
  row("n2", 100, {
    componentKey: "skill-a",
    kind: AgentComponentInvocationKind.Skill,
    parentExternalInvocationId: "n1",
    durationMs: 4000,
  }),
  row("n3", 200, {
    componentKey: "Read",
    parentExternalInvocationId: "n2",
    durationMs: 50,
    estimatedCost: 0,
    externalAgentId: "ag-1",
    definitionHash: "sha256:aaa",
  }),
  row("n4", 900, {
    componentKey: "Read",
    parentExternalInvocationId: "n2",
    durationMs: 70,
    externalAgentId: "ag-2",
    definitionHash: "sha256:bbb",
    succeeded: false,
  }),
]);

describe("buildComponentDrilldown", () => {
  it("collects every occurrence of one component across the session", () => {
    const drill = buildComponentDrilldown(
      nested.roots,
      AgentComponentInvocationKind.Tool,
      "Read"
    );
    expect(drill?.invocationCount).toBe(2);
    expect(drill?.agentIds).toStrictEqual(["ag-1", "ag-2"]);
    expect(drill?.failureCount).toBe(1);
  });

  it("reports more than one definition hash when the component changed mid-session", () => {
    const drill = buildComponentDrilldown(
      nested.roots,
      AgentComponentInvocationKind.Tool,
      "Read"
    );
    expect(drill?.definitionHashes).toStrictEqual(["sha256:aaa", "sha256:bbb"]);
  });

  it("sums only MEASURED extents and says how many that was", () => {
    const mixed = buildSessionTrace([
      row("n1", 0, { componentKey: "Bash", durationMs: 100 }),
      row("n2", 5000, { componentKey: "Bash" }),
      row("n3", 9000, { componentKey: "other", durationMs: 10 }),
    ]);
    const drill = buildComponentDrilldown(
      mixed.roots,
      AgentComponentInvocationKind.Tool,
      "Bash"
    );

    expect(drill?.invocationCount).toBe(2);
    expect(drill?.measuredOccurrenceCount).toBe(1);
    expect(drill?.measuredMs).toBe(100);
  });

  it("returns null for a component that never ran in this session", () => {
    expect(
      buildComponentDrilldown(
        nested.roots,
        AgentComponentInvocationKind.Tool,
        "Grep"
      )
    ).toBeNull();
  });
});

describe("component ref codec", () => {
  it("round-trips a key that itself contains a colon", () => {
    const ref = encodeComponentRef(
      AgentComponentInvocationKind.Skill,
      "code-review:start"
    );
    expect(decodeComponentRef(ref)).toStrictEqual({
      kind: AgentComponentInvocationKind.Skill,
      componentKey: "code-review:start",
    });
  });

  it("rejects a malformed ref instead of inventing a component", () => {
    expect(decodeComponentRef(null)).toBeNull();
    expect(decodeComponentRef("")).toBeNull();
    expect(decodeComponentRef(":orphan")).toBeNull();
    expect(decodeComponentRef("skill:")).toBeNull();
  });
});
