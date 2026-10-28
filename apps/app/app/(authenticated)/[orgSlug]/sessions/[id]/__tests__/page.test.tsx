import { AgentComponentInvocationAnchorKind } from "@repo/api/src/types/agent-component-invocation";
import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsPageName,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import {
  Surface,
  type SurfaceAnalyticsCapture,
} from "@repo/api/src/types/surface-analytics";
import { createAgentSessionDetailFixture } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import { ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SessionDetailPage from "../page";

const {
  featureFlagEnabledMock,
  headerMock,
  routeParamsMock,
  searchParamsMock,
  sharedDetailViewMock,
  sharedShellViewMock,
  shellTab,
  useAgentSessionDetailMock,
} = vi.hoisted(() => ({
  shellTab: { value: "sessions" },
  featureFlagEnabledMock: vi.fn(),
  headerMock: vi.fn(),
  routeParamsMock: vi.fn(),
  searchParamsMock: vi.fn(),
  sharedDetailViewMock: vi.fn(),
  sharedShellViewMock: vi.fn(),
  useAgentSessionDetailMock: vi.fn(),
}));

vi.mock("@repo/app/agents/components/detail/agent-session-detail-view", () => ({
  AgentSessionDetailView: sharedDetailViewMock,
}));

vi.mock("@repo/app/agents/components/detail/agent-session-shell-view", () => ({
  AgentSessionShellView: sharedShellViewMock,
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionDetail: useAgentSessionDetailMock,
}));

// ISS-5574: this page test renders without a FeatureFlagAdapterProvider, so stub
// the flag hook. Default-off; a hoisted `vi.fn()` so a test can opt a flag on.
// (Tab-title behavior itself is covered in `page-tab-title.test.tsx`.)
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (flag: string) => featureFlagEnabledMock(flag),
  useFeatureFlagEnabledOptional: (flag: string) => featureFlagEnabledMock(flag),
}));

