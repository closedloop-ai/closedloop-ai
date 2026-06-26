import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import {
  createAgentSessionAnalyticsFixture,
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
      <AppCoreStoryProviders apiRoutes={monitoringRoutes("organization")}>
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
    expect(screen.getByText("Artifact")).toBeInTheDocument();
    for (const link of screen.getAllByRole("link", { name: "View" })) {
      expect(link).toHaveAttribute("href", "/org/features/FEA-1");
    }
  });

  it("does not request analytics and omits Artifact when disabled", async () => {
    const requestedPaths: string[] = [];
    render(
      <AppCoreStoryProviders
        apiRoutes={monitoringRoutes("self", requestedPaths)}
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
      <AppCoreStoryProviders apiRoutes={monitoringRoutes("self")}>
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
        apiRoutes={monitoringRoutes("self", [], {
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
        apiRoutes={monitoringRoutes("organization", [], {
          usageCosts: {
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
    expect(
      costSplitElements.some((element) =>
        Boolean(
          element.className
            .toString()
            .includes("flex items-center gap-1 text-muted-foreground")
        )
      )
    ).toBe(true);
  });

  it("preserves selected team and project filters when metadata queries fail", async () => {
    render(
      <AppCoreStoryProviders
        apiRoutes={monitoringRoutes("organization", [], {
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

  it("keeps org analytics rendered when metadata payloads are not arrays", async () => {
    render(
      <AppCoreStoryProviders
        apiRoutes={monitoringRoutes("organization", [], {
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
      <AppCoreStoryProviders apiRoutes={monitoringRoutes("self")}>
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
      <AppCoreStoryProviders apiRoutes={monitoringRoutes("self")}>
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
});

function monitoringRoutes(
  viewerScope: "organization" | "self",
  requestedPaths: string[] = [],
  options: Readonly<{
    metadataPayload?: "array" | "non-array";
    metadataStatus?: number;
    usageCosts?: {
      apiEstimatedCost: number;
      subscriptionEstimatedCost: number;
      totalEstimatedCost: number;
    };
    usageTotalSessions?: number;
  }> = {}
) {
  return [
    {
      method: "GET",
      path: "/agent-sessions/usage",
      respond: ({ pathname }: { pathname: string }) => {
        requestedPaths.push(pathname);
        return createAgentSessionUsageSummaryFixture(viewerScope, {
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
      respond: ({ pathname }: { pathname: string }) => {
        requestedPaths.push(pathname);
        return {
          items: populatedAgentSessionListFixtures,
          total: populatedAgentSessionListFixtures.length,
          viewerScope,
        };
      },
    },
    {
      method: "GET",
      path: "/agent-sessions/analytics",
      respond: ({ pathname }: { pathname: string }) => {
        requestedPaths.push(pathname);
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
