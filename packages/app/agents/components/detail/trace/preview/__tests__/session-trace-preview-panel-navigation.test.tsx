import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { tracedSessionInvocations } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures/session/traced-session-rows";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_TRACE_KIND_LABEL } from "../../../../../lib/session-trace/session-trace-node";
import { encodeComponentRef } from "../preview-trace-component-drilldown";
import { PreviewTraceParam } from "../preview-trace-route-state";
import { previewTracedSessionContext } from "../preview-traced-session";
import { SessionTracePreviewPanel } from "../session-trace-preview-panel";
import { EMPTY_WINDOW, ROWS_LIST_NAME } from "./support/preview-trace-dom";
import {
  drawnRowKeys,
  previewTraceParam,
  previewTraceStatValue,
  renderPreviewTrace,
  SPAN_DETAIL_NAME,
  spanDetail,
  visitPreviewTrace,
} from "./support/preview-trace-harness";
import { previewTraceRow } from "./support/preview-trace-rows";

const UNPLACED_HEADING = /^Not placed on the axis/;
const BACK_TO_TRACE = "Back to the trace";
const PLACEHOLDER = /Select a span to see its ancestry/;
const FOCUS_TRAIL = "Focused subtree";
const SCOPE_SENTENCE = /and everything under it, not the whole session\./;
const TRANSCRIPT_STATUS = `transcript ${previewTracedSessionContext.transcriptSyncStatus}`;
const BASH_REF = encodeComponentRef(AgentComponentInvocationKind.Tool, "Bash");

afterEach(() => {
  visitPreviewTrace();
});

function rowFor(componentKey: string, occurrence = 0): HTMLElement {
  const list = screen.getByRole("list", { name: ROWS_LIST_NAME });
  const label = within(list).getAllByText(componentKey, {
    selector: "span.truncate",
  })[occurrence];
  const row = label?.closest("button");
  if (row === null || row === undefined) {
    throw new Error(`No drawn row for ${componentKey}`);
  }
  return row;
}

describe("SessionTracePreviewPanel empty and default states", () => {
  it("renders the shared traced-session fixture when no invocations are passed", () => {
    visitPreviewTrace();
    render(<SessionTracePreviewPanel />);
    expect(previewTraceStatValue("Spans")).toBe(
      String(tracedSessionInvocations.length)
    );
    expect(
      screen.getByText(TRANSCRIPT_STATUS, { exact: false })
    ).toBeInTheDocument();
    expect(within(spanDetail()).getByText(PLACEHOLDER)).toBeInTheDocument();
  });

  it("says the window is empty and counts nothing for a session with no rows", () => {
    renderPreviewTrace("", []);
    expect(screen.getByText(EMPTY_WINDOW)).toBeInTheDocument();
    expect(previewTraceStatValue("Spans")).toBe("0");
    expect(previewTraceStatValue("Depth")).toBe("0");
    expect(previewTraceStatValue("Measured extents")).toBe("0 of 0");
    expect(previewTraceStatValue("Failed")).toBe("0");
    expect(
      screen.queryByRole("heading", { name: UNPLACED_HEADING })
    ).not.toBeInTheDocument();
  });

  it("counts rows it could not place, and lists them, while drawing none", () => {
    renderPreviewTrace("", [
      previewTraceRow("n1", null, { componentKey: "Read" }),
    ]);
    expect(screen.getByText(EMPTY_WINDOW)).toBeInTheDocument();
    expect(previewTraceStatValue("Spans")).toBe("1");
    expect(previewTraceStatValue("Depth")).toBe("0");
    expect(
      screen.getByRole("heading", { name: UNPLACED_HEADING })
    ).toHaveTextContent("Not placed on the axis (1)");
  });

  it("summarises the whole session, unplaced rows included", () => {
    renderPreviewTrace();
    expect(drawnRowKeys()).toEqual([
      "/design",
      "design-critic",
      "Bash",
      "Bash",
      "stop-hook",
    ]);
    expect(previewTraceStatValue("Spans")).toBe("6");
    expect(previewTraceStatValue("Depth")).toBe("3");
    expect(previewTraceStatValue("Agents")).toBe("2");
    expect(previewTraceStatValue("Wall clock")).toBe("12.0s");
    expect(previewTraceStatValue("Turn spend")).toBe("$1.50");
    expect(previewTraceStatValue("Footprint tokens")).toBe("50");
    expect(previewTraceStatValue("Turn tokens in / out")).toBe("1,000 / 200");
    expect(previewTraceStatValue("Cache read")).toBe("7");
    expect(previewTraceStatValue("Measured extents")).toBe("4 of 5");
    expect(previewTraceStatValue("Failed")).toBe("1");
    expect(screen.queryByText(SCOPE_SENTENCE)).not.toBeInTheDocument();
  });
});

