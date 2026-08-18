/**
 * Regression coverage for the Session-detail freeze: a scroll-driven `activeRow`
 * change must NOT re-render every mounted trace row (and re-render its markdown
 * body). Before the row components were memoized, the non-virtualized agents
 * Session detail page re-rendered all N rows on every scroll frame — an O(N)
 * main-thread pass per frame that hung the page on large sessions. Here we count
 * `TraceMarkdown` renders across an `activeRow` change and assert only the rows
 * whose active-ness actually flipped re-rendered.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Count TraceMarkdown renders per body text. Mocking is scoped to this file so
// the main session-trace suite (which asserts on real rendered markdown) is
// unaffected.
const markdownRenderCounts = new Map<string, number>();
vi.mock("../trace-markdown", () => ({
  TraceMarkdown: ({ text }: { text: string }) => {
    markdownRenderCounts.set(text, (markdownRenderCounts.get(text) ?? 0) + 1);
    return <div data-testid="trace-md">{text}</div>;
  },
}));

// Imported after the mock is registered (vitest hoists vi.mock above imports).
import { SessionTrace, type SessionTraceItem } from "../session-trace";

afterEach(() => {
  cleanup();
  markdownRenderCounts.clear();
});

const agentActor = {
  name: "claude-opus-4-8",
  sessionId: "s1",
  human: null,
  color: "var(--primary)",
};

const humanActor = {
  name: "LD",
  sessionId: "s1",
  human: "LD",
  color: "#000",
};

function sayItem(row: number, text: string): SessionTraceItem {
  return {
    type: "say",
    _row: row,
    t: "00:00",
    tMs: row,
    cum: 0,
    actor: agentActor,
    text,
  };
}

function promptItem(row: number, text: string): SessionTraceItem {
  return {
    type: "prompt",
    _row: row,
    t: "00:00",
    tMs: row,
    cum: 0,
    actor: humanActor,
    text,
  };
}

// Alternate human/agent turns so each row is its OWN message group (a run of
// same-side same-session turns would coalesce into a single group, hiding the
// per-row memoization the freeze fix depends on).
function alternatingRow(row: number): SessionTraceItem {
  return row % 2 === 0
    ? promptItem(row, `row-body-${row}`)
    : sayItem(row, `row-body-${row}`);
}

describe("SessionTrace render count on activeRow change", () => {
  it("re-renders only the rows whose active state flips, not every row", () => {
    const items: SessionTraceItem[] = Array.from({ length: 20 }, (_, index) =>
      alternatingRow(index)
    );

    const { rerender } = render(
      <SessionTrace activeRow={null} items={items} />
    );

    // Every body rendered exactly once on the initial mount.
    for (let index = 0; index < items.length; index += 1) {
      expect(markdownRenderCounts.get(`row-body-${index}`)).toBe(1);
    }

    // Scroll moves the active row from none → row 5, then row 5 → row 6. Each
    // step is one `activeRow` change, like a scroll frame.
    rerender(<SessionTrace activeRow={5} items={items} />);
    rerender(<SessionTrace activeRow={6} items={items} />);

    // Only the rows whose active-ness actually flipped re-render, and they
    // re-render EXACTLY as many times as they flipped. Every OTHER row's
    // markdown must stay at its single initial render. Asserting the exact
    // per-row count (not a >=1 lower bound that the initial mount already
    // satisfies) means this test fails if the fix regresses and a scroll frame
    // re-renders a row it shouldn't:
    //   - row 5: mount (1) + null→5 flip false→true (2) + 5→6 flip true→false
    //            (3) = 3 renders
    //   - row 6: mount (1) + 5→6 flip false→true (2) = 2 renders
    // This is the property that keeps the scroll O(1) instead of O(N).
    const expectedRenders = new Map<number, number>([
      [5, 3],
      [6, 2],
    ]);
    for (let index = 0; index < items.length; index += 1) {
      const count = markdownRenderCounts.get(`row-body-${index}`);
      expect(count).toBe(expectedRenders.get(index) ?? 1);
    }
  });
});
