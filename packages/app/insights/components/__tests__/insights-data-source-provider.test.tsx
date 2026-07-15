import { BranchKpiState } from "@repo/api/src/types/branch";
import {
  GitHubDataConnectionSource,
  GitHubOAuthRequiredReason,
} from "@repo/api/src/types/github";
import {
  InsightsGitHubProvenanceState,
  InsightsScope,
  InsightsSection,
  InsightsTileAvailabilityState,
} from "@repo/api/src/types/insights";
import { useInsightsDataSource } from "@repo/app/insights/data/insights-data-source";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebInsightsDataSourceProvider } from "../insights-data-source-provider";

const { useGitHubIntegrationStatusMock, useTeamsMock } = vi.hoisted(() => ({
  useGitHubIntegrationStatusMock: vi.fn(),
  useTeamsMock: vi.fn(),
}));

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  useGitHubIntegrationStatus: useGitHubIntegrationStatusMock,
}));

vi.mock("@repo/app/teams/hooks/use-teams", () => ({
  useTeams: useTeamsMock,
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({
    get: vi.fn(),
  }),
}));

describe("WebInsightsDataSourceProvider", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed when the connected status lacks active payload provenance", () => {
    useGitHubIntegrationStatusMock.mockReturnValue({
      data: { connected: true },
    });
    useTeamsMock.mockReturnValue({ data: [] });

    renderWithProvider(<AvailabilityProbe />);

    expect(
      screen.getByText(`availability:${BranchKpiState.Unavailable}`)
    ).toBeInTheDocument();
  });

  it("marks cloud GitHub tiles available only when payload provenance is active", () => {
    useGitHubIntegrationStatusMock.mockReturnValue({
      data: { connected: true },
    });
    useTeamsMock.mockReturnValue({ data: [] });

    renderWithProvider(<AvailabilityProbe withActiveProvenance />);

    expect(
      screen.getByText(`availability:${BranchKpiState.Available}`)
    ).toBeInTheDocument();
  });

  it("treats user-token data connections as connected without a legacy App installation", () => {
    useGitHubIntegrationStatusMock.mockReturnValue({
      data: {
        connected: false,
        githubDataConnection: {
          connected: true,
          sources: [GitHubDataConnectionSource.UserOAuth],
          oauthRequiredReasons: [],
        },
      },
    });
    useTeamsMock.mockReturnValue({ data: [] });

    renderWithProvider(<AvailabilityProbe withActiveProvenance />);

    expect(
      screen.getByText(`availability:${BranchKpiState.Available}`)
    ).toBeInTheDocument();
  });

  it("keeps disconnected payload provenance gated even with a connected status", () => {
    useGitHubIntegrationStatusMock.mockReturnValue({
      data: { connected: true },
    });
    useTeamsMock.mockReturnValue({ data: [] });

    renderWithProvider(<AvailabilityProbe withDisconnectedProvenance />);

    expect(
      screen.getByText(`availability:${BranchKpiState.Gated}`)
    ).toBeInTheDocument();
  });

  it("lets current disconnected status override stale active payload provenance", () => {
    useGitHubIntegrationStatusMock.mockReturnValue({
      data: { connected: false },
    });
    useTeamsMock.mockReturnValue({ data: [] });

    renderWithProvider(<AvailabilityProbe withActiveProvenance />);

    expect(
      screen.getByText(`availability:${BranchKpiState.Gated}`)
    ).toBeInTheDocument();
  });

  it("does not invalidate insights for the initial cached GitHub status", () => {
    useGitHubIntegrationStatusMock.mockReturnValue({
      data: { connected: true },
    });
    useTeamsMock.mockReturnValue({ data: [] });
    const queryClient = createQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    renderWithProvider(<div />, queryClient);

    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("invalidates insights when the GitHub connected status changes", () => {
    let connected = false;
    useGitHubIntegrationStatusMock.mockImplementation(() => ({
      data: { connected },
    }));
    useTeamsMock.mockReturnValue({ data: [] });
    const queryClient = createQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const rendered = renderWithProvider(<div />, queryClient);

    expect(invalidateQueries).not.toHaveBeenCalled();

    connected = true;
    rendered.rerender(providerTree(<div />, queryClient));

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["insights"],
    });
  });

  it("invalidates insights when the additive GitHub data connection changes", () => {
    let connected = false;
    useGitHubIntegrationStatusMock.mockImplementation(() => ({
      data: {
        connected: false,
        githubDataConnection: {
          connected,
          sources: connected ? [GitHubDataConnectionSource.UserOAuth] : [],
          oauthRequiredReasons: [],
        },
      },
    }));
    useTeamsMock.mockReturnValue({ data: [] });
    const queryClient = createQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const rendered = renderWithProvider(<div />, queryClient);

    expect(invalidateQueries).not.toHaveBeenCalled();

    connected = true;
    rendered.rerender(providerTree(<div />, queryClient));

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["insights"],
    });
  });

  it("uses the install connect href when the App is absent", () => {
    useGitHubIntegrationStatusMock.mockReturnValue({
      data: {
        connected: false,
        githubDataConnection: {
          connected: false,
          sources: [],
          oauthRequiredReasons: [
            GitHubOAuthRequiredReason.NoAppInstallation,
            GitHubOAuthRequiredReason.NoUserGrant,
          ],
        },
      },
    });
    useTeamsMock.mockReturnValue({ data: [] });

    renderWithProvider(<ConnectHrefProbe />, undefined, {
      githubAuthorizeHref:
        "/api/integrations/github?returnTo=%2Facme%2Finsights",
      githubInstallHref:
        "/api/integrations/github?install=true&returnTo=%2Facme%2Finsights",
    });

    expect(
      screen.getByText(
        "href:/api/integrations/github?install=true&returnTo=%2Facme%2Finsights"
      )
    ).toBeInTheDocument();
  });

  it("uses the authorize connect href for user-grant recovery", () => {
    useGitHubIntegrationStatusMock.mockReturnValue({
      data: {
        connected: false,
        githubDataConnection: {
          connected: false,
          sources: [],
          oauthRequiredReasons: [
            GitHubOAuthRequiredReason.NoAppInstallation,
            GitHubOAuthRequiredReason.CredentialExpired,
          ],
        },
      },
    });
    useTeamsMock.mockReturnValue({ data: [] });

    renderWithProvider(<ConnectHrefProbe />, undefined, {
      githubAuthorizeHref:
        "/api/integrations/github?returnTo=%2Facme%2Finsights",
      githubInstallHref:
        "/api/integrations/github?install=true&returnTo=%2Facme%2Finsights",
    });

    expect(
      screen.getByText(
        "href:/api/integrations/github?returnTo=%2Facme%2Finsights"
      )
    ).toBeInTheDocument();
  });

  it("preserves the install href fallback for old disconnected status responses", () => {
    useGitHubIntegrationStatusMock.mockReturnValue({
      data: { connected: false },
    });
    useTeamsMock.mockReturnValue({ data: [] });

    renderWithProvider(<ConnectHrefProbe />, undefined, {
      githubAuthorizeHref:
        "/api/integrations/github?returnTo=%2Facme%2Finsights",
      githubInstallHref:
        "/api/integrations/github?install=true&returnTo=%2Facme%2Finsights",
    });

    expect(
      screen.getByText(
        "href:/api/integrations/github?install=true&returnTo=%2Facme%2Finsights"
      )
    ).toBeInTheDocument();
  });
});

