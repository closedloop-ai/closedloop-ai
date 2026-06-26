import type { Meta, StoryObj } from "@storybook/react";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import {
  createAgentSessionAnalyticsFixture,
  createAgentSessionUsageSummaryFixture,
  populatedAgentSessionListFixtures,
} from "../sessions/session-list-fixtures";
import {
  AgentTelemetryAnalytics,
  type AgentTelemetryAnalyticsQueryState,
} from "./agent-telemetry-analytics";

const queryState: AgentTelemetryAnalyticsQueryState = {
  dateRange: "30d",
  harness: "all",
  page: 0,
  selectedProjectId: null,
  selectedTeamId: null,
  selectedUserId: null,
  status: "all",
};

const meta: Meta<typeof AgentTelemetryAnalytics> = {
  component: AgentTelemetryAnalytics,
  decorators: [
    (Story) => (
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/agent-sessions/usage",
            respond: () =>
              createAgentSessionUsageSummaryFixture("organization", {
                byModel: [
                  {
                    cacheReadTokens: 400,
                    cacheWriteTokens: 100,
                    estimatedCost: 12,
                    inputTokens: 120_000,
                    model: "gpt-5.5",
                    outputTokens: 48_000,
                    sessionCount: 2,
                  },
                ],
                byUser: [
                  {
                    cacheReadTokens: 400,
                    cacheWriteTokens: 100,
                    estimatedCost: 12,
                    inputTokens: 120_000,
                    outputTokens: 48_000,
                    sessionCount: 2,
                    userAvatarUrl: null,
                    userEmail: "user@example.com",
                    userId: "user-1",
                    userName: "User Person",
                  },
                ],
                totalEstimatedCost: 12,
                totalInputTokens: 120_000,
                totalOutputTokens: 48_000,
                totalSessions: 2,
              }),
          },
          {
            method: "GET",
            path: "/agent-sessions",
            respond: () => ({
              items: populatedAgentSessionListFixtures,
              total: populatedAgentSessionListFixtures.length,
              viewerScope: "organization",
            }),
          },
          {
            method: "GET",
            path: "/agent-sessions/analytics",
            respond: () => createAgentSessionAnalyticsFixture("organization"),
          },
          {
            method: "GET",
            path: "/teams",
            respond: () => [{ id: "team-1", name: "Platform" }],
          },
          {
            method: "GET",
            path: "/projects",
            respond: () => [{ id: "project-1", name: "Platform" }],
          },
        ]}
      >
        <Story />
      </AppCoreStoryProviders>
    ),
  ],
  title: "App Core/Agents/Telemetry Analytics",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Org: Story = {
  args: {
    analyticsBreakdownsEnabled: true,
    exportHref: "/api/agent-sessions/export?format=csv",
    extraColumnLabel: "Artifact",
    getSessionHref: (item) => `/org-test/sessions/${item.id}`,
    onQueryStateChange: () => undefined,
    organizationFiltersEnabled: true,
    queryState,
    renderExtraColumn: () => <a href="/org-test/features/FEA-1702">View</a>,
  },
};

export const NonOrg: Story = {
  args: {
    exportHref: "/api/agent-sessions/export?format=csv",
    getSessionHref: (item) => `/sessions/${item.id}`,
    onQueryStateChange: () => undefined,
    queryState,
  },
};
