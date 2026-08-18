import {
  type BranchDataState,
  BranchDataState as BranchDataStateValue,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  type MergedTraceItem,
} from "@repo/api/src/types/branch-trace";
import type { TraceComment } from "@repo/api/src/types/comment";
import {
  createFakeTraceCommentsSource,
  traceCommentTargetKey,
} from "@repo/app/agents/data-source/__tests__/fake-trace-comments-source";
import { TraceCommentsDataSourceProvider } from "@repo/app/agents/data-source/trace-comments-provider";
import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { BranchesDataSource } from "../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import { BranchDetailErrorKind, BranchDetailPage } from "../branch-detail-page";
import {
  baseProps,
  makeCommentsResponse,
  makeDetail,
  makeSession,
  makeTraceComment,
} from "./branch-detail-page.fixtures";

// PLN-1148 Phase 2: the merged trace is fetched lazily by the Sessions & timeline
// tab via the data-source port, so the test mounts a fake source whose `trace`
// returns the terminal "done" row the timeline reader renders.
const TRACE_FIXTURE: MergedTraceItem[] = [
  {
    actorName: "Test User",
    cumCostUsd: null,
    sessionId: "s1",
    t: "2026-06-17T10:00:00.000Z",
    tMs: 0,
    text: "done",
    type: "say",
  },
];
const traceFixtureByBranch = new Map<string, readonly MergedTraceItem[]>();
const traceCommentsByTarget = new Map<string, TraceComment[]>();
const fakeBranchesSource: BranchesDataSource = {
  scope: "test",
  list: () => Promise.reject(new Error("list unused")),
  detail: () => Promise.reject(new Error("detail unused")),
  comments: (id) => Promise.resolve(makeCommentsResponse(id)),
  trace: (id) => {
    const items = [...(traceFixtureByBranch.get(id) ?? TRACE_FIXTURE)];
    const sessionIds = [...new Set(items.map((item) => item.sessionId))];
    return Promise.resolve({
      aggregateCompleteness: {
        state: BranchTraceCompletenessState.Complete,
      },
      completeness: { state: BranchTraceCompletenessState.Complete },
      items,
      qualifyingSessionCount: sessionIds.length,
      sessions: sessionIds.map((sessionId) => ({
        identity: {
          artifactId: sessionId,
          name: null,
          navigableRef: sessionId,
          slug: null,
        },
        state: BranchTraceSessionHydrationState.Loaded,
      })),
    });
  },
  usage: () => Promise.reject(new Error("usage unused")),
  analytics: () => Promise.reject(new Error("analytics unused")),
  pageData: () => Promise.reject(new Error("pageData unused")),
};
const fakeTraceCommentsSource = createFakeTraceCommentsSource({
  commentsByTarget: traceCommentsByTarget,
  makeTraceComment,
});

const BACK_TO_BRANCHES_RE = /back to branches/i;
const SESSIONS_TIMELINE_TAB_RE = /sessions & timeline/i;
const LEAD_TIME_FOR_CHANGE_RE = /^lead time for change$/i;
const REPLY_BUTTON_NAME_RE = /reply to comment/i;
// The two Sessions & timeline section headers each render "· N session(s)" in a
// `.bq-act-sub`: the PR timeline (FEA-4269 distinct-session count) and the
// Combined session trace. The distinct count for two linked sessions is 2.
const TWO_SESSIONS_SUB_RE = /·\s*2 sessions/;
// The singular sub for ONE distinct session ("· 1 session", no trailing "s"):
// the count both headers must show when the branch carries the SAME session
// duplicated across two PR links (raw length 2, distinct 1).
const ONE_SESSION_SUB_RE = /·\s*1 session\b/;
// `.bq-act-title` textContent includes the trailing `.bq-act-sub` ("· 2
// sessions"), so match the title's leading label, not an anchored exact string.
const COMBINED_SESSION_TRACE_RE = /^Combined session trace/;
const PR_TIMELINE_TITLE_RE = /^PR timeline/;

