/**
 * ISS-10737 — the errors-only lens keeps each failure's ANCESTORS, and nothing
 * else.
 *
 * `span.ancestry` holds COMPONENT KEYS, so the first implementation matched
 * those against invocation ids and then fell back to "any shallower span whose
 * componentKey appears in the ancestry". On a session where one component is
 * invoked in several branches — the normal case — that retained unrelated
 * occurrences and presented them as part of the failing call's hand-off chain.
 * Every case below distinguishes the two by giving the sibling branch the SAME
 * component keys as the failing one.
 */

import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import {
  buildSessionTrace,
  flattenSpans,
} from "../../../../lib/session-trace/build-session-trace";
import {
  SESSION_TRACE_KIND_ORDER,
  type SessionTraceInvocation,
  type SessionTraceSpan,
} from "../../../../lib/session-trace/session-trace-node";
import { applyLenses } from "../session-trace-tab";

const ORIGIN = Date.parse("2026-08-20T14:00:00.000Z");

function row(
  id: string,
  offsetMs: number,
  componentKey: string,
  overrides: Partial<SessionTraceInvocation> = {}
): SessionTraceInvocation {
  return {
    externalInvocationId: id,
    kind: AgentComponentInvocationKind.Tool,
    componentKey,
    sequence: offsetMs,
    invokedAt: new Date(ORIGIN + offsetMs).toISOString(),
    attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
    durationMs: 5,
    ...overrides,
  };
}

/**
 * Two branches with IDENTICAL component keys. Only the second fails, so an
 * ancestry match by NAME cannot tell them apart and an id walk can.
 *
 *   a1 Agent ── a2 Bash   (succeeded)
 *   b1 Agent ── b2 Bash   (FAILED)
 */
function twoBranchesSharingNames(): readonly SessionTraceSpan[] {
  return flattenSpans(
    buildSessionTrace([
      row("a1", 0, "Agent", { succeeded: true }),
      row("a2", 10, "Bash", {
        parentExternalInvocationId: "a1",
        succeeded: true,
      }),
      row("b1", 100, "Agent", { succeeded: true }),
      row("b2", 110, "Bash", {
        parentExternalInvocationId: "b1",
        succeeded: false,
      }),
    ]).roots
  );
}

function idsOf(spans: readonly SessionTraceSpan[]): string[] {
  return spans.map((span) => span.invocation.externalInvocationId).sort();
}

describe("applyLenses", () => {
  it("keeps only the failing call's own ancestors, not same-named siblings", () => {
    const kept = applyLenses(twoBranchesSharingNames(), {
      activeKinds: SESSION_TRACE_KIND_ORDER,
      errorsOnly: true,
    });

    // b2 failed; b1 is its real parent. a1/a2 share both names and never failed.
    expect(idsOf(kept)).toStrictEqual(["b1", "b2"]);
  });

  it("keeps every span when the failure lens is off", () => {
    const kept = applyLenses(twoBranchesSharingNames(), {
      activeKinds: SESSION_TRACE_KIND_ORDER,
      errorsOnly: false,
    });

    expect(idsOf(kept)).toStrictEqual(["a1", "a2", "b1", "b2"]);
  });

  it("walks the whole parent chain, not one hop", () => {
    const spans = flattenSpans(
      buildSessionTrace([
        row("r", 0, "Command", { succeeded: true }),
        row("m", 10, "Agent", {
          parentExternalInvocationId: "r",
          succeeded: true,
        }),
        row("leaf", 20, "Bash", {
          parentExternalInvocationId: "m",
          succeeded: false,
        }),
      ]).roots
    );

    const kept = applyLenses(spans, {
      activeKinds: SESSION_TRACE_KIND_ORDER,
      errorsOnly: true,
    });

    expect(idsOf(kept)).toStrictEqual(["leaf", "m", "r"]);
  });

  it("terminates on a corrupt parent cycle", () => {
    const spans = flattenSpans(
      buildSessionTrace([
        row("c1", 0, "Agent", {
          parentExternalInvocationId: "c2",
          succeeded: false,
        }),
        row("c2", 10, "Agent", {
          parentExternalInvocationId: "c1",
          succeeded: true,
        }),
      ]).roots
    );

    const kept = applyLenses(spans, {
      activeKinds: SESSION_TRACE_KIND_ORDER,
      errorsOnly: true,
    });

    expect(idsOf(kept).length).toBeGreaterThan(0);
  });

  it("narrows by kind before the failure lens, and never re-admits", () => {
    const spans = flattenSpans(
      buildSessionTrace([
        row("s1", 0, "Agent", {
          kind: AgentComponentInvocationKind.Subagent,
          succeeded: true,
        }),
        row("t1", 10, "Bash", {
          parentExternalInvocationId: "s1",
          succeeded: false,
        }),
      ]).roots
    );

    const kept = applyLenses(spans, {
      activeKinds: [AgentComponentInvocationKind.Tool],
      errorsOnly: true,
    });

    expect(idsOf(kept)).toStrictEqual(["t1"]);
  });
});
