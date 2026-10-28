import { BranchDataState } from "@repo/api/src/types/branch";
import {
  CommentTargetType,
  type TraceTextAnchor,
} from "@repo/api/src/types/comment";
import { SharedAnalyticsComponent } from "@repo/api/src/types/surface-analytics";
import {
  CommentsPaneOpenKey,
  useEndCommentsPaneTransient,
} from "@repo/app/shared/components/comments/use-comments-pane-state";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createRef, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchDetailRefreshState } from "../branch-detail-page";
import { BranchShellView } from "../branch-shell-view";
import { populatedDetail } from "../branch-story-metric-fixtures";
import type { BranchCommentsPaneProps } from "../comments/branch-comments-pane";

const {
  readDetailsProps,
  readWorkspaceProps,
  readPanelProps,
  readActivityProps,
  readPaneProps,
  readTraceOptions,
  readRenderedEvent,
  onReady,
  selectTabThenReveal,
  trace,
  route,
} = vi.hoisted(() => ({
  readDetailsProps: vi.fn(),
  readWorkspaceProps: vi.fn(),
  readPanelProps: vi.fn(),
  readActivityProps: vi.fn(),
  readPaneProps: vi.fn(),
  readTraceOptions: vi.fn(),
  readRenderedEvent: vi.fn(),
  onReady: vi.fn(),
  selectTabThenReveal: vi.fn(),
  trace: {
    data: undefined as unknown,
    isLoading: false,
    loadMore: vi.fn(),
    retryPage: vi.fn(),
    isFetchNextPageError: true,
    isFetchingNextPage: false,
    hasNextPage: true,
  },
  route: {
    listeners: new Set<() => void>(),
    tab: "artifact" as ArtifactDetailTab,
  },
}));

vi.mock("../comments/branch-comments-pane", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../comments/branch-comments-pane")
  >()),
  BranchCommentsPane: (props: BranchCommentsPaneProps) => {
    readPaneProps(props);
    return null;
  },
}));

// The Artifact panel keeps a draft so a tab round-trip can prove retention.
vi.mock("../detail/branch-selected-pull-request-workspace", () => ({
  BranchSelectedPullRequestWorkspace: (props: Record<string, unknown>) => {
    readWorkspaceProps(props);
    return <input aria-label="Retained Artifact draft" defaultValue="" />;
  },
}));
vi.mock("../branch-properties-panel", () => ({
  BranchPropertiesPanel: () => <span>Production properties</span>,
}));
vi.mock("../branch-shell-collaborators", () => ({
  BranchShellCollaborators: ({ branchId }: { branchId: string }) => (
    <span>Header collaborators for {branchId}</span>
  ),
}));
vi.mock("../branch-shell-details", () => ({
  BranchShellDetails: (props: Record<string, unknown>) => {
    readDetailsProps(props);
    return <span>Production Details with collaborators</span>;
  },
}));
vi.mock("../detail/branch-sessions-timeline-tab", () => ({
  BranchSessionsTimelinePanel: (props: Record<string, unknown>) => {
    readPanelProps(props);
    return <span>Production Sessions</span>;
  },
}));
// Stubbed like its sibling panels: the real one mounts its own read through the
// Branches data source and the navigation port, neither of which this suite
// stands up. What it RENDERS is pinned by
// `detail/__tests__/branch-shell-activity.test.tsx`; what this suite owns is
// that the shell composes it and hands it the branch.
vi.mock("../detail/branch-shell-activity", () => ({
  BranchShellActivity: (props: Record<string, unknown>) => {
    readActivityProps(props);
    return <span>Production Activity</span>;
  },
}));
/**
 * Only the component is stubbed; the module's real `BranchDetailRefreshState`
 * stays, and the stub makes "delegated to the legacy page" observable without
 * standing up the auth, api and comments providers that page mounts.
 */
