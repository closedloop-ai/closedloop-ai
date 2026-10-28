import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { agentDetailSource, makeDetail } from "../agent-component-fixtures";
import { AgentInvocationFrequency } from "../agent-invocation-frequency";

describe("agent invocation frequency", () => {
  it("keeps an older source unavailable rather than claiming zero usage", () => {
    render(
      <AppCoreStoryProviders>
        <AgentComponentsDataSourceProvider
          dataSource={agentDetailSource(makeDetail({}))}
        >
          <AgentInvocationFrequency slug="skill::review" />
        </AgentComponentsDataSourceProvider>
      </AppCoreStoryProviders>
    );
    expect(
      screen.getByText("Usage for this component isn't available here")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No usage recorded in the last 30 days.")
    ).not.toBeInTheDocument();
  });
  it("uses the canonical 30-day frequency read and names a measured empty window", async () => {
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/agent-components/skill%3A%3Areview/frequency",
            respond: ({ searchParams }) => {
              expect(searchParams.get("windowDays")).toBe("30");
              return { windowDays: 30, points: [] };
            },
          },
        ]}
      >
        <AgentInvocationFrequency slug="skill::review" />
      </AppCoreStoryProviders>
    );
    expect(
      await screen.findByText("No usage recorded in the last 30 days.")
    ).toBeInTheDocument();
  });
  it("reports a malformed count through the established unavailable state", async () => {
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/agent-components/skill%3A%3Areview/frequency",
            respond: () => ({
              windowDays: 30,
              points: [{ day: "2026-10-19", invocations: -1 }],
            }),
          },
        ]}
      >
        <AgentInvocationFrequency slug="skill::review" />
      </AppCoreStoryProviders>
    );
    expect(
      await screen.findByText("Usage for this component isn't available here")
    ).toBeInTheDocument();
  });
});
