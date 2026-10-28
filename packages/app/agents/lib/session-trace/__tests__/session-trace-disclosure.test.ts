import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { agentComponentInvocationSessionTreeBound } from "@repo/api/src/types/agent-component-invocation-session-tree";
import { describe, expect, it } from "vitest";
import { buildSessionTrace } from "../build-session-trace";
import {
  buildSessionTraceDisclosure,
  SessionTraceOperand,
} from "../session-trace-disclosure";
import type { SessionTraceInvocation } from "../session-trace-node";

const ORIGIN = Date.parse("2026-09-20T09:00:00.000Z");

function row(
  id: string,
  offsetMs: number | null,
  overrides: Partial<SessionTraceInvocation> = {}
): SessionTraceInvocation {
  return {
    externalInvocationId: id,
    kind: AgentComponentInvocationKind.Tool,
    componentKey: id,
    sequence: Number(id.replace(/\D/g, "")) || 0,
    invokedAt:
      offsetMs === null ? null : new Date(ORIGIN + offsetMs).toISOString(),
    attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    ...overrides,
  };
}

const COMPLETE = agentComponentInvocationSessionTreeBound(2, 2, 100);

describe("buildSessionTraceDisclosure", () => {
  it("names every telemetry operand that has no producer, instead of reporting a zero", () => {
    // Today's read row carries no `succeeded`, no cost, no tokens and no
    // footprint (ISS-10718), so every one of them must be NAMED rather than
    // rendered as "0" or a dash.
    const trace = buildSessionTrace([row("n1", 0), row("n2", 1000)]);

    const disclosure = buildSessionTraceDisclosure(trace, COMPLETE);
    const operands = disclosure.missing.map((entry) => entry.operand);

    expect(operands).toContain(SessionTraceOperand.Failure);
    expect(operands).toContain(SessionTraceOperand.TurnSpend);
    expect(operands).toContain(SessionTraceOperand.TurnTokens);
    expect(operands).toContain(SessionTraceOperand.Footprint);
    for (const entry of disclosure.missing) {
      expect(entry.note.length).toBeGreaterThan(0);
      expect(entry.label).not.toBe("—");
      // Production copy carries no ticket slug, no document reference and no
      // field name in backticks: implementation provenance has no user job.
      expect(entry.note).not.toContain("ISS-");
      expect(entry.note).not.toContain("DOC-");
      expect(entry.note).not.toContain("`");
      expect(entry.label).not.toContain("`");
    }
  });

  it("withdraws the failure operand once any row reports `succeeded`", () => {
    const trace = buildSessionTrace([
      row("n1", 0, { succeeded: true }),
      row("n2", 1000),
    ]);

    const operands = buildSessionTraceDisclosure(trace, COMPLETE).missing.map(
      (entry) => entry.operand
    );

    expect(operands).not.toContain(SessionTraceOperand.Failure);
  });

  it("says every bar width is an upper bound when nothing measured an extent", () => {
    const trace = buildSessionTrace([row("n1", 0), row("n2", 1000)]);

    const sentence = buildSessionTraceDisclosure(
      trace,
      COMPLETE
    ).extentCoverage;

    expect(sentence).toContain("upper bound");
    // User-facing copy, so it says what is unknown WITHOUT naming the field or
    // the ticket that will supply it.
    expect(sentence).toContain("nothing records how long a call took yet");
    expect(sentence).not.toContain("ISS-");
  });

  it("counts measured extents once a row carries one", () => {
    const trace = buildSessionTrace([
      row("n1", 0, { durationMs: 500 }),
      row("n2", 1000),
    ]);

    expect(buildSessionTraceDisclosure(trace, COMPLETE).extentCoverage).toBe(
      "1 of 2 bar widths are measured elapsed spans. The other 1 are hatched: they run to the next sibling or the parent's close, which is an upper bound on latency, not latency."
    );
  });

  it("names the flat-ancestry operand when no parent link was persisted", () => {
    const trace = buildSessionTrace([row("n1", 0), row("n2", 1000)]);

    const operands = buildSessionTraceDisclosure(trace, COMPLETE).missing.map(
      (entry) => entry.operand
    );

    expect(operands).toContain(SessionTraceOperand.Ancestry);
  });

  it("withdraws the flat-ancestry operand once the tree has a second level", () => {
    const trace = buildSessionTrace([
      row("n1", 0),
      row("n2", 500, { parentExternalInvocationId: "n1" }),
    ]);

    const operands = buildSessionTraceDisclosure(trace, COMPLETE).missing.map(
      (entry) => entry.operand
    );

    expect(operands).not.toContain(SessionTraceOperand.Ancestry);
  });

  it("states a clipped tree's dropped count and that its ancestry is wrong, not short", () => {
    const trace = buildSessionTrace([row("n1", 0), row("n2", 1000)]);

    const truncation = buildSessionTraceDisclosure(
      trace,
      agentComponentInvocationSessionTreeBound(100_016, 100_000, 100)
    ).truncation;

    expect(truncation).not.toBeNull();
    expect(truncation).toContain("16");
    expect(truncation).toContain("100 pages");
    expect(truncation).toContain("wrong, not merely short");
  });

  it("says nothing about truncation on a complete tree", () => {
    const trace = buildSessionTrace([row("n1", 0)]);

    expect(
      buildSessionTraceDisclosure(
        trace,
        agentComponentInvocationSessionTreeBound(1, 1, 100)
      ).truncation
    ).toBeNull();
  });
});