vi.mock("../branch-detail-page", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../branch-detail-page")>()),
  BranchDetailPage: () => <span>{LEGACY_PAGE}</span>,
}));
vi.mock("../../hooks/use-branch-trace-pages", () => ({
  useBranchTracePages: (_id: string, options?: { enabled?: boolean }) => {
    readTraceOptions(options);
    return trace;
  },
}));
vi.mock("@repo/app/shared/observability/surface-analytics-context", () => ({
  useSharedComponentRenderedEvent: (component: string) => {
    readRenderedEvent(component);
  },
}));
vi.mock(
  "@repo/app/shared/components/artifact-detail-shell/use-artifact-detail-tab-route",
  () => ({
    // One tab for every reader, as the URL is: the shell and its header's
    // comments toggle both read it.
    useArtifactDetailTabRoute: () => {
      const activeTab = useSyncExternalStore(
        (listener) => {
          route.listeners.add(listener);
          return () => route.listeners.delete(listener);
        },
        () => route.tab
      );
      const setActiveTab = (tab: ArtifactDetailTab) => {
        route.tab = tab;
        for (const listener of route.listeners) {
          listener();
        }
      };
      return {
        activeTab,
        setActiveTab,
        onActivePanelReady: onReady,
        selectTabThenReveal,
      };
    },
  })
);

/** The shipped alert's own title, so a copy change reds here too. */
const STALE_NOTICE_TITLE = "Latest branch details unavailable";

/** The delegation target's stand-in. */
const LEGACY_PAGE = "Legacy Branch detail page";

/** The Details stand-in; the header carries its own collaborators widget. */
const DETAILS_WITH_COLLABORATORS = "Production Details with collaborators";

const select = (name: string) =>
  fireEvent.mouseDown(screen.getByRole("tab", { name }), {
    button: 0,
    ctrlKey: false,
  });