// The Epic F overlays (files-changed, PR status, refresh) issue gateway reads
// through window.fetch — stub it so they degrade to the not-connected fallback
// rather than hitting the network in unit tests.
beforeEach(() => {
  traceFixtureByBranch.clear();
  traceCommentsByTarget.clear();
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: false,
    status: 404,
    json: () => Promise.resolve({}),
  } as Response);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// The not-found state renders the navigation-port <Link> (needs a
// <NavigationProvider>); the Epic F overlays need a React Query client.
function render(ui: ReactElement) {
  // AppCoreStoryProviders mounts every @repo/app port (query, navigation, auth,
  // api) — auth/api are needed because the Sessions & timeline tab's lazy
  // `useBranchTrace` resolves through `useBranchesDataSource` → `useApiClient`
  // (PLN-1148 Phase 2). The branch source is injected so `trace` is served.
  return rtlRender(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders>
        <TraceCommentsDataSourceProvider dataSource={fakeTraceCommentsSource}>
          <BranchesDataSourceProvider dataSource={fakeBranchesSource}>
            {children}
          </BranchesDataSourceProvider>
        </TraceCommentsDataSourceProvider>
      </AppCoreStoryProviders>
    ),
  });
}

describe("BranchDetailPage", () => {
  it("keeps the populated Branch details surface free of critical WCAG 2.2 AA violations", async () => {
    const { container } = render(
      <BranchDetailPage {...baseProps({ detail: makeDetail() })} />
    );

    await expectCriticalAxeClean(container);
  });

  it("shows a skeleton while the first detail read is pending", () => {
    const { container } = render(
      <BranchDetailPage {...baseProps({ isLoading: true })} />
    );
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  // FEA-4292: BranchDetailPage forwards the `getArtifactHref` seam down to the
  // "What was delivered" panel. Without the forwarding line the artifact renders
  // as an inert label, so asserting the rendered link proves the wiring — not
  // just that the prop was accepted.
  it("forwards getArtifactHref to the delivered panel so a recognized artifact links (FEA-4292)", () => {
    render(
      <BranchDetailPage
        {...baseProps({
          detail: makeDetail({ linkedArtifacts: [{ slug: "FEA-3595" }] }),
          getArtifactHref: (slug) => `/acme/issues/${slug}`,
        })}
      />
    );

    const link = screen.getByRole("link", { name: "Issue FEA-3595" });
    expect(link).toHaveAttribute("href", "/acme/issues/FEA-3595");
  });

  it("leaves the artifact inert when no getArtifactHref seam is injected (desktop parity, FEA-4292)", () => {
    render(
      <BranchDetailPage
        {...baseProps({
          detail: makeDetail({ linkedArtifacts: [{ slug: "FEA-3595" }] }),
        })}
      />
    );

    expect(screen.getByText("FEA-3595")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Issue FEA-3595" })
    ).not.toBeInTheDocument();
  });

  it("renders provider errors separately from not-present branches", () => {
    render(<BranchDetailPage {...baseProps({ isError: true })} />);
    expect(screen.getByText("Branch provider unavailable")).toBeInTheDocument();
    const back = screen.getByRole("link", { name: BACK_TO_BRANCHES_RE });
    expect(back).toHaveAttribute("href", "/branches");
  });

  it("renders the not-found state with a Back to Branches link for not-present errors", () => {
    render(
      <BranchDetailPage
        {...baseProps({
          errorKind: BranchDetailErrorKind.NotPresent,
          isError: true,
        })}
      />
    );
    expect(screen.getByText("Branch not found")).toBeInTheDocument();
    const back = screen.getByRole("link", { name: BACK_TO_BRANCHES_RE });
    expect(back).toHaveAttribute("href", "/branches");
  });

  it("renders the no-sessions invite CTA when the branch has no sessions", () => {
    render(
      <BranchDetailPage
        {...baseProps({ detail: makeDetail({ sessions: [] }) })}
      />
    );
    expect(
      screen.getByText("No sessions on this branch yet")
    ).toBeInTheDocument();
    // No tab chrome in the empty state — just the invite CTA.
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("renders an awaiting-sync state from typed detail dataState", () => {
    render(
      <BranchDetailPage
        {...baseProps({
          detail: makeDetail({
            dataState: BranchDataStateValue.AwaitingSync,
            sessions: [],
            sessionIds: [],
          }),
        })}
      />
    );

    expect(screen.getByText("Branch sync in progress")).toBeInTheDocument();
    expect(
      screen.queryByText("No sessions on this branch yet")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("renders a not-present state from typed detail dataState", () => {
    render(
      <BranchDetailPage
        {...baseProps({
          detail: makeDetail({
            dataState: BranchDataStateValue.NotPresent,
            sessions: [],
            sessionIds: [],
          }),
        })}
      />
    );

    expect(screen.getByText("Branch no longer present")).toBeInTheDocument();
    expect(
      screen.queryByText("No sessions on this branch yet")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("keeps no-sessions distinct for typed and compatibility detail payloads", () => {
    const { rerender } = render(
      <BranchDetailPage
        {...baseProps({
          detail: makeDetail({
            dataState: BranchDataStateValue.NoSessions,
            sessions: [],
            sessionIds: [],
          }),
        })}
      />
    );

    expect(
      screen.getByText("No sessions on this branch yet")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Branch sync in progress")
    ).not.toBeInTheDocument();

    rerender(
      <BranchDetailPage
        {...baseProps({
          detail: makeDetail({
            sessions: [],
            sessionIds: [],
          }),
        })}
      />
    );

    expect(
      screen.getByText("No sessions on this branch yet")
    ).toBeInTheDocument();
  });

  it("falls back to ready rendering for unknown newer dataState values with sessions", () => {
    render(
      <BranchDetailPage
        {...baseProps({
          detail: makeDetail({
            dataState: "newer_state" as BranchDataState,
          }),
        })}
      />
    );

    expect(screen.getByText("Cost breakdown")).toBeInTheDocument();
    expect(
      screen.queryByText("No sessions on this branch yet")
    ).not.toBeInTheDocument();
  });

  it("renders both tabs with Branch details active by default", () => {
    render(<BranchDetailPage {...baseProps({ detail: makeDetail() })} />);
    const branchTab = screen.getByRole("tab", { name: "Branch details" });
    const sessionsTab = screen.getByRole("tab", {
      name: SESSIONS_TIMELINE_TAB_RE,
    });
    expect(branchTab).toHaveAttribute("aria-selected", "true");
    expect(sessionsTab).toHaveAttribute("aria-selected", "false");
    // Branch-details panels (Epic D) are shown; the sessions-tab slots are not
    // yet mounted (deferred to Epic E). Properties sits above the tabs. The
    // The cost panel retains the PRD/prototype heading across lifecycle states.
    expect(screen.getByText("Cost breakdown")).toBeInTheDocument();
    expect(screen.getByText("Properties")).toBeInTheDocument();
    expect(screen.queryByText("Contributing sessions")).not.toBeInTheDocument();
  });

  it("shows the selected-cycle lead-time card and matching waterfall heading", () => {
    render(<BranchDetailPage {...baseProps({ detail: makeDetail() })} />);
    expect(screen.getAllByText(LEAD_TIME_FOR_CHANGE_RE)).toHaveLength(2);
  });

  it("opens on the Sessions & timeline tab when initialTab requests it (mention deep-link, FEA-3490)", () => {
    render(
      <BranchDetailPage
        {...baseProps({ detail: makeDetail() })}
        initialTab="sessions-timeline"
      />
    );

    expect(screen.getByRole("tab", { name: "Branch details" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    expect(
      screen.getByRole("tab", { name: SESSIONS_TIMELINE_TAB_RE })
    ).toHaveAttribute("aria-selected", "true");
    // The trace tab is live on first paint, so a mention's commented trace is
    // on screen immediately rather than behind the default Branch-details tab.
    expect(screen.queryByText("Cost breakdown")).not.toBeInTheDocument();
  });

  it("switches to the Sessions & timeline tab", async () => {
    const user = userEvent.setup();
    render(<BranchDetailPage {...baseProps({ detail: makeDetail() })} />);

    // Radix Tabs activate on mousedown/focus, so drive the switch through
    // user-event rather than fireEvent.click.
    await user.click(
      screen.getByRole("tab", { name: SESSIONS_TIMELINE_TAB_RE })
    );

    // Epic E renders the real Sessions & timeline content — the merged-trace
    // reader shows the lazily-fetched trace's terminal "done" row (PLN-1148
    // Phase 2: awaited, since the tab fetches the trace on open); the
    // Branch-details cost panel is no longer mounted on this tab.
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(screen.queryByText("Cost breakdown")).not.toBeInTheDocument();
  });

  it("unmounts the Sessions trace on return to Branch details, then restores it from cache on re-open", async () => {
    const user = userEvent.setup();
    const traceSpy = vi.spyOn(fakeBranchesSource, "trace");
    render(<BranchDetailPage {...baseProps({ detail: makeDetail() })} />);

    // First open fetches the trace lazily — the terminal "done" row appears.
    await user.click(
      screen.getByRole("tab", { name: SESSIONS_TIMELINE_TAB_RE })
    );
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(traceSpy).toHaveBeenCalledTimes(1);

    // Switching back to Branch details unmounts the Sessions panel (Radix mounts
    // it only while active), so the PR timeline / combined trace must NOT leak
    // onto the Branch details tab (FEA-2337). The Branch-details cost panel is
    // back, and the trace's "done" row is gone.
    await user.click(screen.getByRole("tab", { name: "Branch details" }));
    expect(screen.getByText("Cost breakdown")).toBeInTheDocument();
    expect(screen.queryByText("done")).not.toBeInTheDocument();

    // Re-opening restores the trace instantly from the query cache (staleTime is
    // Infinity under the desktop push model) — the row returns with no second
    // fetch, so re-open stays instant without keeping the subtree mounted.
    await user.click(
      screen.getByRole("tab", { name: SESSIONS_TIMELINE_TAB_RE })
    );
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(screen.queryByText("Cost breakdown")).not.toBeInTheDocument();
    expect(traceSpy).toHaveBeenCalledTimes(1);
  });

  it("renders timeline comments as a page-level right rail", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <BranchDetailPage {...baseProps({ detail: makeDetail() })} />
    );

    await user.click(
      screen.getByRole("tab", { name: SESSIONS_TIMELINE_TAB_RE })
    );
    expect(await screen.findByText("done")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Show comments rail" })
    );

    const shell = container.querySelector(".sd3");
    const main = container.querySelector(".sd3-main");
    const timelineScroller = shell?.querySelector(".sd3-scroll");
    const rail = screen.getByRole("complementary", { name: "Comments" });
    const timelinePanel = shell?.closest('[data-slot="tabs-content"]');
    expect(shell).toBeInTheDocument();
    expect(main).toBeInTheDocument();
    expect(timelineScroller).toBeInTheDocument();
    expect(rail).toBeInTheDocument();
    expect(shell).toHaveClass("bq-sessions-workspace", "sd3");
    expect(timelinePanel).toHaveClass(
      "flex",
      "min-h-0",
      "flex-1",
      "overflow-hidden"
    );
    expect(timelineScroller).toHaveClass("bq-page-scroll", "sd3-scroll");
    expect(timelinePanel?.parentElement).toHaveAttribute("data-slot", "tabs");
    expect(main?.parentElement).toBe(shell);
    expect(timelineScroller?.parentElement).toBe(main);
    expect(rail.previousElementSibling).toHaveAttribute("data-slot", "tabs");
    expect(shell?.contains(rail)).toBe(false);
    expect(main?.contains(rail)).toBe(false);
    expect(timelineScroller?.contains(rail)).toBe(false);
    expect(container.querySelector(".bq-trace-comments-layout")).toBeNull();
    expect(shell?.closest(".max-w-\\[1000px\\]")).toBeNull();
  });

  it("supports production comments rail resize in the Sessions & timeline tab", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <BranchDetailPage {...baseProps({ detail: makeDetail() })} />
    );

    await user.click(
      screen.getByRole("tab", { name: SESSIONS_TIMELINE_TAB_RE })
    );
    expect(await screen.findByText("done")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Show comments rail" })
    );

    const shell = container.querySelector<HTMLElement>(".sd3");
    const rail = screen.getByRole("complementary", {
      name: "Comments",
    });
    const resizeHandle = screen.getByRole("separator", {
      name: "Resize comments rail",
    });

    if (!(shell && rail && resizeHandle)) {
      throw new Error("Expected the branch comments rail resize handle");
    }

    fireEvent.pointerDown(resizeHandle, { clientX: 700 });
    fireEvent.pointerMove(globalThis.window, { clientX: 600 });
    fireEvent.pointerUp(globalThis.window);

    await waitFor(() => expect(rail).toHaveStyle({ width: "440px" }));
  });

  it("supports keyboard resizing with bounded separator values", async () => {
    const user = userEvent.setup();
    render(<BranchDetailPage {...baseProps({ detail: makeDetail() })} />);

    await user.click(
      screen.getByRole("button", { name: "Show comments rail" })
    );
    const resizeHandle = screen.getByRole("separator", {
      name: "Resize comments rail",
    });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "340");

    fireEvent.keyDown(resizeHandle, { key: "ArrowLeft" });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "356");
    fireEvent.keyDown(resizeHandle, { key: "Home" });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "280");
    fireEvent.keyDown(resizeHandle, { key: "End" });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "560");
  });

  it("pins the timeline marker to the end when the trace scroller reaches bottom", async () => {
    const user = userEvent.setup();
    const detail = makeDetail();
    traceFixtureByBranch.set(detail.id, [
      {
        type: "sessionstart",
        sessionId: "s1",
        t: "2026-06-17T10:00:00.000Z",
        actor: { name: "alice", harness: "claude" },
      },
      {
        type: "say",
        sessionId: "s1",
        t: "2026-06-17T10:30:00.000Z",
        tMs: 0,
        cumCostUsd: null,
        actorName: "alice",
        text: "Middle timestamp before session end",
      },
      { type: "end", sessionId: "s1", text: "Terminal trace row" },
    ]);
    const { container } = render(
      <BranchDetailPage {...baseProps({ detail })} />
    );

    await user.click(
      screen.getByRole("tab", { name: SESSIONS_TIMELINE_TAB_RE })
    );
    expect(
      await screen.findByText("Middle timestamp before session end")
    ).toBeInTheDocument();

    const timelineScroller =
      container.querySelector<HTMLElement>(".sd3-scroll");
    if (!timelineScroller) {
      throw new Error("Expected the Sessions & timeline scroller");
    }

    Object.defineProperty(timelineScroller, "clientHeight", {
      configurable: true,
      value: 100,
    });
    Object.defineProperty(timelineScroller, "scrollHeight", {
      configurable: true,
      value: 500,
    });
    timelineScroller.scrollTop = 400;
    fireEvent.scroll(timelineScroller);

    await waitFor(() => {
      expect(
        container.querySelector<HTMLElement>(".bq-bars-wrap .tl-here")?.style
          .left
      ).toBe("100%");
      expect(container.querySelector(".bq-bar:last-child")).toHaveClass("hot");
    });
  });

  it("stores selected-passage branch trace comments through the trace comments source", async () => {
    const user = userEvent.setup();
    const detail = makeDetail({
      mergedTrace: [
        {
          type: "say",
          sessionId: "s1",
          t: "2026-06-17T10:05:00.000Z",
          tMs: 0,
          cumCostUsd: null,
          actorName: "alice",
          text: "Branch trace quote target",
        },
      ],
    });
    const { container } = render(
      <BranchDetailPage {...baseProps({ detail })} />
    );
    traceFixtureByBranch.set(detail.id, detail.mergedTrace);

    await user.click(
      screen.getByRole("tab", { name: SESSIONS_TIMELINE_TAB_RE })
    );
    selectRenderedText(container, "quote target");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    await user.type(
      screen.getByPlaceholderText("Add a trace comment..."),
      "Branch note"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(screen.getByText("quote target")).toBeInTheDocument();
    expect(screen.getByText("Branch note")).toBeInTheDocument();
    expect(
      traceCommentsByTarget.get(
        traceCommentTargetKey({ type: "session", id: "s1" })
      )
    ).toMatchObject([
      {
        anchor: expect.objectContaining({ selectedText: "quote target" }),
        body: "Branch note",
        surface: "session_detail",
        target: { type: "session", id: "s1" },
      },
    ]);

    await user.click(
      screen.getByRole("button", { name: "Jump to quote target" })
    );
    expect(
      document.querySelector("[data-trace-selected-passage]")?.textContent
    ).toBe("quote target");
  });

  it("closes the narrow comments sheet after jumping to a trace passage", async () => {
    stubMatchMedia((query) => query === "(max-width: 1024px)");
    const user = userEvent.setup();
    const detail = makeDetail({
      mergedTrace: [
        {
          type: "say",
          sessionId: "s1",
          t: "2026-06-17T10:05:00.000Z",
          tMs: 0,
          cumCostUsd: null,
          actorName: "alice",
          text: "Narrow trace quote target",
        },
      ],
    });
    traceFixtureByBranch.set(detail.id, detail.mergedTrace);
    const { container } = render(
      <BranchDetailPage {...baseProps({ detail })} />
    );

    await user.click(
      screen.getByRole("tab", { name: SESSIONS_TIMELINE_TAB_RE })
    );
    selectRenderedText(container, "quote target");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    await user.type(
      screen.getByPlaceholderText("Add a trace comment..."),
      "Narrow branch note"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Jump to quote target" })
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(
      document.querySelector("[data-trace-selected-passage]")?.textContent
    ).toBe("quote target");
  });

  it("posts a threaded reply to the rendered Session that owns the selected trace passage", async () => {
    const user = userEvent.setup();
    const detail = makeDetail({
      mergedTrace: [
        {
          type: "say",
          sessionId: "s1",
          t: "2026-06-17T10:05:00.000Z",
          tMs: 0,
          cumCostUsd: null,
          actorName: "alice",
          text: "Branch trace quote target",
        },
      ],
    });
    const { container } = render(
      <BranchDetailPage {...baseProps({ detail })} />
    );
    traceFixtureByBranch.set(detail.id, detail.mergedTrace);

    // Create a comment on the rendered Session first so there is a thread to reply to.
    await user.click(
      screen.getByRole("tab", { name: SESSIONS_TIMELINE_TAB_RE })
    );
    selectRenderedText(container, "quote target");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    await user.type(
      screen.getByPlaceholderText("Add a trace comment..."),
      "Branch note"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(screen.getByText("Branch note")).toBeInTheDocument();

    // Reply to it in-UI: open the composer, type, and submit.
    await user.click(
      screen.getByRole("button", { name: REPLY_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText("Add a comment..."),
      "Branch reply body"
    );
    await user.click(screen.getByRole("button", { name: "Reply" }));

    // The reply renders threaded under its parent with author + timestamp.
    const replyText = await screen.findByText("Branch reply body");
    expect(replyText).toBeInTheDocument();
    expect(screen.getByText("Branch note")).toBeInTheDocument();

    // Both writes stay on the exact rendered Session target. Branch timeline
    // is reserved for passages whose Session is outside the rendered set.
    const sessionKey = traceCommentTargetKey({ type: "session", id: "s1" });
    expect([...traceCommentsByTarget.keys()]).toEqual([sessionKey]);
    expect(traceCommentsByTarget.get(sessionKey)?.[0]?.replies).toMatchObject([
      { body: "Branch reply body" },
    ]);
  });

  it("shows the next branch's persisted trace comments when the mounted detail changes branches", async () => {
    const user = userEvent.setup();
    const firstDetail = makeDetail({
      id: "b-1",
      branchName: "feature/first",
      mergedTrace: [
        {
          type: "say",
          sessionId: "s1",
          t: "2026-06-17T10:05:00.000Z",
          tMs: 0,
          cumCostUsd: null,
          actorName: "alice",
          text: "First branch quote target",
        },
      ],
    });
    const secondDetail = makeDetail({
      id: "b-2",
      branchName: "feature/second",
      mergedTrace: [
        {
          type: "say",
          sessionId: "s2",
          t: "2026-06-17T10:10:00.000Z",
          tMs: 0,
          cumCostUsd: null,
          actorName: "bob",
          text: "Second branch trace row",
        },
      ],
      sessions: [{ ...makeSession(), sessionId: "s2", name: "Session two" }],
    });
    traceFixtureByBranch.set(firstDetail.id, firstDetail.mergedTrace);
    traceFixtureByBranch.set(secondDetail.id, secondDetail.mergedTrace);
    const { container, rerender } = render(
      <BranchDetailPage {...baseProps({ detail: firstDetail })} />
    );

    await user.click(
      screen.getByRole("tab", { name: SESSIONS_TIMELINE_TAB_RE })
    );
    selectRenderedText(container, "quote target");
    fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
    await user.type(
      screen.getByPlaceholderText("Add a trace comment..."),
      "First branch note"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(screen.getByText("First branch note")).toBeInTheDocument();

    rerender(<BranchDetailPage {...baseProps({ detail: secondDetail })} />);

    await user.click(
      screen.getByRole("tab", { name: SESSIONS_TIMELINE_TAB_RE })
    );
    expect(
      await screen.findByText("Second branch trace row")
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Show comments rail" })
    );
    await waitFor(() => {
      expect(screen.queryByText("First branch note")).not.toBeInTheDocument();
      expect(screen.getByText("No comments in this view")).toBeInTheDocument();
    });
  });

  it("agrees between the Combined session trace and the PR timeline on the distinct-session count for a merged PR (FEA-4269)", async () => {
    // shafty023 review (PR #3939): mounting the timeline in isolation never
    // proves the *separately* rendered Combined session trace agrees with it.
    // Drive the real Sessions & timeline tab of BranchDetailPage with a MERGED
    // PR and CONSISTENT linked sessions (`sessionIds` === the session ids, no
    // duplicate rows) so both surfaces read the same session set, then assert
    // the two headers show the SAME distinct-session count. The tab is opened
    // via `initialTab` so no user interaction is needed to mount both surfaces.
    const sessionA = {
      ...makeSession(),
      sessionId: "s1",
      name: "Session one",
      startedAt: "2026-06-17T10:00:00.000Z",
      endedAt: "2026-06-17T11:00:00.000Z",
      ownerUserName: "Alice",
    };
    const sessionB = {
      ...makeSession(),
      sessionId: "s2",
      name: "Session two",
      startedAt: "2026-06-17T13:00:00.000Z",
      endedAt: "2026-06-17T14:00:00.000Z",
      ownerUserName: "Bob",
    };
    const detail = makeDetail({
      status: BranchStatus.Merged,
      prState: "MERGED",
      mergedAt: "2026-06-17T15:00:00.000Z",
      estimatedCostUsd: 4.5,
      // Consistent: the branch's linked-session ids match its session rows.
      sessionIds: ["s1", "s2"],
      sessions: [sessionA, sessionB],
    });
    // The lazily fetched trace references BOTH linked sessions, matching the
    // production merged-PR shape (a combined trace across the branch's sessions).
    traceFixtureByBranch.set(detail.id, [
      {
        type: "sessionstart",
        sessionId: "s1",
        t: "2026-06-17T10:00:00.000Z",
        actor: { name: "Alice", harness: "claude" },
      },
      {
        type: "say",
        sessionId: "s2",
        t: "2026-06-17T13:00:00.000Z",
        tMs: 0,
        cumCostUsd: null,
        actorName: "Bob",
        text: "second session trace row",
      },
    ]);

    render(
      <BranchDetailPage
        {...baseProps({ detail })}
        initialTab="sessions-timeline"
      />
    );

    // Wait for the lazy trace to resolve (the Combined session trace body renders
    // the second session's row).
    expect(
      await screen.findByText("second session trace row")
    ).toBeInTheDocument();

    // Both section headers exist and both report the distinct-session count (2).
    // The count is derived from `distinctSessions` (deduped by id) in the
    // timeline; with a consistent, non-duplicated fixture the raw and distinct
    // counts coincide, so the two surfaces MUST agree. Each header owns a
    // `.bq-act-title` whose `.bq-act-sub` carries "· N session(s)".
    const prTimelineSub = findSectionSub(PR_TIMELINE_TITLE_RE);
    const combinedTraceSub = findSectionSub(COMBINED_SESSION_TRACE_RE);
    expect(prTimelineSub).toMatch(TWO_SESSIONS_SUB_RE);
    expect(combinedTraceSub).toMatch(TWO_SESSIONS_SUB_RE);
    // The two independently rendered surfaces AGREE on the count.
    expect(combinedTraceSub).toBe(prTimelineSub);
  });

  it("shows the SAME distinct count on both headers when one session is duplicated across two PR links (FEA-4269, shafty023)", async () => {
    // shafty023 review (PR #3939): the real production bug the earlier test
    // missed. When the SAME session appears in TWO PR links, `detail.sessions`
    // carries duplicate rows (raw length 2), but the timeline dedupes by
    // `sessionId` (distinct 1). Before the fix the Combined session trace header
    // read raw `detail.sessions.length` ("2") while the PR timeline read the
    // distinct count ("1") — the two headers DISAGREED. Both must now derive
    // from the ONE shared `distinctSessionCount`, so both read "1 session".
    const duplicatedSession = {
      ...makeSession(),
      sessionId: "s1",
      name: "Session one",
      startedAt: "2026-06-17T10:00:00.000Z",
      endedAt: "2026-06-17T11:00:00.000Z",
      ownerUserName: "Alice",
    };
    const detail = makeDetail({
      status: BranchStatus.Merged,
      prState: "MERGED",
      mergedAt: "2026-06-17T15:00:00.000Z",
      estimatedCostUsd: 4.5,
      sessionIds: ["s1"],
      // The SAME session id twice — one row per PR link. Raw length 2, distinct 1.
      sessions: [duplicatedSession, { ...duplicatedSession }],
    });
    traceFixtureByBranch.set(detail.id, [
      {
        type: "sessionstart",
        sessionId: "s1",
        t: "2026-06-17T10:00:00.000Z",
        actor: { name: "Alice", harness: "claude" },
      },
      {
        type: "say",
        sessionId: "s1",
        t: "2026-06-17T10:30:00.000Z",
        tMs: 0,
        cumCostUsd: null,
        actorName: "Alice",
        text: "duplicated session trace row",
      },
    ]);

    render(
      <BranchDetailPage
        {...baseProps({ detail })}
        initialTab="sessions-timeline"
      />
    );

    expect(
      await screen.findByText("duplicated session trace row")
    ).toBeInTheDocument();

    const prTimelineSub = findSectionSub(PR_TIMELINE_TITLE_RE);
    const combinedTraceSub = findSectionSub(COMBINED_SESSION_TRACE_RE);
    // Both headers show the DISTINCT count "1 session", never the raw "2".
    expect(prTimelineSub).toMatch(ONE_SESSION_SUB_RE);
    expect(combinedTraceSub).toMatch(ONE_SESSION_SUB_RE);
    expect(combinedTraceSub).not.toMatch(TWO_SESSIONS_SUB_RE);
    // The two independently rendered surfaces AGREE on the count — the fix.
    expect(combinedTraceSub).toBe(prTimelineSub);
  });

  it("does not render the descoped conversation rail", () => {
    render(<BranchDetailPage {...baseProps({ detail: makeDetail() })} />);
    expect(screen.queryByText("Conversation")).not.toBeInTheDocument();
  });
});

// Returns the `.bq-act-sub` text ("· N sessions") of the Sessions & timeline
// section whose `.bq-act-title` starts with the given title (PR timeline or
// Combined session trace). The two headers share the `.bq-act-title`/`.bq-act-sub`
// shape, so the title regex disambiguates which section's count is read.
function findSectionSub(titleRe: RegExp): string {
  const titles = Array.from(
    document.querySelectorAll<HTMLElement>(".bq-act-title")
  );
  const match = titles.find((el) => titleRe.test(el.textContent ?? ""));
  const sub = match?.querySelector<HTMLElement>(".bq-act-sub");
  if (!sub?.textContent) {
    throw new Error(`No .bq-act-sub for section title ${titleRe}`);
  }
  return sub.textContent;
}

function stubMatchMedia(matcher: (query: string) => boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        addEventListener: () => undefined,
        addListener: () => undefined,
        dispatchEvent: () => false,
        matches: matcher(query),
        media: query,
        onchange: null,
        removeEventListener: () => undefined,
        removeListener: () => undefined,
      }) as MediaQueryList
  );
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
