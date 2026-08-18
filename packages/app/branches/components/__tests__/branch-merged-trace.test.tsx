import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  BranchTraceUnavailableReason,
  type MergedTraceItem,
} from "@repo/api/src/types/branch-trace";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { buildActorColorDomain } from "../../lib/branch-actor-domain";
import { BranchMergedTrace } from "../branch-merged-trace";

// FEA-3490: TraceCommentsRail resolves persisted @-mention IDs to labels via
// useOrganizationUsers. BranchMergedTrace renders that rail outside an auth
// provider here, so stub the org-member query to an empty list.
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [] }),
}));

const NO_TRACE_RE = /no trace captured/i;
const COMMENT_BUTTON_NAME_RE = /comment/i;
const UNAVAILABLE_SESSION_RE = /Unavailable Session/;
const CUMULATIVE_COST_RE = /Cumulative:/;
const SESSION_TOTAL_RE = /done · Session total \$3\.00/;
const ANY_SESSION_TOTAL_RE = /Session total/;
const NO_MERGED_TRACE_RE = /No merged trace/;
const SESSION_TRACE_UNAVAILABLE_RE = /^Session trace unavailable$/;
const SOME_SESSION_TRACES_UNAVAILABLE_RE =
  /^Some Session traces are unavailable$/;
