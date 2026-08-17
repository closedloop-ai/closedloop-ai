import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import {
  SESSION_PR_PURPOSE_LABELS,
  SessionPrPurpose,
} from "@repo/api/src/types/session-artifact-link";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import {
  createAgentSessionAnalyticsFixture,
  createAgentSessionListItemFixture,
  createAgentSessionUsageSummaryFixture,
  populatedAgentSessionListFixtures,
} from "../../sessions/session-list-fixtures";
import {
  AgentTelemetryAnalytics,
  type AgentTelemetryAnalyticsQueryState,
} from "../agent-telemetry-analytics";

const DEFAULT_QUERY_STATE: AgentTelemetryAnalyticsQueryState = {
  dateRange: "30d",
  harness: "all",
  page: 0,
  selectedProjectId: null,
  selectedTeamId: null,
  selectedUserId: null,
  status: "all",
};

describe("AgentTelemetryAnalytics", () => {
  it("renders org analytics and Artifact column when enabled", async () => {
    render(
      <AppCoreStoryProviders
        apiRoutes={monitoringRoutes(AgentSessionViewerScope.Organization)}
      >
        <AgentTelemetryAnalytics
          analyticsBreakdownsEnabled
          exportHref="/api/agent-sessions/export?format=csv"
          extraColumnLabel="Artifact"
          getSessionHref={(item) => `/org/sessions/${item.id}`}
          onQueryStateChange={vi.fn()}
          organizationFiltersEnabled
          queryState={DEFAULT_QUERY_STATE}
          renderExtraColumn={() => <a href="/org/features/FEA-1">View</a>}
        />
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText("Tool Reliability")).toBeInTheDocument();
    expect(screen.queryByText("Branch Attribution")).not.toBeInTheDocument();
    expect(screen.getByText("Artifact")).toBeInTheDocument();
    for (const link of screen.getAllByRole("link", { name: "View" })) {
      expect(link).toHaveAttribute("href", "/org/features/FEA-1");
    }
  });

  it("does not request analytics and omits Artifact when disabled", async () => {
    const requestedPaths: string[] = [];
    render(
      <AppCoreStoryProviders
        apiRoutes={monitoringRoutes(
          AgentSessionViewerScope.Self,
          requestedPaths
        )}
      >
        <AgentTelemetryAnalytics
          exportHref="/api/agent-sessions/export?format=csv"
          getSessionHref={(item) => `/sessions/${item.id}`}
          onQueryStateChange={vi.fn()}
          queryState={DEFAULT_QUERY_STATE}
        />
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByText("Shared sessions list extraction")
    ).toBeInTheDocument();
    expect(screen.queryByText("Tool Reliability")).not.toBeInTheDocument();
    expect(screen.queryByText("Artifact")).not.toBeInTheDocument();
    expect(requestedPaths).not.toContain("/agent-sessions/analytics");
  });

  it("omits the CSV export action when no export href is supplied", async () => {
    render(
      <AppCoreStoryProviders
        apiRoutes={monitoringRoutes(AgentSessionViewerScope.Self)}
      >
        <AgentTelemetryAnalytics
          getSessionHref={(item) => `/sessions/${item.id}`}
          onQueryStateChange={vi.fn()}
          queryState={DEFAULT_QUERY_STATE}
        />
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByText("Shared sessions list extraction")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Export CSV" })
    ).not.toBeInTheDocument();
  });

  it("keeps sessions visible when usage summary is independently empty", async () => {
    render(
      <AppCoreStoryProviders
        apiRoutes={monitoringRoutes(AgentSessionViewerScope.Self, [], {
          usageTotalSessions: 0,
        })}
      >
        <AgentTelemetryAnalytics
          exportHref="/api/agent-sessions/export?format=csv"
          getSessionHref={(item) => `/sessions/${item.id}`}
          onQueryStateChange={vi.fn()}
          queryState={DEFAULT_QUERY_STATE}
        />
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByText("Shared sessions list extraction")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No agent session data yet")
    ).not.toBeInTheDocument();
  });

  it("preserves the org cost split detail in summary metrics", async () => {
    render(
      <AppCoreStoryProviders
        apiRoutes={monitoringRoutes(AgentSessionViewerScope.Organization, [], {
          usageCosts: {
            // FEA-3986 invariant fixture: total is the subscription-INCLUSIVE
            // grand total, EQUAL to api + sub (2 === 1.25 + 0.75). Asserted
            // end-to-end below via the rendered Cost card.
            apiEstimatedCost: 1.25,
            subscriptionEstimatedCost: 0.75,
            totalEstimatedCost: 2,
          },
        })}
      >
        <AgentTelemetryAnalytics
          exportHref="/api/agent-sessions/export?format=csv"
          getSessionHref={(item) => `/org/sessions/${item.id}`}
          onQueryStateChange={vi.fn()}
          organizationFiltersEnabled
          queryState={DEFAULT_QUERY_STATE}
        />
      </AppCoreStoryProviders>
    );

    const costSplitElements = await screen.findAllByText((_content, element) =>
      Boolean(
        element?.textContent?.includes("API: $1.25") &&
          element.textContent.includes("Sub: $0.75")
      )
    );
    const costDetail = costSplitElements.find((element) =>
      element.className
        .toString()
        .includes("flex items-center gap-1 text-muted-foreground")
    );
    expect(costDetail).toBeDefined();

    // FEA-3986 user-visible invariant, end-to-end: the org Analytics "Cost" card
    // renders the subscription-INCLUSIVE total ($2) as its HEADLINE and the
    // API/Sub split ($1.25 / $0.75) as its detail — so the rendered headline
    // equals api + sub by construction. A regression that rendered the metered
    // `apiEstimatedCost` ($1 whole) as the headline (the divergence shafty023
    // flagged) would fail here even though the detail line stays green.
    const costCard = costDetail?.closest('[data-slot="card"]');
    expect(costCard).not.toBeNull();
    expect(within(costCard as HTMLElement).getByText("$2")).toBeInTheDocument();
    // The metered-only figure ($1) must NOT be the headline.
    expect(
      within(costCard as HTMLElement).queryByText("$1")
    ).not.toBeInTheDocument();
  });

  it("preserves selected team and project filters when metadata queries fail", async () => {
    render(
      <AppCoreStoryProviders
        apiRoutes={monitoringRoutes(AgentSessionViewerScope.Organization, [], {
          metadataStatus: 503,
        })}
      >
        <AgentTelemetryAnalytics
          analyticsBreakdownsEnabled
          exportHref="/api/agent-sessions/export?format=csv"
          getSessionHref={(item) => `/org/sessions/${item.id}`}
          onQueryStateChange={vi.fn()}
          organizationFiltersEnabled
          queryState={{
            ...DEFAULT_QUERY_STATE,
            selectedProjectId: "project-unavailable",
            selectedTeamId: "team-unavailable",
          }}
        />
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByText("Shared sessions list extraction")
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        "Selected team filter team-unavailable remains applied while team metadata is unavailable."
      )
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        "Selected project filter project-unavailable remains applied while project metadata is unavailable."
      )
    ).toBeInTheDocument();
  });

  it("renders branch and PR attribution lenses when usage returns them", async () => {
    render(
      <AppCoreStoryProviders
        apiRoutes={monitoringRoutes(AgentSessionViewerScope.Organization, [], {
          usageAttribution: true,
        })}
      >
        <AgentTelemetryAnalytics
          exportHref="/api/agent-sessions/export?format=csv"
          getSessionHref={(item) => `/org/sessions/${item.id}`}
          onQueryStateChange={vi.fn()}
          organizationFiltersEnabled
          queryState={DEFAULT_QUERY_STATE}
        />
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText("Branch Attribution")).toBeInTheDocument();
    expect(screen.getByText("feature/fea-2384")).toBeInTheDocument();
    expect(screen.getByText("PR Attribution")).toBeInTheDocument();
    expect(screen.getByText("#1248 Split attribution")).toBeInTheDocument();
    expect(
      screen.getByText(
        `closedloop-ai/symphony-alpha · ${SESSION_PR_PURPOSE_LABELS[SessionPrPurpose.Authored]}`
      )
    ).toBeInTheDocument();
  });

  it("keeps org analytics rendered when metadata payloads are not arrays", async () => {
    render(
      <AppCoreStoryProviders
        apiRoutes={monitoringRoutes(AgentSessionViewerScope.Organization, [], {
          metadataPayload: "non-array",
        })}
      >
        <AgentTelemetryAnalytics
          analyticsBreakdownsEnabled
          exportHref="/api/agent-sessions/export?format=csv"
          getSessionHref={(item) => `/org/sessions/${item.id}`}
          onQueryStateChange={vi.fn()}
          organizationFiltersEnabled
          queryState={DEFAULT_QUERY_STATE}
        />
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText("Tool Reliability")).toBeInTheDocument();
    expect(screen.getByText("All teams")).toBeInTheDocument();
    expect(screen.getByText("All projects")).toBeInTheDocument();
  });

  it("toggles the user filter from mobile user rows", async () => {
    const onQueryStateChange = vi.fn();
    render(
      <AppCoreStoryProviders
        apiRoutes={monitoringRoutes(AgentSessionViewerScope.Self)}
      >
        <AgentTelemetryAnalytics
          exportHref="/api/agent-sessions/export?format=csv"
          getSessionHref={(item) => `/sessions/${item.id}`}
          onQueryStateChange={onQueryStateChange}
          queryState={DEFAULT_QUERY_STATE}
        />
      </AppCoreStoryProviders>
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Filter sessions by User Person",
      })
    );

    expect(onQueryStateChange).toHaveBeenCalledWith({
      ...DEFAULT_QUERY_STATE,
      page: 0,
      selectedUserId: "user-1",
    });
  });

  it("clears the active user filter from mobile user rows", async () => {
    const onQueryStateChange = vi.fn();
    render(
      <AppCoreStoryProviders
        apiRoutes={monitoringRoutes(AgentSessionViewerScope.Self)}
      >
        <AgentTelemetryAnalytics
          exportHref="/api/agent-sessions/export?format=csv"
          getSessionHref={(item) => `/sessions/${item.id}`}
          onQueryStateChange={onQueryStateChange}
          queryState={{ ...DEFAULT_QUERY_STATE, selectedUserId: "user-1" }}
        />
      </AppCoreStoryProviders>
    );

    const activeUserRow = await screen.findByRole("button", {
      name: "Filter sessions by User Person",
    });
    expect(activeUserRow).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(activeUserRow);

    expect(onQueryStateChange).toHaveBeenCalledWith({
      ...DEFAULT_QUERY_STATE,
      page: 0,
      selectedUserId: null,
    });
  });

  it("renders selected-user sessions and sends the filter to usage, list, and analytics", async () => {
    const requestedQueries: AgentTelemetryRequestRecord[] = [];
    const selectedUserSession = createAgentSessionListItemFixture({
      id: "selected-user-session",
      name: "Selected user session",
      user: {
        avatarUrl: null,
        email: "user@example.com",
        firstName: "User",
        id: "user-1",
        lastName: "Person",
      },
    });
    const otherUserSession = createAgentSessionListItemFixture({
      id: "other-user-session",
      name: "Other user session",
      user: {
        avatarUrl: null,
        email: "other@example.com",
        firstName: "Other",
        id: "user-2",
        lastName: "Person",
      },
    });

    render(
      <AppCoreStoryProviders
        apiRoutes={monitoringRoutes(AgentSessionViewerScope.Organization, [], {
          listItems: [selectedUserSession, otherUserSession],
          requestedQueries,
          usageTotalSessions: 1,
        })}
      >
        <AgentTelemetryAnalytics
          analyticsBreakdownsEnabled
          exportHref="/api/agent-sessions/export?format=csv"
          getSessionHref={(item) => `/org/sessions/${item.id}`}
          onQueryStateChange={vi.fn()}
          organizationFiltersEnabled
          queryState={{ ...DEFAULT_QUERY_STATE, selectedUserId: "user-1" }}
        />
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByText("Selected user session")
    ).toBeInTheDocument();
    expect(screen.queryByText("Other user session")).not.toBeInTheDocument();
    expect(await screen.findByText("Tool Reliability")).toBeInTheDocument();
    expect(requestedQueries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pathname: "/agent-sessions/usage",
          userId: "user-1",
        }),
        expect.objectContaining({
          limit: "25",
          offset: "0",
          pathname: "/agent-sessions",
          userId: "user-1",
        }),
        expect.objectContaining({
          pathname: "/agent-sessions/analytics",
          userId: "user-1",
        }),
      ])
    );
  });

  it("sends explicit team scope and teamId to usage, list, and analytics", async () => {
    const requestedQueries: AgentTelemetryRequestRecord[] = [];

    render(
      <AppCoreStoryProviders
        apiRoutes={monitoringRoutes(AgentSessionViewerScope.Team, [], {
          requestedQueries,
        })}
      >
        <AgentTelemetryAnalytics
          analyticsBreakdownsEnabled
          exportHref="/api/agent-sessions/export?format=csv"
          getSessionHref={(item) => `/org/sessions/${item.id}`}
          onQueryStateChange={vi.fn()}
          organizationFiltersEnabled
          queryState={{ ...DEFAULT_QUERY_STATE, selectedTeamId: "team-1" }}
        />
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText("Tool Reliability")).toBeInTheDocument();
    expect(requestedQueries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pathname: "/agent-sessions/usage",
          teamId: "team-1",
          viewerScope: AgentSessionViewerScope.Team,
        }),
        expect.objectContaining({
          limit: "25",
          offset: "0",
          pathname: "/agent-sessions",
          teamId: "team-1",
          viewerScope: AgentSessionViewerScope.Team,
        }),
        expect.objectContaining({
          pathname: "/agent-sessions/analytics",
          teamId: "team-1",
          viewerScope: AgentSessionViewerScope.Team,
        }),
      ])
    );
  });
});

