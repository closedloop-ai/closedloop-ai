import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_TRACE_KIND_LABEL } from "../../../../../lib/session-trace/session-trace-node";
import { PreviewTraceParam } from "../preview-trace-route-state";
import { EMPTY_WINDOW } from "./support/preview-trace-dom";
import {
  drawnRowKeys,
  previewTraceParam,
  previewTraceStatValue,
  renderPreviewTrace,
  visitPreviewTrace,
} from "./support/preview-trace-harness";
import { previewTraceRow } from "./support/preview-trace-rows";

const ERRORS_CHIP = /^Errors \d+$/;
const FAILURES_REGION = "Failures in this session";
const TOOL = SESSION_TRACE_KIND_LABEL[AgentComponentInvocationKind.Tool];
const HOOK = SESSION_TRACE_KIND_LABEL[AgentComponentInvocationKind.Hook];

afterEach(() => {
  vi.restoreAllMocks();
  visitPreviewTrace();
});

function kindChip(label: string): HTMLElement {
  return screen.getByRole("button", { name: label });
}

/** The pointer strip under the chart. It is aria-hidden, so it is reached by its caption. */
function scrubberTrack(): HTMLElement {
  const track = screen.getByText("Drag to zoom").nextElementSibling;
  if (!(track instanceof HTMLElement)) {
    throw new Error("No scrubber track");
  }
  return track;
}

function stubTrackBox(track: HTMLElement, widthPx: number): void {
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: widthPx,
    bottom: 32,
    width: widthPx,
    height: 32,
    toJSON: () => ({}),
  });
}

describe("SessionTracePreviewPanel kind filters", () => {
  it("hides a kind's rows and records the remaining kinds in the URL", async () => {
    const user = userEvent.setup();
    renderPreviewTrace();
    expect(kindChip(TOOL)).toHaveAttribute("aria-pressed", "true");
    await user.click(kindChip(TOOL));

    expect(kindChip(TOOL)).toHaveAttribute("aria-pressed", "false");
    expect(drawnRowKeys()).toEqual(["/design", "design-critic", "stop-hook"]);
    // pins current behavior; looks odd because the unplaced Read row is a Tool, yet it still counts after the Tool kind is filtered out
    expect(previewTraceStatValue("Spans")).toBe("4");
    expect(previewTraceParam(PreviewTraceParam.Kinds)?.split(",")).toEqual([
      AgentComponentInvocationKind.Command,
      AgentComponentInvocationKind.Skill,
      AgentComponentInvocationKind.Subagent,
      AgentComponentInvocationKind.Orchestration,
      AgentComponentInvocationKind.Mcp,
      AgentComponentInvocationKind.Hook,
    ]);
  });

  it("puts a hidden kind back and drops the param once every kind shows", async () => {
    const user = userEvent.setup();
    renderPreviewTrace(
      `?kinds=${AgentComponentInvocationKind.Command},${AgentComponentInvocationKind.Hook}`
    );
    expect(drawnRowKeys()).toEqual(["/design", "stop-hook"]);
    await user.click(kindChip(TOOL));
    expect(kindChip(TOOL)).toHaveAttribute("aria-pressed", "true");
    expect(previewTraceParam(PreviewTraceParam.Kinds)).toBe(
      `${AgentComponentInvocationKind.Command},${AgentComponentInvocationKind.Hook},${AgentComponentInvocationKind.Tool}`
    );
    expect(drawnRowKeys()).toEqual(["/design", "Bash", "Bash", "stop-hook"]);
  });

  it("refuses to remove the last kind standing", async () => {
    const user = userEvent.setup();
    renderPreviewTrace(`?kinds=${AgentComponentInvocationKind.Hook}`);
    await user.click(kindChip(HOOK));
    expect(kindChip(HOOK)).toHaveAttribute("aria-pressed", "true");
    expect(previewTraceParam(PreviewTraceParam.Kinds)).toBe(
      AgentComponentInvocationKind.Hook
    );
    expect(drawnRowKeys()).toEqual(["stop-hook"]);
  });
});

describe("SessionTracePreviewPanel errors lens", () => {
  it("discloses the failure list and narrows to the paths that reached a failure", async () => {
    const user = userEvent.setup();
    renderPreviewTrace();
    const chip = screen.getByRole("button", { name: ERRORS_CHIP });
    expect(chip).toHaveAccessibleName("Errors 1");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("region", { name: FAILURES_REGION })
    ).not.toBeInTheDocument();

    await user.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(previewTraceParam(PreviewTraceParam.ErrorsOnly)).toBe("1");
    expect(drawnRowKeys()).toEqual(["/design", "design-critic", "Bash"]);
    const failures = screen.getByRole("region", { name: FAILURES_REGION });
    expect(within(failures).getByText("exit status 2")).toBeInTheDocument();
    expect(
      within(failures).getByText("/design › design-critic")
    ).toBeInTheDocument();
  });

  it("selects a failure from the list", async () => {
    const user = userEvent.setup();
    renderPreviewTrace("?errors=1");
    const failures = screen.getByRole("region", { name: FAILURES_REGION });
    await user.click(within(failures).getByRole("button"));
    expect(previewTraceParam(PreviewTraceParam.Span)).toBe("n3");
  });

  it("offers no errors chip for a session with no failures", () => {
    renderPreviewTrace("", [previewTraceRow("n1", 0, { durationMs: 100 })]);
    expect(
      screen.queryByRole("button", { name: ERRORS_CHIP })
    ).not.toBeInTheDocument();
  });
});

