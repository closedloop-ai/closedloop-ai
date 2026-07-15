import {
  BranchCommentsState,
  type BranchDataState,
  BranchDataState as BranchDataStateValue,
  type BranchPageDetail,
  type BranchPrCommentsResponse,
  type BranchSession,
  BranchStatus,
  type MergedTraceItem,
} from "@repo/api/src/types/branch";
import type {
  TraceComment,
  TraceCommentDraft,
  TraceCommentTarget,
} from "@repo/api/src/types/comment";
import {
  createFakeTraceCommentsSource,
  traceCommentTargetKey,
} from "@repo/app/agents/data-source/__tests__/fake-trace-comments-source";
import { TraceCommentsDataSourceProvider } from "@repo/app/agents/data-source/trace-comments-provider";
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
import {
  BranchDetailErrorKind,
  BranchDetailPage,
  type BranchDetailPageProps,
} from "../branch-detail-page";

// PLN-1148 Phase 2: the merged trace is fetched lazily by the Sessions & timeline
// tab via the data-source port, so the test mounts a fake source whose `trace`
// returns the terminal "done" row the timeline reader renders.
const TRACE_FIXTURE: MergedTraceItem[] = [
  { type: "end", sessionId: "s1", text: "done" },
];
const traceFixtureByBranch = new Map<string, readonly MergedTraceItem[]>();
const traceCommentsByTarget = new Map<string, TraceComment[]>();
const fakeBranchesSource: BranchesDataSource = {
  scope: "test",
  list: () => Promise.reject(new Error("list unused")),
  detail: () => Promise.reject(new Error("detail unused")),
  comments: (id) => Promise.resolve(makeCommentsResponse(id)),
  trace: (id) => Promise.resolve(traceFixtureByBranch.get(id) ?? TRACE_FIXTURE),
  usage: () => Promise.reject(new Error("usage unused")),
  analytics: () => Promise.reject(new Error("analytics unused")),
};
const fakeTraceCommentsSource = createFakeTraceCommentsSource({
  commentsByTarget: traceCommentsByTarget,
  makeTraceComment,
});

const BACK_TO_BRANCHES_RE = /back to branches/i;
const SESSIONS_TIMELINE_TAB_RE = /sessions & timeline/i;
// Anchor to the passage "Comment" affordance's exact accessible name so it does
// not also match the rail's "Sort comments" control (a11y label added in
// FEA-2580), which a loose /comment/i would ambiguously resolve.
const COMMENT_BUTTON_NAME_RE = /^comment$/i;

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

function makeCommentsResponse(branchId: string): BranchPrCommentsResponse {
  return {
    branchId,
    state: BranchCommentsState.UnsyncedUnknown,
    comments: [],
    budget: {
      maxComments: 100,
      pageSize: 50,
      maxBodyBytes: 16_384,
      maxResponseBytes: 524_288,
      providerTruncated: false,
      responseTruncated: false,
      omittedComments: 0,
      bodyTruncatedCount: 0,
    },
    providerProofedAt: null,
    stale: false,
    mixedProjection: false,
    prNumber: 42,
    prUrl: "https://github.com/owner/repo/pull/42",
  };
}

