import { AgentComponentInvocationAnchorKind } from "@repo/api/src/types/agent-component-invocation";
import { createAgentSessionDetailFixture } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SessionDetailPage from "../page";

const {
  featureFlagEnabledMock,
  headerMock,
  routeParamsMock,
  searchParamsMock,
  sharedDetailViewMock,
  useAgentSessionDetailMock,
} = vi.hoisted(() => ({
  featureFlagEnabledMock: vi.fn(),
  headerMock: vi.fn(),
  routeParamsMock: vi.fn(),
  searchParamsMock: vi.fn(),
  sharedDetailViewMock: vi.fn(),
  useAgentSessionDetailMock: vi.fn(),
}));

vi.mock("@repo/app/agents/components/detail/agent-session-detail-view", () => ({
  AgentSessionDetailView: sharedDetailViewMock,
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

describe("org session detail wrapper", () => {
  beforeEach(() => {
    featureFlagEnabledMock.mockReset();
    featureFlagEnabledMock.mockReturnValue(false);
    headerMock.mockReset();
    routeParamsMock.mockReset();
    searchParamsMock.mockReset();
    sharedDetailViewMock.mockReset();
    useAgentSessionDetailMock.mockReset();
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
  // `DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY` (the P0 blank-render root
  // cause — the gate's null fallback blanked the surface once the winding-down
  // flag resolved false). It renders the shared body directly; regression-guard
  // that no flag gate wraps it.
  it("keeps org chrome, route id, and body prop ownership without a flag gate (FEA-4155)", () => {
    render(<SessionDetailPage />);

    expect(
      screen.getByTestId("shared-detail").closest("[data-feature-flag]")
    ).toBeNull();
    expect(useAgentSessionDetailMock).toHaveBeenCalledWith("session-detail-1");
    // FEA-4260: the non-functional favorite star (`afterBreadcrumbs`) was cut
    // until the favorites API lands, so the header now carries only the
    // breadcrumb, the left overflow kebab (`moreMenu`), and the right-slot
    // primary actions (`children`).
    expect(headerMock).toHaveBeenCalledWith(
      {
        breadcrumbs: [
          { label: "Sessions", href: "/acme/sessions" },
          { label: "Desktop implementation session" },
        ],
        children: expect.anything(),
        moreMenu: expect.anything(),
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
