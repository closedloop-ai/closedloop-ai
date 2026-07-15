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

// The Compliance Gaps section (folded into monitoring) reads this hook.
vi.mock("@repo/app/agents/hooks/use-agent-component-compliance", () => ({
  useAgentComponentCompliance: () => ({
    data: { items: [] },
    isLoading: false,
    isError: false,
  }),
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

vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
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

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

describe("org monitoring page wrapper", () => {
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
      data: createAgentSessionUsageSummaryFixture("organization"),
      isLoading: false,
    });
    useAgentSessionsMock.mockReturnValue({
      data: {
        items: [createAgentSessionListItemFixture()],
        total: 1,
        viewerScope: "organization",
      },
      isLoading: false,
    });
    useProjectsMock.mockReturnValue({ data: [] });
    useTeamsMock.mockReturnValue({ data: [] });
  });

  it("passes the Artifact extra column and keeps org session hrefs", () => {
    render(<AgentMonitoringPage />);

    expect(screen.getByText("Artifact")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View" })).toHaveAttribute(
      "href",
      "/acme/features/FEA-1515"
    );
    expect(
      screen.getByRole("link", { name: "Shared sessions list extraction" })
    ).toHaveAttribute("href", "/acme/sessions/session-1");
    expect(useAgentSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 25,
        offset: 0,
      })
    );
  });
});
