import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_TRACE_EXTENT_LABEL,
  SESSION_TRACE_EXTENT_NOTE,
  SESSION_TRACE_KIND_LABEL,
  SessionTraceExtentSource,
} from "../../../../lib/session-trace/session-trace-node";
import { SessionTraceInspector } from "../session-trace-inspector";
import { spanFrom, traceInvocation } from "./session-trace-span-fixtures";

const NOT_RECORDED = "Not recorded for this session";
const ROOT_ANCESTRY = "A root of this session — nothing above it was recorded.";
const FAILURE_SENTENCE =
  "This call reported a failure. Its ancestry above is the hand-off chain that reached it.";
const FOCUS_BUTTON = /^Focus this subtree$/;

function fieldValue(label: string): string | null {
  const labelNode = screen.getByText(label);
  return labelNode.nextElementSibling?.textContent ?? null;
}

describe("SessionTraceInspector", () => {
  it("names every unsourced telemetry field instead of rendering a zero", () => {
    const span = spanFrom([traceInvocation("root", 0)], "root");
    render(<SessionTraceInspector onFocusSubtree={vi.fn()} span={span} />);

    expect(
      screen.getByRole("region", { name: "Span detail: component-root" })
    ).toBeVisible();
    expect(screen.queryByText(FAILURE_SENTENCE)).toBeNull();
    expect(fieldValue("Ancestry")).toBe(ROOT_ANCESTRY);
    expect(fieldValue("Agent")).toBe("—");
    expect(fieldValue("Turn spend (this subtree)")).toBe(NOT_RECORDED);
    expect(fieldValue("Turn tokens in / out")).toBe(NOT_RECORDED);
    expect(fieldValue("Context footprint (a different population)")).toBe(
      NOT_RECORDED
    );
    expect(screen.queryByText("Definition")).toBeNull();
    expect(
      screen.getByText(
        SESSION_TRACE_KIND_LABEL[AgentComponentInvocationKind.Tool]
      )
    ).toBeVisible();
  });

  it("leads with the failure and renders every sourced value for a measured child", () => {
    const rows = [
      traceInvocation("parent", 0, {
        componentKey: "Orchestrator",
        durationMs: 10_000,
      }),
      traceInvocation("child", 1000, {
        componentKey: "Bash",
        kind: AgentComponentInvocationKind.Skill,
        parentExternalInvocationId: "parent",
        durationMs: 2000,
        succeeded: false,
        externalAgentId: "ag-7",
        estimatedCost: 1.5,
        inputTokens: 1200,
        outputTokens: 34,
        footprintTokens: 5000,
        definitionHash: "hash-abc",
      }),
    ];
    const span = spanFrom(rows, "child");
    render(<SessionTraceInspector onFocusSubtree={vi.fn()} span={span} />);

    expect(screen.getByText(FAILURE_SENTENCE)).toBeVisible();
    expect(fieldValue("Ancestry")).toBe("Orchestrator");
    expect(
      fieldValue(
        `Extent · ${SESSION_TRACE_EXTENT_LABEL[SessionTraceExtentSource.Measured]}`
      )
    ).toBe(
      `2.0s — ${SESSION_TRACE_EXTENT_NOTE[SessionTraceExtentSource.Measured]}`
    );
    expect(fieldValue("Agent")).toBe("ag-7");
    expect(fieldValue("Turn spend (this subtree)")).toBe(
      "$1.50 — already inside the session's own total, so it is what this branch cost and never something to add to the session figure."
    );
    expect(fieldValue("Turn tokens in / out")).toBe("1,200 / 34");
    expect(fieldValue("Context footprint (a different population)")).toBe(
      "5,000 tokens this component injected into turns that already counted them — never added to the turn tokens above."
    );
    expect(fieldValue("Definition")).toBe("hash-abc");
    expect(
      screen.getByText(
        SESSION_TRACE_KIND_LABEL[AgentComponentInvocationKind.Skill]
      )
    ).toBeVisible();
  });

  it("shows tokens when only the output count is recorded", () => {
    const span = spanFrom(
      [traceInvocation("root", 0, { outputTokens: 9 })],
      "root"
    );
    render(<SessionTraceInspector onFocusSubtree={vi.fn()} span={span} />);

    // pins current behavior; looks odd because the unrecorded input count renders as a measured 0 (ISS-11401)
    expect(fieldValue("Turn tokens in / out")).toBe("0 / 9");
  });

  it("hands the span to the focus callback", () => {
    const span = spanFrom([traceInvocation("root", 0)], "root");
    const onFocusSubtree = vi.fn();
    render(
      <SessionTraceInspector onFocusSubtree={onFocusSubtree} span={span} />
    );

    fireEvent.click(screen.getByRole("button", { name: FOCUS_BUTTON }));

    expect(onFocusSubtree).toHaveBeenCalledTimes(1);
    expect(onFocusSubtree).toHaveBeenCalledWith(span);
  });
});
