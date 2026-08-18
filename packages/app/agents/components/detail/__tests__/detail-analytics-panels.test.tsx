import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
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
    // FEA-3557: the component now reads a `?view=` param via useTabParam, which
    // needs the navigation port, so it renders under the standard providers even
    // though the empty-agent path short-circuits to null before the tabs render.
    const { container } = renderWithProviders(
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

// ---------------------------------------------------------------------------
// FEA-3557: analytics sub-tab permalink (?view=)
// ---------------------------------------------------------------------------

function viewQuery(href: string): string | null {
  const q = href.indexOf("?");
  return new URLSearchParams(q === -1 ? "" : href.slice(q + 1)).get("view");
}

function renderAnalyticsWithNav(initialPath: string) {
  const nav = createMemoryNavigation({ initialPath, orgSlug: "org-test" });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  const view = render(
    <AgentSessionDetailAnalyticsTabs
      agents={populatedAgentSessionDetailFixture.agents}
      events={populatedAgentSessionDetailFixture.events}
    />,
    { wrapper }
  );
  return { nav, ...view };
}

describe("analytics sub-tab permalink (FEA-3557)", () => {
  it("deep-links to the Tool Flow sub-tab from ?view=tool-flow", () => {
    renderAnalyticsWithNav("/session?view=tool-flow");

    expect(screen.getByRole("tab", { name: "Tool Flow" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("falls back to Orchestration for an invalid ?view= value", () => {
    renderAnalyticsWithNav("/session?view=bogus");

    expect(screen.getByRole("tab", { name: "Orchestration" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("writes ?view= on switch and cleans the default back out", async () => {
    const user = userEvent.setup();
    const { nav } = renderAnalyticsWithNav("/session");

    // Uses a dedicated `view` param — never collides with a top-level `tab`.
    expect(viewQuery(nav.getCurrentHref())).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Error Map" }));
    await waitFor(() => {
      expect(viewQuery(nav.getCurrentHref())).toBe("errors");
    });

    await user.click(screen.getByRole("tab", { name: "Orchestration" }));
    await waitFor(() => {
      expect(viewQuery(nav.getCurrentHref())).toBeNull();
    });
  });
});