function makeSession(): BranchSession {
  return {
    sessionId: "s1",
    slug: null,
    name: "Session one",
    harness: "claude",
    startedAt: "2026-06-17T10:00:00.000Z",
    endedAt: "2026-06-17T11:00:00.000Z",
    isPrimary: true,
    estimatedCostUsd: 1.23,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function makeDetail(
  overrides: Partial<BranchPageDetail> = {}
): BranchPageDetail {
  return {
    id: "b-1",
    branchName: "feature/x",
    baseBranch: "main",
    repoFullName: "owner/repo",
    owner: "alice",
    status: BranchStatus.Open,
    prNumber: 42,
    prTitle: "Add x",
    prState: "OPEN",
    prUrl: "https://github.com/owner/repo/pull/42",
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    lastActivityAt: "2026-06-17T12:00:00.000Z",
    sessionIds: ["s1"],
    prBody: "PR body",
    prBodyHtmlUrl: "https://github.com/owner/repo/pull/42",
    headSha: null,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    openedAt: null,
    commits: [],
    sessions: [makeSession()],
    // PLN-1148 Phase 2: detail no longer carries the trace — it's fetched lazily.
    // Keep this empty so the timeline test's "done" assertion can only be
    // satisfied by the lazy `trace` fetch (TRACE_FIXTURE), not a stale read of
    // detail.mergedTrace — guarding against a regression back to eager hydration.
    mergedTrace: [],
    leadTime: { firstActivityT: null, lastActivityT: null, idleSpans: [] },
    linkedPrNumbers: [42],
    linkedArtifacts: [],
    ...overrides,
  };
}

function baseProps(
  overrides: Partial<BranchDetailPageProps> = {}
): BranchDetailPageProps {
  return {
    branchId: "b-1",
    isLoading: false,
    isError: false,
    backHref: "/branches",
    ...overrides,
  };
}

describe("BranchDetailPage", () => {
  it("shows a skeleton while the first detail read is pending", () => {
    const { container } = render(
      <BranchDetailPage {...baseProps({ isLoading: true })} />
    );
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
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

    expect(screen.getByText("Cost to date")).toBeInTheDocument();
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
    // fixture is unmerged, so the cost panel heads "Cost to date".
    expect(screen.getByText("Cost to date")).toBeInTheDocument();
    expect(screen.getByText("Properties")).toBeInTheDocument();
    expect(screen.queryByText("Contributing sessions")).not.toBeInTheDocument();
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
    expect(screen.queryByText("Cost to date")).not.toBeInTheDocument();
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
    expect(screen.getByText("Cost to date")).toBeInTheDocument();
    expect(screen.queryByText("done")).not.toBeInTheDocument();

    // Re-opening restores the trace instantly from the query cache (staleTime is
    // Infinity under the desktop push model) — the row returns with no second
    // fetch, so re-open stays instant without keeping the subtree mounted.
    await user.click(
      screen.getByRole("tab", { name: SESSIONS_TIMELINE_TAB_RE })
    );
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(screen.queryByText("Cost to date")).not.toBeInTheDocument();
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

    const shell = container.querySelector(".sd3");
    const main = container.querySelector(".sd3-main");
    const timelineScroller = shell?.querySelector(".sd3-scroll");
    const rail = container.querySelector(".sd3-cmts");
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
    expect(rail?.parentElement).toBe(shell);
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

    const shell = container.querySelector<HTMLElement>(".sd3");
    const rail = container.querySelector<HTMLElement>(".sd3-cmts");
    const resizeHandle = container.querySelector<HTMLElement>(".fp-resize");

    if (!(shell && rail && resizeHandle)) {
      throw new Error("Expected the branch comments rail resize handle");
    }

    setElementRect(rail, { left: 600, width: 332 });
    Object.defineProperty(shell, "clientWidth", {
      configurable: true,
      value: 900,
    });
    fireEvent.mouseDown(resizeHandle, { clientX: 700 });
    fireEvent.mouseMove(document, { clientX: 600 });
    fireEvent.mouseUp(document);

    await waitFor(() =>
      expect(shell.style.getPropertyValue("--sd3-cmts-w")).toBe("432px")
    );
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
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText("Comment on this passage..."),
      "Branch note"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(screen.getAllByText("quote target")).toHaveLength(2);
    expect(screen.getByText("Branch note")).toBeInTheDocument();
    expect(
      traceCommentsByTarget.get(
        traceCommentTargetKey({ type: "branch", id: detail.id })
      )
    ).toMatchObject([
      {
        anchor: expect.objectContaining({ selectedText: "quote target" }),
        body: "Branch note",
        surface: "branch_detail",
        target: { type: "branch", id: detail.id },
      },
    ]);

    await user.click(screen.getByText("Branch note"));
    expect(
      document.querySelector("[data-trace-selected-passage]")?.textContent
    ).toBe("quote target");
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
    await user.click(
      screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
    );
    await user.type(
      screen.getByPlaceholderText("Comment on this passage..."),
      "First branch note"
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(screen.getByText("First branch note")).toBeInTheDocument();

    rerender(<BranchDetailPage {...baseProps({ detail: secondDetail })} />);

    expect(
      await screen.findByText("Second branch trace row")
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("First branch note")).not.toBeInTheDocument();
      expect(screen.getByText("No trace comments yet")).toBeInTheDocument();
    });
  });

  it("does not render the descoped conversation rail", () => {
    render(<BranchDetailPage {...baseProps({ detail: makeDetail() })} />);
    expect(screen.queryByText("Conversation")).not.toBeInTheDocument();
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

function makeTraceComment(
  target: TraceCommentTarget,
  draft: TraceCommentDraft,
  index: number
): TraceComment {
  const createdAt = new Date(Date.UTC(2026, 5, 17, 10, index)).toISOString();
  return {
    id: `${target.type}-trace-comment-${index}`,
    threadId: `${target.type}-trace-thread-${index}`,
    target,
    artifactId: target.id,
    surface: target.type === "session" ? "session_detail" : "branch_detail",
    ...draft,
    status: "OPEN",
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
    authorId: "user-test",
    authorName: "Test User",
    authorAvatarUrl: null,
    canEdit: true,
    canDelete: true,
    replies: [],
  };
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

function setElementRect(
  element: HTMLElement | null,
  rect: Pick<DOMRect, "left" | "width">
) {
  if (!element) {
    return;
  }
  element.getBoundingClientRect = () =>
    ({
      bottom: 0,
      height: 0,
      left: rect.left,
      right: rect.left + rect.width,
      top: 0,
      width: rect.width,
      x: rect.left,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}