type AgentTelemetryRequestRecord = {
  pathname: string;
  teamId: string | null;
  userId: string | null;
  viewerScope: string | null;
  limit?: string | null;
  offset?: string | null;
};

function monitoringRoutes(
  viewerScope: AgentSessionViewerScope,
  requestedPaths: string[] = [],
  options: Readonly<{
    listItems?: typeof populatedAgentSessionListFixtures;
    metadataPayload?: "array" | "non-array";
    metadataStatus?: number;
    requestedQueries?: AgentTelemetryRequestRecord[];
    usageCosts?: {
      apiEstimatedCost: number;
      subscriptionEstimatedCost: number;
      totalEstimatedCost: number;
    };
    usageAttribution?: boolean;
    usageTotalSessions?: number;
  }> = {}
) {
  return [
    {
      method: "GET",
      path: "/agent-sessions/usage",
      respond: ({
        pathname,
        searchParams,
      }: {
        pathname: string;
        searchParams: URLSearchParams;
      }) => {
        requestedPaths.push(pathname);
        recordRequest(options.requestedQueries, pathname, searchParams);
        return createAgentSessionUsageSummaryFixture(viewerScope, {
          ...(options.usageAttribution
            ? {
                byBranch: [
                  {
                    branchArtifactId: "branch-1",
                    branchName: "feature/fea-2384",
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    estimatedCost: 1,
                    inputTokens: 400,
                    outputTokens: 200,
                    repositoryFullName: "closedloop-ai/symphony-alpha",
                    sessionCount: 2,
                  },
                ],
                byPr: [
                  {
                    branchArtifactId: "branch-1",
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    estimatedCost: 1,
                    inputTokens: 400,
                    outputTokens: 200,
                    prNumber: 1248,
                    prTitle: "Split attribution",
                    purpose: SessionPrPurpose.Authored,
                    purposeLabel:
                      SESSION_PR_PURPOSE_LABELS[SessionPrPurpose.Authored],
                    repositoryFullName: "closedloop-ai/symphony-alpha",
                    sessionCount: 2,
                  },
                ],
              }
            : {}),
          byModel: [
            {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCost: 2,
              inputTokens: 1000,
              model: "gpt-5.5",
              outputTokens: 500,
              sessionCount: 2,
            },
          ],
          byUser: [
            {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCost: 2,
              inputTokens: 1000,
              outputTokens: 500,
              sessionCount: 2,
              userAvatarUrl: null,
              userEmail: "user@example.com",
              userId: "user-1",
              userName: "User Person",
            },
          ],
          ...options.usageCosts,
          totalSessions: options.usageTotalSessions ?? 2,
        });
      },
    },
    {
      method: "GET",
      path: "/agent-sessions",
      respond: ({
        pathname,
        searchParams,
      }: {
        pathname: string;
        searchParams: URLSearchParams;
      }) => {
        const items = filterItemsByUser(
          options.listItems ?? populatedAgentSessionListFixtures,
          searchParams.get("userId")
        );
        requestedPaths.push(pathname);
        recordRequest(options.requestedQueries, pathname, searchParams, {
          limit: searchParams.get("limit"),
          offset: searchParams.get("offset"),
        });
        return {
          items,
          total: items.length,
          viewerScope,
        };
      },
    },
    {
      method: "GET",
      path: "/agent-sessions/analytics",
      respond: ({
        pathname,
        searchParams,
      }: {
        pathname: string;
        searchParams: URLSearchParams;
      }) => {
        requestedPaths.push(pathname);
        recordRequest(options.requestedQueries, pathname, searchParams);
        return createAgentSessionAnalyticsFixture(viewerScope);
      },
    },
    {
      method: "GET",
      path: "/teams",
      status: options.metadataStatus,
      respond: ({ pathname }: { pathname: string }) => {
        requestedPaths.push(pathname);
        if (options.metadataPayload === "non-array") {
          return { teams: [{ id: "team-1", name: "Platform Team" }] };
        }
        return [{ id: "team-1", name: "Platform Team" }];
      },
    },
    {
      method: "GET",
      path: "/projects",
      status: options.metadataStatus,
      respond: ({ pathname }: { pathname: string }) => {
        requestedPaths.push(pathname);
        if (options.metadataPayload === "non-array") {
          return { projects: [{ id: "project-1", name: "Platform" }] };
        }
        return [{ id: "project-1", name: "Platform" }];
      },
    },
  ];
}

function recordRequest(
  records: AgentTelemetryRequestRecord[] | undefined,
  pathname: string,
  searchParams: URLSearchParams,
  extra: Partial<AgentTelemetryRequestRecord> = {}
) {
  records?.push({
    pathname,
    teamId: searchParams.get("teamId"),
    userId: searchParams.get("userId"),
    viewerScope: searchParams.get("viewerScope"),
    ...extra,
  });
}

function filterItemsByUser(
  items: typeof populatedAgentSessionListFixtures,
  userId: string | null
) {
  if (!userId) {
    return items;
  }
  return items.filter((item) => item.user?.id === userId);
}
