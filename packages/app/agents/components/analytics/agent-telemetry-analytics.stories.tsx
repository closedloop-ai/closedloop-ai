import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import type { FixtureRoute } from "../../../shared/storybook/fixture-fetch";
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

const storyApiRoutes: FixtureRoute[] = [
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
];

const meta: Meta<typeof AgentTelemetryAnalytics> = {
  component: AgentTelemetryAnalytics,
  tags: ["autodocs"],
  argTypes: {
    queryState: {
      control: "object",
      description:
        "Date range, harness, status, the org filter selections and the page index. The wrapper owns the URL; this component only reads and reports.",
      table: { category: "State" },
    },
    analyticsBreakdownsEnabled: {
      control: "boolean",
      description: "Gates the org analytics breakdown queries and sections.",
      table: { category: "State" },
    },
    organizationFiltersEnabled: {
      control: "boolean",
      description:
        "Gates the team, project and user filters for admin viewers.",
      table: { category: "State" },
    },
    exportHref: { control: "text", table: { category: "Content" } },
    extraColumnLabel: {
      control: "text",
      description: "Header for the wrapper-supplied column.",
      table: { category: "Content" },
    },
    getSessionHref: { control: false, table: { category: "Content" } },
    getUserHref: { control: false, table: { category: "Content" } },
    renderExtraColumn: { control: false, table: { category: "Content" } },
    footerSlot: {
      control: false,
      description:
        "Rendered at the bottom of the scroll column, so a wrapper can fold in an adjacent org-wide section.",
      table: { category: "Content" },
    },
    onQueryStateChange: { control: false, table: { category: "Events" } },
  },
  args: {
    analyticsBreakdownsEnabled: false,
    organizationFiltersEnabled: false,
  },
  parameters: { appCore: { apiRoutes: storyApiRoutes } },
  title: "Surfaces/Telemetry Analytics",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Org: Story = {
  args: {
    analyticsBreakdownsEnabled: true,
    exportHref: "/api/agent-sessions/export?format=csv",
    extraColumnLabel: "Artifact",
    getSessionHref: (item) => `/org-test/sessions/${item.id}`,
    onQueryStateChange: fn(),
    organizationFiltersEnabled: true,
    queryState,
    renderExtraColumn: () => <a href="/org-test/features/FEA-1702">View</a>,
  },
};

export const NonOrg: Story = {
  args: {
    exportHref: "/api/agent-sessions/export?format=csv",
    getSessionHref: (item) => `/sessions/${item.id}`,
    onQueryStateChange: fn(),
    queryState,
  },
};
