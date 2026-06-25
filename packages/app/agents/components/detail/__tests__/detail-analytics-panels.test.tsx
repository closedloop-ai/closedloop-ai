import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import {
  AgentSessionAnalyticsTab,
  type AgentSessionAnalyticsTab as AgentSessionAnalyticsTabValue,
  AgentSessionDetailAnalyticsTabs,
} from "../agent-session-detail-analytics-tabs";
import {
  emptyAgentsAgentSessionDetailFixture,
  errorChainAgentSessionDetailFixture,
  noErrorAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
} from "../agent-session-detail-fixtures";
import { ErrorPropagationMap } from "../error-propagation-map";
import { ToolExecutionFlow } from "../tool-execution-flow";

describe("agent detail analytics panels", () => {
  it("returns null for empty-agent analytics to preserve org route behavior", () => {
    const { container } = render(
      <AgentSessionDetailAnalyticsTabs
        agents={emptyAgentsAgentSessionDetailFixture.agents}
        events={emptyAgentsAgentSessionDetailFixture.events}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders no-error and error-chain Error Map states", () => {
    const { rerender } = renderWithProviders(
      <ErrorPropagationMap
        agents={noErrorAgentSessionDetailFixture.agents}
        events={noErrorAgentSessionDetailFixture.events}
      />
    );

    expect(screen.getByText("No errors in this session")).toBeInTheDocument();

    rerender(
      withProviders(
        <ErrorPropagationMap
          agents={errorChainAgentSessionDetailFixture.agents}
          events={errorChainAgentSessionDetailFixture.events}
        />
      )
    );

    expect(screen.getByText("1 error event total")).toBeInTheDocument();
    expect(screen.getByText("Review lane")).toBeInTheDocument();
  });

  it("renders tool-empty state without failing", () => {
    renderWithProviders(
      <ToolExecutionFlow
        agents={noErrorAgentSessionDetailFixture.agents}
        events={noErrorAgentSessionDetailFixture.events.map((event) => ({
          ...event,
          toolName: null,
        }))}
      />
    );

    expect(
      screen.getByText("No tool invocations captured for this session.")
    ).toBeInTheDocument();
  });

  it("keeps orchestration as the omitted default tab", () => {
    renderWithProviders(
      <AgentSessionDetailAnalyticsTabs
        agents={populatedAgentSessionDetailFixture.agents}
        events={populatedAgentSessionDetailFixture.events}
      />
    );

    expect(screen.getByRole("tab", { name: "Orchestration" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("opens the requested exact analytics tab and ignores similar invalid ids", () => {
    renderWithProviders(
      <AgentSessionDetailAnalyticsTabs
        agents={populatedAgentSessionDetailFixture.agents}
        defaultTab={AgentSessionAnalyticsTab.ToolFlow}
        events={populatedAgentSessionDetailFixture.events}
      />
    );

    expect(screen.getByRole("tab", { name: "Tool Flow" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    cleanup();
    renderWithProviders(
      <AgentSessionDetailAnalyticsTabs
        agents={populatedAgentSessionDetailFixture.agents}
        defaultTab={"toolFlow" as AgentSessionAnalyticsTabValue}
        events={populatedAgentSessionDetailFixture.events}
      />
    );

    expect(screen.getByRole("tab", { name: "Tool Flow" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });
});

function renderWithProviders(ui: React.ReactElement) {
  return render(withProviders(ui));
}

function withProviders(ui: React.ReactElement) {
  return <AppCoreStoryProviders>{ui}</AppCoreStoryProviders>;
}
