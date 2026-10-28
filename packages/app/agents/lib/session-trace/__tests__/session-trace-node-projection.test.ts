import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  type AgentComponentInvocationReadRow,
  AgentComponentInvocationRelationship,
  AgentComponentInvocationUsageMeasurement,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import {
  SESSION_TRACE_KIND_ORDER,
  SESSION_TRACE_KIND_TOKEN,
  type SessionTraceTelemetry,
  sessionTraceHatchFill,
  sessionTraceKindSwatchStyle,
  toSessionTraceInvocation,
} from "../session-trace-node";

describe("toSessionTraceInvocation", () => {
  it("projects the required fields and renames the attribution status", () => {
    expect(toSessionTraceInvocation(readRow())).toStrictEqual({
      externalInvocationId: "toolu_1",
      kind: AgentComponentInvocationKind.Skill,
      componentKey: "skill:review",
      sequence: 7,
      invokedAt: "2026-09-20T09:00:00.000Z",
      attributionStatus: AgentComponentInvocationAttributionStatus.Ambiguous,
      evidenceClass: AgentComponentInvocationEvidenceClass.CollectorSnapshot,
    });
  });

  it("carries a null invokedAt through instead of dropping the key", () => {
    expect(
      toSessionTraceInvocation(readRow({ invokedAt: null })).invokedAt
    ).toBeNull();
  });

  it("carries every optional identity and telemetry field that is present", () => {
    const projected = toSessionTraceInvocation(
      readRow({
        parentExternalInvocationId: "toolu_0",
        externalAgentId: "ag-2",
        definitionHash: "hash-1",
        definitionVersionId: "version-1",
        packId: "pack-1",
        repositoryFullName: "closedloop-ai/closedloop-ai",
        repositoryCommit: "abc123",
        branchName: "feat/trace",
        durationMs: 1200,
        succeeded: true,
        model: "claude-opus",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        estimatedCost: 0.25,
        footprintTokens: 50,
        usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
      })
    );

    expect(projected).toStrictEqual({
      externalInvocationId: "toolu_1",
      parentExternalInvocationId: "toolu_0",
      externalAgentId: "ag-2",
      kind: AgentComponentInvocationKind.Skill,
      componentKey: "skill:review",
      sequence: 7,
      invokedAt: "2026-09-20T09:00:00.000Z",
      attributionStatus: AgentComponentInvocationAttributionStatus.Ambiguous,
      evidenceClass: AgentComponentInvocationEvidenceClass.CollectorSnapshot,
      definitionHash: "hash-1",
      definitionVersionId: "version-1",
      packId: "pack-1",
      repositoryFullName: "closedloop-ai/closedloop-ai",
      repositoryCommit: "abc123",
      branchName: "feat/trace",
      durationMs: 1200,
      succeeded: true,
      model: "claude-opus",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      estimatedCost: 0.25,
      footprintTokens: 50,
      usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
    });
  });

  it("keeps a measured zero and a reported failure rather than treating them as absent", () => {
    const projected = toSessionTraceInvocation(
      readRow({
        durationMs: 0,
        succeeded: false,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
        footprintTokens: 0,
        model: "",
      })
    );

    expect(projected).toMatchObject({
      durationMs: 0,
      succeeded: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0,
      footprintTokens: 0,
      model: "",
    });
  });

  it("drops read-row fields the span vocabulary does not carry", () => {
    const projected = toSessionTraceInvocation(
      readRow({ rawName: "review", sourcePath: "/skills/review.md" })
    );

    expect(Object.keys(projected)).not.toContain("id");
    expect(Object.keys(projected)).not.toContain("sessionId");
    expect(Object.keys(projected)).not.toContain("anchor");
    expect(Object.keys(projected)).not.toContain("rawName");
    expect(Object.keys(projected)).not.toContain("sourcePath");
    expect(Object.keys(projected)).not.toContain("status");
  });
});

describe("sessionTraceKindSwatchStyle", () => {
  it("gives every kind its own fill and edges the swatch in that same hue", () => {
    const styles = SESSION_TRACE_KIND_ORDER.map(sessionTraceKindSwatchStyle);

    expect(new Set(styles.map((style) => style.backgroundColor)).size).toBe(
      SESSION_TRACE_KIND_ORDER.length
    );
    for (const [index, kind] of SESSION_TRACE_KIND_ORDER.entries()) {
      const style = styles[index];
      expect(style?.backgroundColor).toBe(SESSION_TRACE_KIND_TOKEN[kind]);
      expect(style?.boxShadow).toBe(
        `inset 0 0 0 1px color-mix(in oklab, ${SESSION_TRACE_KIND_TOKEN[kind]} 62%, var(--foreground))`
      );
    }
  });
});

describe("sessionTraceHatchFill", () => {
  it("stripes the given fill against a faded copy of itself", () => {
    expect(sessionTraceHatchFill("var(--info)")).toBe(
      "repeating-linear-gradient(135deg, var(--info) 0 3px, color-mix(in oklab, var(--info) 18%, transparent) 3px 6px)"
    );
  });
});

function readRow(
  overrides: Partial<
    AgentComponentInvocationReadRow & SessionTraceTelemetry
  > = {}
): AgentComponentInvocationReadRow & Partial<SessionTraceTelemetry> {
  return {
    id: "invocation-1",
    externalInvocationId: "toolu_1",
    sessionId: "session-1",
    externalSessionId: "external-session-1",
    sourceSessionId: "source-session-1",
    kind: AgentComponentInvocationKind.Skill,
    componentKey: "skill:review",
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: "2026-09-20T09:00:00.000Z",
    sequence: 7,
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: "event-1",
    },
    status: AgentComponentInvocationAttributionStatus.Ambiguous,
    evidenceClass: AgentComponentInvocationEvidenceClass.CollectorSnapshot,
    ...overrides,
  };
}