describe("SessionTracePreviewPanel selection", () => {
  it("selects a clicked row, shows it in the inspector and writes it to the URL", async () => {
    const user = userEvent.setup();
    renderPreviewTrace();
    expect(screen.getByRole("button", { name: "Zoom to span" })).toBeDisabled();
    await user.click(rowFor("design-critic"));
    expect(rowFor("design-critic")).toHaveAttribute("aria-pressed", "true");
    expect(
      within(spanDetail()).getByRole("heading", {
        level: 3,
        name: "design-critic",
      })
    ).toBeInTheDocument();
    expect(previewTraceParam(PreviewTraceParam.Span)).toBe("n2");
    expect(screen.getByRole("button", { name: "Zoom to span" })).toBeEnabled();
  });

  it("restores the selected span from a pasted link", () => {
    renderPreviewTrace("?span=n4");
    expect(
      within(spanDetail()).getByRole("heading", { level: 3, name: "Bash" })
    ).toBeInTheDocument();
    expect(rowFor("Bash", 1)).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the placeholder for a linked span that is not in the session", () => {
    renderPreviewTrace("?span=n99");
    expect(within(spanDetail()).getByText(PLACEHOLDER)).toBeInTheDocument();
  });
});

describe("SessionTracePreviewPanel focus", () => {
  it("re-roots on a subtree, scopes the header, and withholds session context", async () => {
    const user = userEvent.setup();
    renderPreviewTrace();
    expect(
      screen.getByText(TRANSCRIPT_STATUS, { exact: false })
    ).toBeInTheDocument();
    await user.click(rowFor("design-critic"));
    await user.click(
      within(spanDetail()).getByRole("button", { name: "Focus subtree" })
    );

    const trail = screen.getByRole("navigation", { name: FOCUS_TRAIL });
    expect(
      within(trail).getByRole("button", { name: "Whole session" })
    ).toBeInTheDocument();
    expect(
      within(trail).getByRole("button", { name: "/design" })
    ).toBeInTheDocument();
    expect(within(trail).getByText("design-critic")).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByText(SCOPE_SENTENCE).textContent).toBe(
      "Measuring design-critic and everything under it, not the whole session."
    );
    expect(drawnRowKeys()).toEqual(["design-critic", "Bash"]);
    // The unplaced row belongs to the session, so the focused count drops it.
    expect(previewTraceStatValue("Spans")).toBe("2");
    expect(previewTraceStatValue("Depth")).toBe("2");
    expect(
      screen.queryByText(TRANSCRIPT_STATUS, { exact: false })
    ).not.toBeInTheDocument();
    expect(previewTraceParam(PreviewTraceParam.Focus)).toBe("n2");
  });

  it("walks back up one ancestor, then out to the whole session", async () => {
    const user = userEvent.setup();
    renderPreviewTrace("?focus=n2");
    const trail = screen.getByRole("navigation", { name: FOCUS_TRAIL });
    await user.click(within(trail).getByRole("button", { name: "/design" }));
    expect(previewTraceParam(PreviewTraceParam.Focus)).toBe("n1");
    expect(drawnRowKeys()).toEqual([
      "/design",
      "design-critic",
      "Bash",
      "Bash",
    ]);

    await user.click(screen.getByRole("button", { name: "Whole session" }));
    expect(
      screen.queryByRole("navigation", { name: FOCUS_TRAIL })
    ).not.toBeInTheDocument();
    expect(previewTraceParam(PreviewTraceParam.Focus)).toBeNull();
    expect(drawnRowKeys()).toHaveLength(5);
  });

  it("clears an explicit window when it focuses, so the subtree owns the axis", async () => {
    const user = userEvent.setup();
    renderPreviewTrace("?span=n2&from=0&to=500");
    expect(previewTraceParam(PreviewTraceParam.From)).toBe("0");
    await user.click(
      within(spanDetail()).getByRole("button", { name: "Focus subtree" })
    );
    expect(previewTraceParam(PreviewTraceParam.From)).toBeNull();
    expect(previewTraceParam(PreviewTraceParam.To)).toBeNull();
    expect(previewTraceParam(PreviewTraceParam.Focus)).toBe("n2");
  });

  it("does not offer focus on a span with nothing under it", () => {
    renderPreviewTrace("?span=n3");
    expect(
      within(spanDetail()).getByRole("button", { name: "Focus subtree" })
    ).toBeDisabled();
  });

  it("ignores a linked focus id that is not in the session", () => {
    renderPreviewTrace("?focus=n99");
    expect(
      screen.queryByRole("navigation", { name: FOCUS_TRAIL })
    ).not.toBeInTheDocument();
    expect(drawnRowKeys()).toHaveLength(5);
  });
});

