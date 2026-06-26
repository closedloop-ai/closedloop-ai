import {
  createAgentSessionListItemFixture,
  createAgentSessionUsageSummaryFixture,
} from "@repo/app/agents/components/sessions/session-list-fixtures";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgentMonitoringPage from "../page";

const {
  navigationReplaceMock,
  searchParamsMock,
  useAgentSessionAnalyticsMock,
  useAgentSessionsMock,
  useAgentSessionUsageMock,
  useProjectsMock,
  useTeamsMock,
} = vi.hoisted(() => ({
  navigationReplaceMock: vi.fn(),
  searchParamsMock: new URLSearchParams(),
  useAgentSessionAnalyticsMock: vi.fn(),
  useAgentSessionsMock: vi.fn(),
  useAgentSessionUsageMock: vi.fn(),
  useProjectsMock: vi.fn(),
  useTeamsMock: vi.fn(),
}));

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessionAnalytics: useAgentSessionAnalyticsMock,
  useAgentSessions: useAgentSessionsMock,
  useAgentSessionUsage: useAgentSessionUsageMock,
}));

vi.mock("@repo/analytics/client", () => ({
  useAnalytics: () => ({ capture: vi.fn() }),
}));

vi.mock("@repo/analytics/components/feature-flagged", () => ({
  FeatureFlagged: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@repo/app/teams/hooks/use-teams", () => ({
  useTeams: useTeamsMock,
}));

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: useProjectsMock,
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ replace: navigationReplaceMock }),
}));

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => searchParamsMock,
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: () => <div data-testid="header" />,
}));

describe("monitoring page wrapper", () => {
  beforeEach(() => {
    navigationReplaceMock.mockClear();
    searchParamsMock.forEach((_, key) => {
      searchParamsMock.delete(key);
    });
    useAgentSessionAnalyticsMock.mockReset();
    useAgentSessionsMock.mockReset();
    useAgentSessionUsageMock.mockReset();
    useProjectsMock.mockReset();
    useTeamsMock.mockReset();
    useAgentSessionAnalyticsMock.mockReturnValue({ data: null });
    useAgentSessionUsageMock.mockReturnValue({
      data: createAgentSessionUsageSummaryFixture("self"),
      isLoading: false,
    });
    useAgentSessionsMock.mockReturnValue({
      data: {
        items: [createAgentSessionListItemFixture()],
        total: 1,
        viewerScope: "self",
      },
      isLoading: false,
    });
    useProjectsMock.mockReturnValue({ data: [] });
    useTeamsMock.mockReturnValue({ data: [] });
  });

  it("passes no Artifact extra-column props and keeps non-org session hrefs", () => {
    render(<AgentMonitoringPage />);

    expect(screen.queryByText("Artifact")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Shared sessions list extraction" })
    ).toHaveAttribute("href", "/sessions/session-1");
    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 25,
        offset: 0,
      })
    );
  });
});