describe("SessionTracePreviewPanel critical path lens", () => {
  it("narrows to the chain that held the session open, and back", async () => {
    const user = userEvent.setup();
    renderPreviewTrace();
    const chip = screen.getByRole("button", { name: "Critical path only" });
    await user.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(previewTraceParam(PreviewTraceParam.CriticalPath)).toBe("1");
    expect(drawnRowKeys()).toEqual(["/design", "design-critic", "Bash"]);

    await user.click(chip);
    expect(previewTraceParam(PreviewTraceParam.CriticalPath)).toBeNull();
    expect(drawnRowKeys()).toHaveLength(5);
  });
});

describe("SessionTracePreviewPanel window controls", () => {
  it("zooms to the selected span and fits the whole session again", async () => {
    const user = userEvent.setup();
    renderPreviewTrace("?span=n4");
    const fit = screen.getByRole("button", { name: "Fit the whole session" });
    expect(fit).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Zoom to span" }));
    expect(previewTraceParam(PreviewTraceParam.From)).toBe("7000");
    expect(previewTraceParam(PreviewTraceParam.To)).toBe("8000");
    expect(drawnRowKeys()).toEqual(["/design", "Bash"]);
    expect(fit).toBeEnabled();

    await user.click(fit);
    expect(previewTraceParam(PreviewTraceParam.From)).toBeNull();
    expect(previewTraceParam(PreviewTraceParam.To)).toBeNull();
    expect(fit).toBeDisabled();
  });

  it("gives a zero-length span a one-millisecond window", async () => {
    const user = userEvent.setup();
    renderPreviewTrace("?span=n2", [
      previewTraceRow("n1", 0, { durationMs: 10_000 }),
      previewTraceRow("n2", 400, { durationMs: 0 }),
    ]);
    await user.click(screen.getByRole("button", { name: "Zoom to span" }));
    expect(previewTraceParam(PreviewTraceParam.From)).toBe("400");
    expect(previewTraceParam(PreviewTraceParam.To)).toBe("401");
  });

  it("zooms out about the window's centre", async () => {
    const user = userEvent.setup();
    renderPreviewTrace("?from=4000&to=6000");
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(previewTraceParam(PreviewTraceParam.From)).toBe("3000");
    expect(previewTraceParam(PreviewTraceParam.To)).toBe("7000");
  });

  it("clamps a zoom-out to the session's own extent", async () => {
    const user = userEvent.setup();
    renderPreviewTrace();
    const fit = screen.getByRole("button", { name: "Fit the whole session" });
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    // pins current behavior; looks odd because zooming out of an unzoomed view writes the full window to the URL and enables Fit
    expect(previewTraceParam(PreviewTraceParam.From)).toBe("0");
    expect(previewTraceParam(PreviewTraceParam.To)).toBe("12001");
    expect(fit).toBeEnabled();
  });

  it("draws no rows and no depth for a linked window past the session", () => {
    renderPreviewTrace("?from=20000&to=30000");
    expect(screen.getByText(EMPTY_WINDOW)).toBeInTheDocument();
    expect(previewTraceStatValue("Depth")).toBe("0");
    // The unplaced row still counts, because the whole session is in scope.
    expect(previewTraceStatValue("Spans")).toBe("1");
  });

  it("cuts a window from a drag across the scrubber", () => {
    renderPreviewTrace();
    const track = scrubberTrack();
    stubTrackBox(track, 100);
    fireEvent.pointerDown(track, { clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 50, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 50, pointerId: 1 });
    // 10% and 50% of the 12,001ms session, rounded on the way into the URL.
    expect(previewTraceParam(PreviewTraceParam.From)).toBe("1200");
    expect(previewTraceParam(PreviewTraceParam.To)).toBe("6001");
  });

  it("fits the whole session on a double-click of the scrubber", () => {
    renderPreviewTrace("?from=4000&to=6000");
    fireEvent.doubleClick(scrubberTrack());
    expect(previewTraceParam(PreviewTraceParam.From)).toBeNull();
    expect(previewTraceParam(PreviewTraceParam.To)).toBeNull();
    expect(drawnRowKeys()).toHaveLength(5);
  });
});
