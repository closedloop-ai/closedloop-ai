import type { MergedTraceItem } from "@repo/api/src/types/branch";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BranchMergedTrace } from "../branch-merged-trace";

const NO_TRACE_RE = /no trace captured/i;

const traceItems: MergedTraceItem[] = [
  {
    type: "sessionstart",
    sessionId: "s1",
    t: "2026-06-10T10:00:00.000Z",
    actor: { name: "alice", harness: "claude" },
  },
  {
    type: "say",
    sessionId: "s1",
    t: "2026-06-10T10:01:00.000Z",
    tMs: 0,
    cumCostUsd: null,
    actorName: "alice",
    text: "Hello from the trace",
  },
  {
    type: "event",
    sessionId: "s1",
    t: "2026-06-10T10:02:00.000Z",
    dot: "g",
    text: "Commit pushed",
  },
  { type: "end", sessionId: "s1", text: "done" },
];

describe("BranchMergedTrace (D2 → shared SessionTrace)", () => {
  it("renders via the shared SessionTrace (st-* markup) with the trace content", () => {
    const { container } = render(<BranchMergedTrace traceItems={traceItems} />);
    // Reuses the agents SessionTrace: its root is `.st`, not a bespoke renderer.
    expect(container.querySelector(".st")).not.toBeNull();
    expect(screen.getByText("Hello from the trace")).toBeInTheDocument();
    expect(screen.getByText("Commit pushed")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("renders the empty state for an empty trace", () => {
    render(<BranchMergedTrace traceItems={[]} />);
    expect(screen.getByText(NO_TRACE_RE)).toBeInTheDocument();
  });

  it("jumps to the item's row on event-row click and marks the active row", async () => {
    const onJump = vi.fn();
    const { container } = render(
      <BranchMergedTrace
        activeRow={2}
        onJump={onJump}
        traceItems={traceItems}
      />
    );
    // The event item is index 2 in the source trace → its row identity is 2.
    const eventRow = container.querySelector<HTMLElement>(
      '.st-sysline[data-row="2"]'
    );
    expect(eventRow?.getAttribute("data-active")).toBe("true");
    await userEvent.click(eventRow as HTMLElement);
    expect(onJump).toHaveBeenCalledWith(2);
  });

  it("scrolls the bounded trace viewport (not the page) when a timeline scrub notifies it", () => {
    const captured: { notify: ((row: number) => void) | null } = {
      notify: null,
    };
    const registerScroll = (onActive: (row: number) => void) => {
      captured.notify = onActive;
      return () => {
        captured.notify = null;
      };
    };
    const { container } = render(
      <BranchMergedTrace
        registerScroll={registerScroll}
        traceItems={traceItems}
      />
    );
    // The scrub scrolls the trace's own bounded viewport in place — never the
    // matched element via `scrollIntoView`, which would scroll the whole page.
    const viewport = container.querySelector<HTMLElement>(".bq-trace-scroll");
    // Guard the spy install so a selector mismatch fails as "viewport is null"
    // rather than an opaque "spy was never called".
    expect(viewport).not.toBeNull();
    const scrollSpy = vi.fn();
    if (viewport) {
      viewport.scrollTo = scrollSpy as unknown as typeof viewport.scrollTo;
    }
    const eventRow = container.querySelector<HTMLElement>(
      '.st-sysline[data-row="2"]'
    );
    const intoViewSpy = vi.fn();
    if (eventRow) {
      eventRow.scrollIntoView = intoViewSpy;
    }
    // The provider's `registerTraceScroll` only fires on timeline/playhead
    // scrubs, so notifying row 2 must scroll the trace to that row.
    expect(captured.notify).not.toBeNull();
    captured.notify?.(2);
    expect(scrollSpy).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "smooth" })
    );
    expect(intoViewSpy).not.toHaveBeenCalled();
  });
});
