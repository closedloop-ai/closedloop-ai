import type { MergedTraceItem } from "@repo/api/src/types/branch";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BranchMergedTrace } from "../branch-merged-trace";

const NO_TRACE_RE = /no trace captured/i;
const COMMENT_BUTTON_NAME_RE = /comment/i;

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

  it("scrolls the page scroll container (not scrollIntoView) when a timeline scrub notifies it", () => {
    const captured: { notify: ((row: number) => void) | null } = {
      notify: null,
    };
    const registerScroll = (onActive: (row: number) => void) => {
      captured.notify = onActive;
      return () => {
        captured.notify = null;
      };
    };
    // The trace now virtualizes against the single page scroll container, so a
    // scrub scrolls THAT element (via the virtualizer's scrollToIndex) — never
    // the matched element via `scrollIntoView`, and never a bounded inner
    // viewport (which no longer exists).
    const scrollEl = document.createElement("div");
    document.body.append(scrollEl);
    const scrollSpy = vi.fn();
    scrollEl.scrollTo = scrollSpy as unknown as typeof scrollEl.scrollTo;
    const scrollElementRef = { current: scrollEl };
    const { container } = render(
      <BranchMergedTrace
        registerScroll={registerScroll}
        scrollElementRef={scrollElementRef}
        traceItems={traceItems}
      />,
      { container: scrollEl }
    );
    const eventRow = container.querySelector<HTMLElement>(
      '.st-sysline[data-row="2"]'
    );
    const intoViewSpy = vi.fn();
    if (eventRow) {
      eventRow.scrollIntoView = intoViewSpy;
    }
    // The provider's `registerTraceScroll` only fires on timeline/playhead
    // scrubs, so notifying row 2 must scroll the page container to that row.
    expect(captured.notify).not.toBeNull();
    captured.notify?.(2);
    expect(scrollSpy).toHaveBeenCalled();
    expect(intoViewSpy).not.toHaveBeenCalled();
  });

  it("forwards optional trace-comment props to the shared SessionTrace", async () => {
    const user = userEvent.setup();
    const onSubmitTraceComment = vi.fn();
    const { container } = render(
      <BranchMergedTrace
        onSubmitTraceComment={onSubmitTraceComment}
        traceItems={traceItems}
      />
    );

    selectRenderedText(container, "Hello from");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText("Comment on this passage..."),
      "Branch quote"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmitTraceComment).toHaveBeenCalledWith({
      anchor: expect.objectContaining({
        row: 1,
        selectedText: "Hello from",
        traceId: expect.any(String),
        turnId: expect.any(String),
      }),
      body: "Branch quote",
    });
  });

  it("windows the trace once the bounded viewport reports a height (PLN-1148 Phase 4)", () => {
    // jsdom has no layout, so the trace renders every row by default (the
    // measured-viewport fallback). Fake a measured viewport — a non-zero
    // clientHeight plus a synchronous ResizeObserver — to flip SessionTrace into
    // its virtualized branch, which sizes `.st` and positions rows absolutely.
    const heightSpy = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(400);
    // The virtualizer installs its own ResizeObserver to measure the scroll
    // element, so the stub must deliver a well-formed entry (with size) when it
    // observes — not call back empty.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly callback: (entries: unknown[]) => void;
        constructor(callback: (entries: unknown[]) => void) {
          this.callback = callback;
        }
        observe(target: Element) {
          this.callback([
            {
              target,
              contentRect: { width: 600, height: 400 },
              borderBoxSize: [{ inlineSize: 600, blockSize: 400 }],
            },
          ]);
        }
        unobserve() {
          // no-op
        }
        disconnect() {
          // no-op
        }
      }
    );
    try {
      const { container } = render(
        <BranchMergedTrace traceItems={traceItems} />
      );
      const trace = container.querySelector<HTMLElement>(".st");
      // The windowed branch turns `.st` into a sized, position:relative sizer
      // with absolutely-positioned row wrappers — the fallback leaves both unset.
      expect(trace?.style.position).toBe("relative");
      expect(trace?.style.height).not.toBe("");
      // Content near the top still renders (the trace did not blank out).
      expect(screen.getByText("Hello from the trace")).toBeInTheDocument();
    } finally {
      heightSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

function selectRenderedText(container: HTMLElement, text: string): void {
  const node = findTextNode(container, text);
  if (!node) {
    throw new Error(`Unable to find text node: ${text}`);
  }
  const value = node.textContent ?? "";
  const start = value.indexOf(text);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  const selection = globalThis.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function findTextNode(node: Node, text: string): Text | null {
  if (node.nodeType === Node.TEXT_NODE && node.textContent?.includes(text)) {
    return node as Text;
  }
  for (const child of Array.from(node.childNodes)) {
    const found = findTextNode(child, text);
    if (found) {
      return found;
    }
  }
  return null;
}
