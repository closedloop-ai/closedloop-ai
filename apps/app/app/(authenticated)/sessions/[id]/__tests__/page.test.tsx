import { DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY } from "@repo/api/src/types/agent-session";
import { createAgentSessionDetailFixture } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SessionDetailPage from "../page";

const {
  headerMock,
  routeParamsMock,
  sharedDetailViewMock,
  useAgentSessionDetailMock,
} = vi.hoisted(() => ({
  headerMock: vi.fn(),
  routeParamsMock: vi.fn(),
  sharedDetailViewMock: vi.fn(),
  useAgentSessionDetailMock: vi.fn(),
}));

vi.mock("@repo/analytics/components/feature-flagged", () => ({
  FeatureFlagged: ({
    children,
    flag,
  }: {
    children: ReactNode;
    flag: string;
  }) => <div data-feature-flag={flag}>{children}</div>,
}));

vi.mock("@repo/app/agents/components/detail/agent-session-detail-view", () => ({
  AgentSessionDetailView: sharedDetailViewMock,
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionDetail: useAgentSessionDetailMock,
}));

vi.mock("@repo/navigation/use-route-params", () => ({
  useRouteParams: routeParamsMock,
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

describe("non-org session detail wrapper", () => {
  beforeEach(() => {
    headerMock.mockReset();
    routeParamsMock.mockReset();
    sharedDetailViewMock.mockReset();
    useAgentSessionDetailMock.mockReset();
    routeParamsMock.mockReturnValue({ id: "session-detail-1" });
    useAgentSessionDetailMock.mockReturnValue({
      data: createAgentSessionDetailFixture(),
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    });
    headerMock.mockReturnValue(<div data-testid="header" />);
    sharedDetailViewMock.mockReturnValue(<div data-testid="shared-detail" />);
  });

  it("keeps feature flag, Header breadcrumbs, route id, and body prop ownership", () => {
    render(<SessionDetailPage />);

    expect(
      screen.getByTestId("shared-detail").closest("[data-feature-flag]")
    ).toHaveAttribute(
      "data-feature-flag",
      DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY
    );
    expect(useAgentSessionDetailMock).toHaveBeenCalledWith("session-detail-1");
    expect(headerMock).toHaveBeenCalledWith(
      {
        afterBreadcrumbs: expect.anything(),
        breadcrumbs: [
          { label: "Sessions", href: "/sessions" },
          { label: "Desktop implementation session" },
        ],
        children: expect.anything(),
        moreMenu: expect.anything(),
      },
      undefined
    );
    expect(sharedDetailViewMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ breadcrumbsHref: expect.anything() }),
      undefined
    );
    expect(sharedDetailViewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        backHref: "/sessions",
        commentsRailOpen: true,
        isLoading: false,
        session: expect.objectContaining({ id: "session-detail-1" }),
      }),
      undefined
    );
  });

  it("coerces absent route ids to the disabled hook id", () => {
    routeParamsMock.mockReturnValue({});

    render(<SessionDetailPage />);

    expect(useAgentSessionDetailMock).toHaveBeenCalledWith("");
  });
});