vi.mock("@repo/navigation/use-route-params", () => ({
  useRouteParams: routeParamsMock,
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: searchParamsMock,
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

vi.mock(
  "@repo/app/shared/components/artifact-detail-shell/use-artifact-detail-tab-route",
  () => ({
    useArtifactDetailTabRoute: () => ({ activeTab: shellTab.value }),
  })
);

describe("org session detail wrapper", () => {
  beforeEach(() => {
    featureFlagEnabledMock.mockReset();
    featureFlagEnabledMock.mockReturnValue(false);
    headerMock.mockReset();
    routeParamsMock.mockReset();
    searchParamsMock.mockReset();
    sharedDetailViewMock.mockReset();
    sharedShellViewMock.mockReset();
    useAgentSessionDetailMock.mockReset();
    globalThis.localStorage.clear();
    shellTab.value = ArtifactDetailTab.Sessions;
    routeParamsMock.mockReturnValue({ id: "session-detail-1" });
    searchParamsMock.mockReturnValue(new URLSearchParams());
    useAgentSessionDetailMock.mockReturnValue({
      data: createAgentSessionDetailFixture(),
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    });
    headerMock.mockReturnValue(<div data-testid="header" />);
    sharedDetailViewMock.mockReturnValue(<div data-testid="shared-detail" />);
    sharedShellViewMock.mockReturnValue(<div data-testid="shared-shell" />);
  });

  it("mounts the shared shell with the existing session inputs under the shared key", () => {
    featureFlagEnabledMock.mockImplementation(
      (key: string) => key === ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY
    );
    render(<SessionDetailPage />);
    expect(screen.getByTestId("shared-shell")).toBeDefined();
    expect(sharedDetailViewMock).not.toHaveBeenCalled();
    expect(sharedShellViewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        session: useAgentSessionDetailMock.mock.results[0]?.value.data,
        backHref: "/acme/sessions",
        commentsRailOpen: true,
        buildTranscriptFileHref: expect.any(Function),
        buildArtifactHref: expect.any(Function),
        getBranchHref: expect.any(Function),
      }),
      undefined
    );
    expect(useAgentSessionDetailMock).toHaveBeenCalledTimes(1);
  });

  // PRD-736: page_viewed[session_detail] is the aha-moment anchor, so it may
  // only count a session that actually rendered — a 404 or failed detail read
  // shows an error state, not a session, and must not cross the boundary.
  it("emits the aha page_viewed only when the detail read succeeds", () => {
    const capture = vi.fn<SurfaceAnalyticsCapture>();
    const pageViewedCalls = () =>
      capture.mock.calls.filter(
        ([event]) => event === OnboardingAnalyticsEvent.PageViewed
      );

    useAgentSessionDetailMock.mockReturnValue({
      data: undefined,
      isFetching: false,
      isLoading: false,
      isSuccess: false,
      refetch: vi.fn(),
    });
    const failed = render(
      <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
        <SessionDetailPage />
      </SurfaceAnalyticsProvider>
    );
    expect(pageViewedCalls()).toHaveLength(0);
    failed.unmount();

    useAgentSessionDetailMock.mockReturnValue({
      data: createAgentSessionDetailFixture(),
      isFetching: false,
      isLoading: false,
      isSuccess: true,
      refetch: vi.fn(),
    });
    render(
      <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
        <SessionDetailPage />
      </SurfaceAnalyticsProvider>
    );
    expect(pageViewedCalls()).toHaveLength(1);
    expect(pageViewedCalls()[0]?.[1]).toMatchObject({
      [OnboardingAnalyticsProperty.PageName]:
        OnboardingAnalyticsPageName.SessionDetail,
    });
  });

  /**
   * ISS-11004: the Activity tab's comment rows link with `?comment=`, and only
   * this shell reads the URL — without this wiring the rail never learns which
   * thread the link named.
   */
  it("threads an addressed comment from the URL", () => {
    searchParamsMock.mockReturnValue(
      new URLSearchParams({ comment: "comment-7" })
    );

    render(<SessionDetailPage />);

    expect(sharedDetailViewMock).toHaveBeenCalledWith(
      expect.objectContaining({ selectedThreadId: "comment-7" }),
      undefined
    );
  });

  /**
   * tamsinb, PR #8562: the header toggle can hide the rail outright, and only
   * this page owns that toggle, so a followed comment link re-opens it here.
   */
  it("re-opens a header-hidden rail when the body asks to reveal it", () => {
    render(<SessionDetailPage />);
    const toggle = headerMock.mock.lastCall?.[0].children.props
      .onToggleCommentsRail as () => void;
    act(() => toggle());
    expect(sharedDetailViewMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ commentsRailOpen: false }),
      undefined
    );

    const reveal = sharedDetailViewMock.mock.lastCall?.[0]
      .onRevealCommentsRail as () => void;
    act(() => reveal());

    expect(sharedDetailViewMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ commentsRailOpen: true }),
      undefined
    );
  });

  it.each([
    [ArtifactDetailTab.Sessions, true],
    [ArtifactDetailTab.Details, false],
  ])(
    "with the shell on, shows the pane's own header button on the %s tab: %s (ISS-12300 D3)",
    (tab, shown) => {
      featureFlagEnabledMock.mockImplementation(
        (key: string) => key === ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY
      );
      shellTab.value = tab;
      headerMock.mockImplementation(({ children }) => <div>{children}</div>);
      render(<SessionDetailPage />);

      expect(
        screen.queryAllByRole("button", { name: HIDE_COMMENTS })
      ).toHaveLength(shown ? 1 : 0);
    }
  );

  it("with the shell off, keeps the legacy header button on every view", () => {
    shellTab.value = ArtifactDetailTab.Details;
    headerMock.mockImplementation(({ children }) => <div>{children}</div>);
    render(<SessionDetailPage />);

    expect(screen.getByRole("button", { name: HIDE_COMMENTS })).toBeVisible();
  });

  it("addresses no comment when the URL names none", () => {
    render(<SessionDetailPage />);

    expect(sharedDetailViewMock).toHaveBeenCalledWith(
      expect.objectContaining({ selectedThreadId: null }),
      undefined
    );
  });

  it("threads a validated invocation anchor from the URL", () => {
    searchParamsMock.mockReturnValue(
      new URLSearchParams({
        file: "subagent:agent-1",
        invocationAnchor: JSON.stringify({
          kind: AgentComponentInvocationAnchorKind.UserTurn,
          userTurnId: "turn-1",
        }),
      })
    );

    render(<SessionDetailPage />);

    expect(sharedDetailViewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptFileKey: "subagent:agent-1",
        invocationAnchor: {
          kind: AgentComponentInvocationAnchorKind.UserTurn,
          userTurnId: "turn-1",
        },
      }),
      undefined
    );
  });

  // FEA-4155: the session-detail route no longer gates its body behind
  // `desktop-agent-session-sync`, since retired by ISS-8022 (the P0 blank-render root
  // cause — the gate's null fallback blanked the surface once the winding-down
  // flag resolved false). It renders the shared body directly; regression-guard
  // that no flag gate wraps it.
  it("keeps org chrome, route id, and body prop ownership without a flag gate (FEA-4155)", () => {
    render(<SessionDetailPage />);

    expect(
      screen.getByTestId("shared-detail").closest("[data-feature-flag]")
    ).toBeNull();
    expect(useAgentSessionDetailMock).toHaveBeenCalledWith("session-detail-1");
    // FEA-4260 cut the non-functional favorite star (`afterBreadcrumbs`) until
    // the favorites API lands, and ISS-12269 cut the left overflow kebab
    // (`moreMenu`), so the header now carries only the breadcrumb and the
    // right-slot primary actions (`children`). The exact-object assertion is
    // what keeps `moreMenu` gone: a reintroduced kebab fails this case.
    expect(headerMock).toHaveBeenCalledWith(
      {
        breadcrumbs: [
          { label: "Sessions", href: "/acme/sessions" },
          { label: "Desktop implementation session" },
        ],
        children: expect.anything(),
        // ISS-5008: the detail view renders its own visible session title as
        // the page `h1`, so the header must not add a second one.
        suppressPageHeading: true,
      },
      undefined
    );
    expect(sharedDetailViewMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ breadcrumbsHref: expect.anything() }),
      undefined
    );
    expect(sharedDetailViewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        backHref: "/acme/sessions",
        commentsRailOpen: true,
        isLoading: false,
      }),
      undefined
    );
  });

  it("coerces absent route ids to the disabled hook id", () => {
    routeParamsMock.mockReturnValue({ id: ["bad"] });

    render(<SessionDetailPage />);

    expect(useAgentSessionDetailMock).toHaveBeenCalledWith("");
  });

  // FEA-4262 (producer side): the session's Branch cross-link must TAG its href
  // with `?from=session` so the branch-detail page's Back can resolve to the
  // referring sessions list. Pinning the producer here keeps the branch-detail
  // destination tests (which inject `from=session` directly) from staying green
  // vacuously if this emission ever regresses.
  it("tags the session's Branch cross-link href with ?from=session", () => {
    render(<SessionDetailPage />);

    const props = sharedDetailViewMock.mock.calls.at(-1)?.[0] as {
      getBranchHref?: (branchArtifactId: string) => string;
    };
    expect(props?.getBranchHref?.("branch-xyz")).toBe(
      "/acme/branches/branch-xyz?from=session"
    );
  });
});

/** The comments button's own label while the pane is shown. */
const HIDE_COMMENTS = "Hide comments rail";