function AvailabilityProbe({
  withActiveProvenance = false,
  withDisconnectedProvenance = false,
}: {
  withActiveProvenance?: boolean;
  withDisconnectedProvenance?: boolean;
}) {
  const source = useInsightsDataSource();
  const payloadGitHubProvenance = resolvePayloadProvenance({
    withActiveProvenance,
    withDisconnectedProvenance,
  });
  const availability = source.getTileAvailability?.({
    payloadAvailability: {
      "kpi:merged": InsightsTileAvailabilityState.Available,
    },
    payloadGitHubProvenance,
    scope: InsightsScope.Org,
    section: InsightsSection.Delivery,
    tileId: "kpi:merged",
  });
  return <div>availability:{availability?.state}</div>;
}

function ConnectHrefProbe() {
  const source = useInsightsDataSource();
  return <div>href:{source.githubConnectHref}</div>;
}

function renderWithProvider(
  children: ReactNode,
  queryClient = createQueryClient(),
  props: Pick<
    Parameters<typeof WebInsightsDataSourceProvider>[0],
    "githubAuthorizeHref" | "githubConnectHref" | "githubInstallHref"
  > = {}
) {
  return render(providerTree(children, queryClient, props));
}

function providerTree(
  children: ReactNode,
  queryClient: QueryClient,
  props: Pick<
    Parameters<typeof WebInsightsDataSourceProvider>[0],
    "githubAuthorizeHref" | "githubConnectHref" | "githubInstallHref"
  > = {}
) {
  return (
    <QueryClientProvider client={queryClient}>
      <WebInsightsDataSourceProvider {...props}>
        {children}
      </WebInsightsDataSourceProvider>
    </QueryClientProvider>
  );
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function resolvePayloadProvenance({
  withActiveProvenance,
  withDisconnectedProvenance,
}: {
  withActiveProvenance: boolean;
  withDisconnectedProvenance: boolean;
}) {
  if (withActiveProvenance) {
    return {
      checkedAt: "2026-07-06T00:00:00.000Z",
      state: InsightsGitHubProvenanceState.Active,
    };
  }
  if (withDisconnectedProvenance) {
    return {
      checkedAt: "2026-07-06T00:00:00.000Z",
      state: InsightsGitHubProvenanceState.Disconnected,
    };
  }
  return undefined;
}