describe("SessionTracePreviewPanel component drill-in", () => {
  it("opens every occurrence of a component and returns to the span it left", async () => {
    const user = userEvent.setup();
    renderPreviewTrace("?span=n3");
    await user.click(
      within(spanDetail()).getByRole("button", { name: "Bash" })
    );

    expect(previewTraceParam(PreviewTraceParam.Component)).toBe(BASH_REF);
    expect(
      screen.getByRole("heading", { level: 3, name: "Bash" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        SESSION_TRACE_KIND_LABEL[AgentComponentInvocationKind.Tool]
      )
    ).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: SPAN_DETAIL_NAME })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to Bash" }));
    expect(previewTraceParam(PreviewTraceParam.Component)).toBeNull();
    expect(previewTraceParam(PreviewTraceParam.Span)).toBe("n3");
    expect(
      within(spanDetail()).getByRole("heading", { level: 3, name: "Bash" })
    ).toBeInTheDocument();
  });

  it("opens a listed occurrence back in the trace, selected", async () => {
    const user = userEvent.setup();
    renderPreviewTrace(`?span=n3&component=${BASH_REF}`);
    const occurrence = screen.getByText("#4").closest("button");
    if (occurrence === null) {
      throw new Error("No occurrence button for #4");
    }
    await user.click(occurrence);
    expect(previewTraceParam(PreviewTraceParam.Component)).toBeNull();
    expect(previewTraceParam(PreviewTraceParam.Span)).toBe("n4");
    expect(rowFor("Bash", 1)).toHaveAttribute("aria-pressed", "true");
  });

  it("names the trace itself as the way back when no span was selected", () => {
    renderPreviewTrace(`?component=${BASH_REF}`);
    expect(
      screen.getByRole("button", { name: BACK_TO_TRACE })
    ).toBeInTheDocument();
  });

  it("stays on the trace when the linked component never ran", () => {
    renderPreviewTrace(
      `?component=${encodeComponentRef(AgentComponentInvocationKind.Skill, "absent")}`
    );
    expect(drawnRowKeys()).toHaveLength(5);
    expect(
      screen.queryByRole("button", { name: BACK_TO_TRACE })
    ).not.toBeInTheDocument();
  });
});
