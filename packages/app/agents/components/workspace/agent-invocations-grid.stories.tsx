import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import type { Meta, StoryObj } from "@storybook/react";
import type { FixtureRoute } from "../../../shared/storybook/fixture-fetch";
import {
  createAgentSessionListItemFixture,
  createFullyPopulatedSessionsUsageFixture,
} from "../sessions/session-list-fixtures";
import { makeDetail } from "./agent-component-fixtures";
import { AgentInvocationFrequency } from "./agent-invocation-frequency";
import { AgentInvocationsGrid } from "./agent-invocations-grid";

const component = makeDetail({ slug: "subagent::design-critic" });

function InvocationsFixture() {
  return (
    <>
      <AgentInvocationFrequency slug={component.slug} />
      <AgentInvocationsGrid
        component={component}
        getSessionHref={(row) => `/sessions/${row.id}`}
      />
    </>
  );
}

const meta = {
  title: "Composites/Labs/Agents/Agent Detail/Agent Invocations Grid",
  component: InvocationsFixture,
  tags: ["preview", "autodocs"],
  parameters: {
    layout: "fullscreen",
    appCore: { apiRoutes: invocationRoutes("populated") },
  },
} satisfies Meta<typeof InvocationsFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = {
  parameters: { appCore: { apiRoutes: invocationRoutes("empty") } },
};
export const ReadError: Story = {
  parameters: { appCore: { apiRoutes: invocationRoutes("error") } },
};

function invocationRoutes(
  state: "populated" | "empty" | "error"
): FixtureRoute[] {
  return [
    {
      method: "GET",
      path: "/agent-components/subagent%3A%3Adesign-critic/frequency",
      status: state === "error" ? 503 : 200,
      respond: () => ({
        windowDays: 30,
        points:
          state === "empty"
            ? []
            : [
                { day: "2026-10-17", invocations: 3 },
                { day: "2026-10-18", invocations: 8 },
                { day: "2026-10-19", invocations: 2 },
              ],
      }),
    },
    {
      method: "GET",
      path: "/agent-sessions",
      status: state === "error" ? 503 : 200,
      respond: ({ searchParams }) => ({
        componentScope: component.slug,
        items:
          state === "empty"
            ? []
            : [
                createAgentSessionListItemFixture({
                  id: "review-session",
                  name: `Design review ${Number(searchParams.get("offset")) + 1}`,
                  updatedAt: "2026-10-19T11:00:00Z",
                }),
              ],
        total: state === "empty" ? 0 : 51,
        viewerScope: AgentSessionViewerScope.Organization,
      }),
    },
    {
      method: "GET",
      path: "/agent-sessions/usage",
      respond: () => ({
        ...createFullyPopulatedSessionsUsageFixture(),
        componentScope: component.slug,
      }),
    },
    { method: "GET", path: "/artifacts/favorites", respond: () => [] },
  ];
}
