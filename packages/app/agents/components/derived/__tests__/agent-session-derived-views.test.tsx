import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { AgentSessionAnalyticsTab } from "../../detail/agent-session-detail-analytics-tabs";
import {
  emptyAgentsAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
} from "../../detail/agent-session-detail-fixtures";
import { AgentSessionDerivedViews } from "../agent-session-derived-views";

describe("AgentSessionDerivedViews", () => {
  it("renders loading, error, and empty package-owned shell states", () => {
    const { rerender } = renderWithProviders(
      <AgentSessionDerivedViews agents={[]} events={[]} isLoading />
    );

    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();

    rerender(
      withProviders(
        <AgentSessionDerivedViews agents={[]} events={[]} isError />
      )
    );
    expect(
      screen.getByText("Agent-derived views are temporarily unavailable.")
    ).toBeInTheDocument();

    rerender(
      withProviders(
        <AgentSessionDerivedViews
          agents={emptyAgentsAgentSessionDetailFixture.agents}
          events={emptyAgentsAgentSessionDetailFixture.events}
        />
      )
    );
    expect(
      screen.getByText("No agent-derived views are available for this session.")
    ).toBeInTheDocument();
  });

  it("delegates populated workflow, tool, subagent, and error rendering to detail analytics", () => {
    renderWithProviders(
      <AgentSessionDerivedViews
        agents={populatedAgentSessionDetailFixture.agents}
        events={populatedAgentSessionDetailFixture.events}
      />
    );

    expect(screen.getByText("Agent Analytics")).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Effectiveness" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Orchestration" })
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Tool Flow" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Error Map" })).toBeInTheDocument();
  });

  it("passes exact initial analytics tabs after loading, error, and empty guards", () => {
    renderWithProviders(
      <AgentSessionDerivedViews
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
      <AgentSessionDerivedViews
        agents={populatedAgentSessionDetailFixture.agents}
        defaultTab={AgentSessionAnalyticsTab.Effectiveness}
        events={populatedAgentSessionDetailFixture.events}
      />
    );

    expect(screen.getByRole("tab", { name: "Effectiveness" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("surfaces unattributed tool and error telemetry instead of showing false empty states", async () => {
    const user = userEvent.setup();
    const staleEvents = [
      ...populatedAgentSessionDetailFixture.events,
      {
        externalEventId: "event-orphan-tool",
        agentExternalId: "missing-agent",
        eventType: "tool_use",
        toolName: "apply_patch",
        summary: "Tool event has no projected agent row.",
        createdAt: "2026-06-10T12:21:00.000Z",
      },
      {
        externalEventId: "event-orphan-error",
        agentExternalId: null,
        eventType: "error",
        summary: "Error event has no agent attribution.",
        createdAt: "2026-06-10T12:22:00.000Z",
      },
    ];

    renderWithProviders(
      <AgentSessionDerivedViews
        agents={populatedAgentSessionDetailFixture.agents}
        events={staleEvents}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Tool Flow" }));
    expect(screen.getByText("Unattributed telemetry")).toBeInTheDocument();
    expect(
      screen.queryByText("No tool invocations captured for this session.")
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Error Map" }));
    expect(screen.getByText("2 error events total")).toBeInTheDocument();
    expect(
      screen.getByText("Error event has no agent attribution.")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No errors in this session")
    ).not.toBeInTheDocument();
  });

  it("renders zero-agent orphan tool and error telemetry instead of the empty shell", async () => {
    const user = userEvent.setup();
    const orphanOnlyEvents = [
      {
        externalEventId: "event-zero-agent-tool",
        agentExternalId: "unknown-agent",
        eventType: "tool_use",
        toolName: "apply_patch",
        summary: "Tool event arrived before agent projection.",
        createdAt: "2026-06-10T12:21:00.000Z",
      },
      {
        externalEventId: "event-zero-agent-error",
        agentExternalId: null,
        eventType: "error",
        summary: "Error event has no projected agent row.",
        createdAt: "2026-06-10T12:22:00.000Z",
      },
    ];

    renderWithProviders(
      <AgentSessionDerivedViews agents={[]} events={orphanOnlyEvents} />
    );

    expect(screen.getByText("Agent Analytics")).toBeInTheDocument();
    expect(
      screen.queryByText(
        "No agent-derived views are available for this session."
      )
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Tool Flow" }));
    expect(screen.getByText("Unattributed telemetry")).toBeInTheDocument();
    expect(
      screen.queryByText("No tool invocations captured for this session.")
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Error Map" }));
    expect(screen.getByText("1 error event total")).toBeInTheDocument();
    expect(
      screen.getByText("Error event has no projected agent row.")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No errors in this session")
    ).not.toBeInTheDocument();
  });
});

function renderWithProviders(ui: React.ReactElement) {
  return render(withProviders(ui));
}

function withProviders(ui: React.ReactElement) {
  return <AppCoreStoryProviders>{ui}</AppCoreStoryProviders>;
}