describe("BranchShellView", () => {
  // The pane is stubbed here, so nothing ends a transient reveal but this.
  afterEach(() => {
    route.tab = ArtifactDetailTab.Artifact;
    globalThis.localStorage.clear();
    renderHook(() => {
      useEndCommentsPaneTransient(ARTIFACT_OPEN, null);
      useEndCommentsPaneTransient(SESSIONS_OPEN, null);
    }).unmount();
  });

  it("renders the four approved tabs in order", () => {
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={populatedDetail()}
        isError={false}
        isLoading={false}
      />
    );
    // Restated rather than read from the shared list on purpose: a reorder of
    // the approved order is a product decision, so it should fail here and be
    // re-approved (it already moved once — ISS-12167, operator 2026-10-07).
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Artifact",
      "Sessions",
      "Details",
      "Activity",
    ]);
  });

  it("hands Details the host's session route, so linked session rows open (PLN-2175 M3)", () => {
    route.tab = ArtifactDetailTab.Details;
    const getSessionHref = (id: string) => `/sessions/${id}`;
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={populatedDetail()}
        getSessionHref={getSessionHref}
        isError={false}
        isLoading={false}
      />
    );

    expect(readDetailsProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ getSessionHref })
    );
  });

  it("puts today's Branch details content on Artifact and keeps it mounted across tabs", async () => {
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={populatedDetail()}
        isError={false}
        isLoading={false}
      />
    );
    // ISS-12267 removed the Properties card; the mock above stays so a
    // reinstated card would render this text and fail here.
    expect(screen.queryByText("Production properties")).not.toBeInTheDocument();
    const draft = screen.getByRole("textbox", {
      name: "Retained Artifact draft",
    });
    fireEvent.change(draft, { target: { value: "Draft in progress" } });

    select("Details");
    expect(screen.getByText(DETAILS_WITH_COLLABORATORS)).toBeInTheDocument();
    // keepMountedTabs=[Artifact]: still mounted, just hidden.
    expect(draft).toBeInTheDocument();
    expect(draft).not.toBeVisible();

    select("Artifact");
    expect(draft).toHaveValue("Draft in progress");
    await waitFor(() => expect(onReady).toHaveBeenCalled());
  });

  /**
   * ISS-10980 replaces the shell's `unsupported` Activity state with the live
   * feed, so the assertion that USED to hold here — the panel reading
   * "Activity / Unavailable" — is obsoleted by this change and kept below as
   * the counterfactual rather than deleted.
   */
  it("mounts the live Activity panel for this branch instead of the unsupported state", () => {
    // The fixture's own id equals the `branchId` the prop carries, so it is
    // overridden here: without that, the assertion below cannot tell the
    // artifact id from the route key and passes on either.
    const detail = { ...populatedDetail(), id: "b-artifact-1" };
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={detail}
        isError={false}
        isLoading={false}
      />
    );
    select("Activity");
    // Scoped to the panel: "Activity" is also the tab's own label, so an
    // unscoped query matches the button too.
    const panel = within(screen.getByRole("tabpanel"));
    expect(panel.getByText("Production Activity")).toBeInTheDocument();
    expect(panel.queryByText("Unavailable")).not.toBeInTheDocument();
    // The DETAIL's id, not the `branchId` prop: that prop is often
    // `encodeBranchId(repo, name)` rather than the artifact UUID the activity
    // route addresses, which is the same split the trace read observes.
    expect(readActivityProps).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: detail.id })
    );
  });

  it("holds the Activity read until Activity is the active tab", () => {
    readActivityProps.mockClear();
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={populatedDetail()}
        isError={false}
        isLoading={false}
      />
    );

    expect(readActivityProps).not.toHaveBeenCalled();
  });

  it("owns the trace read and hands the Sessions panel its data as props", () => {
    const data = { sessions: [] };
    trace.data = data;
    trace.isLoading = false;
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={populatedDetail()}
        isError={false}
        isLoading={false}
      />
    );
    select("Sessions");
    expect(screen.getByText("Production Sessions")).toBeInTheDocument();
    // ISS-10797 moved the fetch out of BranchSessionsTimelineTab into the
    // adapter; the panel must receive it rather than fetch its own.
    expect(readPanelProps).toHaveBeenCalledWith(
      expect.objectContaining({
        trace: {
          data,
          isLoading: false,
          loadMore: trace.loadMore,
          retryPage: trace.retryPage,
          isRetrying: false,
          hasMore: true,
        },
      })
    );
  });

  it("holds the trace read until Sessions is the active tab", () => {
    readTraceOptions.mockClear();
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={populatedDetail()}
        isError={false}
        isLoading={false}
      />
    );
    // Lifting the fetch into this always-mounted adapter removed the laziness
    // the legacy page got from Radix unmounting its inactive tab, so the gate
    // has to be explicit or every Branch open pays for the trace.
    expect(readTraceOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false })
    );

    select("Sessions");
    expect(readTraceOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true })
    );
  });

  it("keeps the Branch detail page's own mount event", () => {
    readRenderedEvent.mockClear();
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={populatedDetail()}
        isError={false}
        isLoading={false}
      />
    );
    // Decomposing the legacy page into panels left its mount event behind, so
    // a dashboard keyed on this value went quiet under the flag.
    expect(readRenderedEvent).toHaveBeenCalledWith(
      SharedAnalyticsComponent.BranchDetailPage
    );
  });

  it("keeps the backfill alert as page chrome, on every tab", () => {
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={populatedDetail()}
        isError={false}
        isLoading={false}
        refreshState={BranchDetailRefreshState.Error}
      />
    );
    // Operator ruling, 2026-10-07: this alert is a GitHub backfill-start
    // failure (ISS-12225), not a claim about any tab's data — so it is page
    // chrome above the shell, never a tab state. It therefore survives every
    // tab change, including Activity, and stays exactly one in the a11y tree.
    for (const tab of ["Details", "Sessions", "Activity"]) {
      const alerts = screen.getAllByRole("alert");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toHaveTextContent(STALE_NOTICE_TITLE);
      select(tab);
    }
    const onActivity = screen.getAllByRole("alert");
    expect(onActivity).toHaveLength(1);
    expect(onActivity[0]).toHaveTextContent(STALE_NOTICE_TITLE);
    // The alert is chrome, so the Activity panel still renders beneath it
    // rather than being replaced by it. (It read "Unavailable" here until
    // ISS-10980 gave Activity its feed.)
    expect(
      within(screen.getByRole("tabpanel")).getByText("Production Activity")
    ).toBeInTheDocument();
  });

  it("gives the page its only heading", () => {
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={populatedDetail()}
        isError={false}
        isLoading={false}
      />
    );
    // The web route sets suppressPageHeading because the page body owns the
    // h1. Without this the shell renders none at all (tamsinb, #8514).
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent(populatedDetail().branchName);
  });

  it("puts Artifact, Details and Activity on the framed canvas card, and leaves Sessions its own scroller (ISS-12412)", () => {
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={populatedDetail()}
        isError={false}
        isLoading={false}
      />
    );
    const card = (tab: string, label: string) =>
      within(screen.getByRole("tabpanel", { name: tab })).getByRole("region", {
        name: label,
      });
    // The card holds the tab's content.
    const artifact = card("Artifact", "Branch");
    expect(artifact).toHaveAttribute("data-artifact-frame", "framed");
    expect(
      within(artifact).getByRole("textbox", { name: "Retained Artifact draft" })
    ).toBeInTheDocument();

    select("Details");
    const details = card("Details", "Branch details");
    expect(details).toHaveAttribute("data-artifact-frame", "framed");
    expect(within(details).getByText(DETAILS_WITH_COLLABORATORS)).toBeVisible();

    select("Activity");
    const activity = card("Activity", "Branch activity");
    expect(activity).toHaveAttribute("data-artifact-frame", "framed");
    expect(within(activity).getByText("Production Activity")).toBeVisible();

    select("Sessions");
    // The timeline owns its scroller; this parent is what sizes it.
    const sessions = screen.getByRole("tabpanel", { name: "Sessions" });
    expect(
      sessions.querySelector(`.${CSS.escape("overflow-hidden")}`)
    ).not.toBeNull();
    expect(sessions.querySelector("[data-artifact-frame]")).toBeNull();
  });

  it("shows collaborators in the header on every tab, and in Details too", () => {
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={populatedDetail()}
        isError={false}
        isLoading={false}
      />
    );
    // ISS-12267 (operator ruling) reversed ISS-10963's Details-only design.
    expect(
      screen.getByText(`Header collaborators for ${populatedDetail().id}`)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(DETAILS_WITH_COLLABORATORS)
    ).not.toBeInTheDocument();

    select("Details");
    expect(
      screen.getByText(`Header collaborators for ${populatedDetail().id}`)
    ).toBeInTheDocument();
    expect(screen.getByText(DETAILS_WITH_COLLABORATORS)).toBeInTheDocument();
  });

  it.each([BranchDataState.AwaitingSync, BranchDataState.NotPresent])(
    "hands %s back to the legacy page instead of showing tabs",
    (dataState) => {
      render(
        <BranchShellView
          backHref="/branches"
          branchId="b-1"
          detail={{ ...populatedDetail(), dataState }}
          isError={false}
          isLoading={false}
        />
      );
      // ISS-10963: awaiting-sync and not-present "replace the whole shell". These
      // arrive on a LOADED detail, so delegating only on `!detail` left a branch
      // the provider says is gone rendering four normal tabs and its properties,
      // telling the user nothing (tamsinb, #8514).
      expect(screen.getByText(LEGACY_PAGE)).toBeInTheDocument();
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
    }
  );

  it("keeps rendering the tabs for a branch with no sessions", () => {
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={{
          ...populatedDetail(),
          dataState: BranchDataState.NoSessions,
        }}
        isError={false}
        isLoading={false}
      />
    );
    // The counterfactual to the pair above: ISS-10963 moves no-sessions into
    // the Sessions tab body rather than replacing the page, so this one must
    // NOT delegate.
    expect(screen.queryByText(LEGACY_PAGE)).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
  });

  it("owns the selected pull request so it scopes the Artifact panel", () => {
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={populatedDetail()}
        isError={false}
        isLoading={false}
      />
    );
    expect(readWorkspaceProps).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: "b-1", selection: null })
    );
  });

  it("mounts the comments pane on the Branch artifact, returning focus to the host's toggle", () => {
    const toggleRef = createRef<HTMLButtonElement>();
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        commentsControl={{ onOpenChange: vi.fn(), open: true, toggleRef }}
        detail={{ ...populatedDetail(), artifactId: BRANCH_ARTIFACT_ID }}
        isError={false}
        isLoading={false}
      />
    );
    expect(readPaneProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeTab: ArtifactDetailTab.Artifact,
        branchArtifactId: BRANCH_ARTIFACT_ID,
        selectTabThenReveal,
      })
    );
    expect(readPaneProps.mock.lastCall?.[0].returnFocusRef).toBe(toggleRef);
    // The host's header carries the toggle; the shell adds no second one.
    expect(screen.queryByRole("button", { name: HIDE_COMMENTS })).toBeNull();

    select("Sessions");
    expect(readPaneProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeTab: ArtifactDetailTab.Sessions })
    );
  });

  /**
   * ISS-10980: the Activity tab's comment rows link with `?comment=`, which
   * each shell's route host reads off the URL. The shell's job is to hand that
   * address to the pane — without it the link opens the right tab and then
   * does nothing, which is what shipped before this.
   */
  it("hands the pane the thread a `?comment=` link addressed", () => {
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={{ ...populatedDetail(), artifactId: BRANCH_ARTIFACT_ID }}
        isError={false}
        isLoading={false}
        selectedThreadId="thread-7"
      />
    );

    expect(readPaneProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ addressedThreadId: "thread-7" })
    );
  });

  it("hands the pane no address when the URL names none", () => {
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={{ ...populatedDetail(), artifactId: BRANCH_ARTIFACT_ID }}
        isError={false}
        isLoading={false}
      />
    );

    expect(readPaneProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ addressedThreadId: undefined })
    );
  });

  /**
   * whitlockk, #8619: an addressed GitHub thread on another pull request is only
   * listed once that pull request is selected, so the pane's switch has to
   * reach the SAME selection the Artifact canvas reads.
   */
  it("lets the pane select the pull request the Artifact canvas shows", () => {
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={{ ...populatedDetail(), artifactId: BRANCH_ARTIFACT_ID }}
        isError={false}
        isLoading={false}
      />
    );
    const selection = {
      pullRequestNumber: 2,
      repositoryFullName: "closedloop-ai/closedloop-ai",
    };

    act(() => readPaneProps.mock.lastCall?.[0].onSelectPullRequest(selection));

    expect(readWorkspaceProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ selection })
    );
  });

  it("hands the pane the timeline's Sessions, selection and selected PR, and the timeline its jump", () => {
    globalThis.localStorage.setItem(SESSIONS_OPEN, "false");
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={populatedDetail()}
        isError={false}
        isLoading={false}
      />
    );
    const pane = (): BranchCommentsPaneProps =>
      readPaneProps.mock.lastCall?.[0];
    act(() =>
      readWorkspaceProps.mock.lastCall?.[0].onCommentsContextChange({
        error: false,
        loading: false,
        pullRequestKey: "closedloop-ai/closedloop-ai#7",
      })
    );
    expect(pane().selectedPullRequestKey).toBe("closedloop-ai/closedloop-ai#7");

    select("Sessions");
    expect(screen.getByRole("button", { name: SHOW_COMMENTS })).toBeVisible();
    const panel = () => readPanelProps.mock.lastCall?.[0];
    const rendered = { coverageNote: "Partial", sessionIds: ["s-1"] };
    act(() => panel().onRenderedSessionsChange(rendered));
    expect(pane().renderedSessions).toEqual(rendered);

    const target = {
      anchor: { id: "a", label: "ok", trace: JUMP_ANCHOR },
      target: { id: "s-1", type: CommentTargetType.Session },
    };
    act(() => panel().onComposerTargetChange(target));
    expect(pane().composerTarget).toBe(target);
    // A selection opens the pane on its composer for this visit only
    // (ISS-12300 D6): the saved preference stays hidden.
    expect(screen.getByRole("button", { name: HIDE_COMMENTS })).toBeVisible();
    expect(globalThis.localStorage.getItem(SESSIONS_OPEN)).toBe("false");

    act(() => pane().onRevealTraceAnchor(JUMP_ANCHOR));
    expect(panel().pendingJumpAnchor).toBe(JUMP_ANCHOR);
  });

  it("carries its own per-tab comments toggle where the host has none, and none on Details or Activity", () => {
    render(
      <BranchShellView
        backHref="/branches"
        branchId="b-1"
        detail={populatedDetail()}
        isError={false}
        isLoading={false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: HIDE_COMMENTS }));
    expect(screen.getByRole("button", { name: SHOW_COMMENTS })).toBeVisible();
    expect(globalThis.localStorage.getItem(ARTIFACT_OPEN)).toBe("false");

    select("Sessions");
    expect(screen.getByRole("button", { name: HIDE_COMMENTS })).toBeVisible();
    for (const tab of ["Details", "Activity"]) {
      select(tab);
      expect(screen.queryByRole("button", { name: SHOW_COMMENTS })).toBeNull();
      expect(screen.queryByRole("button", { name: HIDE_COMMENTS })).toBeNull();
    }
  });
});

const ARTIFACT_OPEN = CommentsPaneOpenKey.BranchArtifact;
const SESSIONS_OPEN = CommentsPaneOpenKey.BranchSessions;

const BRANCH_ARTIFACT_ID = "branch-artifact-1";
/** `CommentsPaneToggleButton`'s own labels. */
const SHOW_COMMENTS = "Show comments rail";
const HIDE_COMMENTS = "Hide comments rail";
const JUMP_ANCHOR: TraceTextAnchor = {
  endOffset: 2,
  row: 11,
  selectedText: "ok",
  sessionId: "s-1",
  sourceText: "ok",
  startOffset: 0,
  traceId: "trace",
  turnId: "turn-11",
};