const GENERIC_PARTIAL_TRACE_UNAVAILABLE_RE =
  /^Some Session trace activity is unavailable$/;

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
  it("renders two actor initials in the right gutter using the Branch color domain", () => {
    const actorDomain = buildActorColorDomain(["alice", "bob"]);
    render(
      <BranchMergedTrace
        actorDomain={actorDomain}
        traceItems={[
          ...traceItems.slice(0, 2),
          {
            type: "prompt",
            sessionId: "s1",
            t: "2026-06-10T10:01:30.000Z",
            tMs: 0,
            cumCostUsd: null,
            actorName: "bob",
            text: "Please continue",
          },
        ]}
      />
    );

    const alice = screen.getByLabelText("alice");
    const bob = screen.getByLabelText("bob");
    expect(alice).toHaveTextContent("A");
    expect(bob).toHaveTextContent("B");
    expect(alice.firstElementChild).toHaveStyle({
      background: actorDomain.colorPairFor("alice").soft,
      color: actorDomain.colorPairFor("alice").strong,
    });
    expect(bob.firstElementChild).toHaveStyle({
      background: actorDomain.colorPairFor("bob").soft,
      color: actorDomain.colorPairFor("bob").strong,
    });
  });

  it("renders via the shared SessionTrace (st-* markup) with the trace content", () => {
    const { container } = render(<BranchMergedTrace traceItems={traceItems} />);
    // Reuses the agents SessionTrace: its root is `.st`, not a bespoke renderer.
    expect(container.querySelector(".st")).not.toBeNull();
    expect(screen.getByText("Hello from the trace")).toBeInTheDocument();
    expect(screen.getByText("Commit pushed")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("renders the empty state only for a complete empty trace", () => {
    render(
      <BranchMergedTrace
        traceItems={[]}
        traceState={{
          aggregateCompleteness: {
            state: BranchTraceCompletenessState.Complete,
          },
          completeness: { state: BranchTraceCompletenessState.Complete },
          qualifyingSessionCount: 0,
          sessions: [],
        }}
      />
    );
    expect(screen.getByText(NO_TRACE_RE)).toBeInTheDocument();
    expect(
      screen.queryByText(SESSION_TRACE_UNAVAILABLE_RE)
    ).not.toBeInTheDocument();
  });

  it("treats missing trace state as unavailable instead of genuinely empty", () => {
    render(<BranchMergedTrace traceItems={[]} />);

    expect(screen.getByText(SESSION_TRACE_UNAVAILABLE_RE)).toBeVisible();
    expect(screen.queryByText(NO_MERGED_TRACE_RE)).not.toBeInTheDocument();
  });

  it("shows aggregate unavailable copy with named Sessions instead of an empty trace", () => {
    render(
      <BranchMergedTrace
        traceItems={[]}
        traceState={{
          aggregateCompleteness: {
            reason: BranchTraceUnavailableReason.Permission,
            state: BranchTraceCompletenessState.Unavailable,
          },
          completeness: {
            reason: BranchTraceUnavailableReason.Permission,
            state: BranchTraceCompletenessState.Unavailable,
          },
          qualifyingSessionCount: 2,
          sessions: [
            unavailableSession("session-1", "Implementation Session"),
            unavailableSession("session-2", "Review Session"),
          ],
        }}
      />
    );

    expect(screen.getByText(SESSION_TRACE_UNAVAILABLE_RE)).toBeVisible();
    expect(
      screen.getByText(
        "Linked Sessions remain part of this Branch. Trace activity could not be loaded for: Implementation Session, Review Session."
      )
    ).toBeVisible();
    expect(screen.queryByText(NO_MERGED_TRACE_RE)).not.toBeInTheDocument();
    expect(
      screen.queryByText(SOME_SESSION_TRACES_UNAVAILABLE_RE)
    ).not.toBeInTheDocument();
  });

  it("shows aggregate unavailable copy when Session identities are unknown", () => {
    render(
      <BranchMergedTrace
        traceItems={[]}
        traceState={{
          aggregateCompleteness: {
            reason: BranchTraceUnavailableReason.LegacyResponse,
            state: BranchTraceCompletenessState.Unavailable,
          },
          completeness: {
            reason: BranchTraceUnavailableReason.LegacyResponse,
            state: BranchTraceCompletenessState.Unavailable,
          },
          qualifyingSessionCount: null,
          sessions: [],
        }}
      />
    );

    expect(screen.getByText(SESSION_TRACE_UNAVAILABLE_RE)).toBeVisible();
    expect(
      screen.getByText(
        "Linked Sessions remain part of this Branch, but their trace activity could not be loaded."
      )
    ).toBeVisible();
    expect(screen.queryByText(NO_MERGED_TRACE_RE)).not.toBeInTheDocument();
  });

  it("keeps loaded turns visible and names unavailable Sessions during partial hydration", () => {
    render(
      <BranchMergedTrace
        traceItems={traceItems}
        traceState={{
          aggregateCompleteness: {
            state: BranchTraceCompletenessState.Incomplete,
          },
          completeness: { state: BranchTraceCompletenessState.Incomplete },
          qualifyingSessionCount: 2,
          sessions: [
            {
              identity: {
                artifactId: "session-1",
                externalSessionId: "s1",
                name: "Loaded Session",
                navigableRef: "SES-1",
                slug: "SES-1",
              },
              state: BranchTraceSessionHydrationState.Loaded,
            },
            {
              identity: {
                artifactId: "session-2",
                externalSessionId: "s2",
                name: "Unavailable Session",
                navigableRef: "SES-2",
                slug: "SES-2",
              },
              reason: BranchTraceUnavailableReason.Permission,
              state: BranchTraceSessionHydrationState.Unavailable,
            },
          ],
        }}
      />
    );

    expect(screen.getByText("Hello from the trace")).toBeInTheDocument();
    expect(screen.getByText(UNAVAILABLE_SESSION_RE)).toBeInTheDocument();
    expect(screen.getByText(SOME_SESSION_TRACES_UNAVAILABLE_RE)).toBeVisible();
    expect(
      screen.getByText(
        "Loaded trace turns remain visible. Unavailable: Unavailable Session."
      )
    ).toBeVisible();
  });

  it("keeps loaded turns visible with generic partial copy when identities are unknown", () => {
    render(
      <BranchMergedTrace
        traceItems={traceItems}
        traceState={{
          aggregateCompleteness: {
            reason: BranchTraceUnavailableReason.LegacyResponse,
            state: BranchTraceCompletenessState.Unavailable,
          },
          completeness: {
            reason: BranchTraceUnavailableReason.LegacyResponse,
            state: BranchTraceCompletenessState.Unavailable,
          },
          qualifyingSessionCount: null,
          sessions: [],
        }}
      />
    );

    expect(screen.getByText("Hello from the trace")).toBeVisible();
    expect(
      screen.getByText(GENERIC_PARTIAL_TRACE_UNAVAILABLE_RE)
    ).toBeVisible();
    expect(
      screen.getByText(
        "Loaded trace turns remain visible. Additional Session trace activity could not be loaded."
      )
    ).toBeVisible();
  });

  it("does not add an unavailable warning for truncation-only evidence", () => {
    render(
      <BranchMergedTrace
        traceItems={traceItems}
        traceState={{
          aggregateCompleteness: {
            eventsTruncated: true,
            state: BranchTraceCompletenessState.Incomplete,
          },
          completeness: {
            eventsTruncated: true,
            state: BranchTraceCompletenessState.Incomplete,
          },
          qualifyingSessionCount: 1,
          sessions: [],
        }}
      />
    );

    expect(screen.getByText("Hello from the trace")).toBeVisible();
    expect(
      screen.queryByText(SESSION_TRACE_UNAVAILABLE_RE)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(SOME_SESSION_TRACES_UNAVAILABLE_RE)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(GENERIC_PARTIAL_TRACE_UNAVAILABLE_RE)
    ).not.toBeInTheDocument();
  });

  it("does not render the genuine-empty state for zero-item truncation evidence", () => {
    render(
      <BranchMergedTrace
        traceItems={[]}
        traceState={{
          aggregateCompleteness: {
            eventsTruncated: true,
            state: BranchTraceCompletenessState.Incomplete,
          },
          completeness: {
            eventsTruncated: true,
            state: BranchTraceCompletenessState.Incomplete,
          },
          qualifyingSessionCount: 1,
          sessions: [],
        }}
      />
    );

    expect(screen.queryByText(NO_MERGED_TRACE_RE)).not.toBeInTheDocument();
    expect(
      screen.queryByText(SESSION_TRACE_UNAVAILABLE_RE)
    ).not.toBeInTheDocument();
  });

  it("shows Session totals only for complete aggregate evidence", () => {
    const sessionTotals = [
      { label: "Session one", sessionId: "s1", totalCostUsd: 3 },
    ];
    const completeState = {
      aggregateCompleteness: {
        state: BranchTraceCompletenessState.Complete,
      },
      completeness: { state: BranchTraceCompletenessState.Complete },
      qualifyingSessionCount: 1,
      sessions: [],
    };
    const { rerender } = render(
      <BranchMergedTrace
        sessionTotals={sessionTotals}
        traceItems={traceItems}
        traceState={completeState}
      />
    );
    expect(screen.getByText(SESSION_TOTAL_RE)).toBeVisible();

    rerender(
      <BranchMergedTrace
        sessionTotals={sessionTotals}
        traceItems={traceItems}
        traceState={{
          ...completeState,
          aggregateCompleteness: {
            state: BranchTraceCompletenessState.Incomplete,
          },
        }}
      />
    );
    expect(screen.queryByText(ANY_SESSION_TOTAL_RE)).not.toBeInTheDocument();
  });

  it("renders per-turn deltas without exposing a cumulative running total", () => {
    const costItems: MergedTraceItem[] = [
      {
        actor: { harness: "claude", name: "Agent" },
        sessionId: "cost-session",
        t: "2026-06-10T10:00:00.000Z",
        type: "sessionstart",
      },
      {
        actorName: "Agent",
        cumCostUsd: 1,
        sessionId: "cost-session",
        t: "2026-06-10T10:01:00.000Z",
        text: "First agent turn",
        tMs: Date.parse("2026-06-10T10:01:00.000Z"),
        type: "say",
      },
      {
        actorName: "Human",
        cumCostUsd: 1,
        sessionId: "cost-session",
        t: "2026-06-10T10:02:00.000Z",
        text: "Continue",
        tMs: Date.parse("2026-06-10T10:02:00.000Z"),
        type: "prompt",
      },
      {
        actorName: "Agent",
        cumCostUsd: 3,
        sessionId: "cost-session",
        t: "2026-06-10T10:03:00.000Z",
        text: "Second agent turn",
        tMs: Date.parse("2026-06-10T10:03:00.000Z"),
        type: "say",
      },
    ];

    render(<BranchMergedTrace traceItems={costItems} />);

    expect(screen.getByText("$1.00")).toBeVisible();
    expect(screen.getByText("$2.00")).toBeVisible();
    expect(screen.queryByTitle(CUMULATIVE_COST_RE)).not.toBeInTheDocument();
    expect(screen.queryByText("$3.00")).not.toBeInTheDocument();
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

function unavailableSession(artifactId: string, name: string) {
  return {
    identity: {
      artifactId,
      externalSessionId: artifactId,
      name,
      navigableRef: artifactId,
      slug: artifactId,
    },
    reason: BranchTraceUnavailableReason.Permission,
    state: BranchTraceSessionHydrationState.Unavailable,
  } as const;
}

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
