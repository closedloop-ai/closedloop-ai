import {
  AGENT_STATUS,
  type SessionOverviewStats,
} from "@repo/app/agents/lib/session-types";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JsonPanel,
  SessionAgentsSection,
  SessionErrorDetailsPanel,
  SessionMetadataPanel,
  SessionOverviewSection,
  SessionSummaryMetrics,
  SessionTimelineSection,
  SessionToolInvocationsPanel,
} from "../session-detail-panels";

// The styled tooltip portals its content out of jsdom; the shared mock keeps the
// trigger's classes and renders the content inline so both can be asserted.
vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

describe("SessionSummaryMetrics", () => {
  it("renders one card per metric, with its label, value, and caption", () => {
    render(
      <SessionSummaryMetrics
        metrics={[
          { detail: "Measured end to end", label: "Duration", value: "12m" },
          { label: "Cost", value: "$3.10" },
        ]}
      />
    );

    expect(screen.getByText("Duration")).toBeInTheDocument();
    expect(screen.getByText("12m")).toBeInTheDocument();
    expect(screen.getByText("Measured end to end")).toBeInTheDocument();
    expect(screen.getByText("Cost")).toBeInTheDocument();
    expect(screen.getByText("$3.10")).toBeInTheDocument();
  });
});

describe("SessionMetadataPanel details block", () => {
  it("renders a details row only when the host passes one", () => {
    const { container, rerender } = render(
      <SessionMetadataPanel
        metadata={[{ label: "Harness", value: "claude" }]}
      />
    );

    expect(screen.getByText("claude")).toBeInTheDocument();
    expect(container.querySelectorAll("div.border-t")).toHaveLength(0);

    rerender(
      <SessionMetadataPanel
        details={[{ label: "Branch", value: "feat/x" }]}
        metadata={[{ label: "Harness", value: "claude" }]}
      />
    );
    expect(container.querySelectorAll("div.border-t")).toHaveLength(1);
    expect(screen.getByText("Branch:")).toBeInTheDocument();
    expect(screen.getByText("feat/x")).toBeInTheDocument();
  });

  it("renders no details row for an empty details list", () => {
    const { container } = render(
      <SessionMetadataPanel
        details={[]}
        metadata={[{ label: "Harness", value: "claude" }]}
      />
    );

    expect(container.querySelectorAll("div.border-t")).toHaveLength(0);
  });
});

describe("SessionMetadataPanel truncation measurement", () => {
  const originalScrollWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollWidth"
  );
  const originalClientWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth"
  );

  function stubWidths(scrollWidth: number, clientWidth: number) {
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get: () => scrollWidth,
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => clientWidth,
    });
  }

  afterEach(() => {
    // scrollWidth/clientWidth are inherited from Element.prototype, so their own
    // descriptors on HTMLElement.prototype are normally undefined — restoring an
    // undefined descriptor would leave the stubs installed and leak the forced
    // geometry into later tests. Delete the own property in that case.
    if (originalScrollWidth) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollWidth",
        originalScrollWidth
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
    }
    if (originalClientWidth) {
      Object.defineProperty(
        HTMLElement.prototype,
        "clientWidth",
        originalClientWidth
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    }
  });

  it("treats a value that exactly fills its column as not clipped", () => {
    stubWidths(120, 120);
    render(
      <SessionMetadataPanel
        metadata={[{ label: "Working directory", value: "apps/app" }]}
      />
    );

    const value = screen.getByText("apps/app");
    expect(value).not.toHaveAttribute("data-slot", "tooltip-trigger");
    expect(value).not.toHaveAttribute("tabindex");
    expect(value).not.toHaveClass("rounded-sm");
    expect(screen.queryByTestId("tooltip-content")).toBeNull();
  });

  it("gives a clipped value a focus ring and a tooltip carrying the full text", () => {
    stubWidths(500, 100);
    render(
      <SessionMetadataPanel
        metadata={[{ label: "Working directory", value: "apps/app/very/long" }]}
      />
    );

    const value = screen.getByText("apps/app/very/long", {
      selector: '[data-slot="tooltip-trigger"]',
    });
    expect(value).toHaveClass("rounded-sm");
    expect(value).toHaveAttribute("tabindex", "0");
    expect(
      screen
        .getAllByTestId("tooltip-content")
        .some((node) => node.textContent === "apps/app/very/long")
    ).toBe(true);
  });
});

describe("session detail table panels", () => {
  it("renders the tool invocation empty state, then rows instead of it", () => {
    const { rerender } = render(<SessionToolInvocationsPanel rows={[]} />);
    expect(screen.getByText("No tool activity")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();

    rerender(
      <SessionToolInvocationsPanel
        rows={[
          {
            count: "5",
            firstSeenAt: "first-seen",
            lastSeenAt: "last-seen",
            toolName: "Bash",
          },
        ]}
      />
    );
    expect(screen.getByRole("cell", { name: "Bash" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "last-seen" })).toBeInTheDocument();
    expect(screen.queryByText("No tool activity")).toBeNull();
  });

  it("renders error events, printing raw data only when present", () => {
    const { container, rerender } = render(
      <SessionErrorDetailsPanel errors={[]} />
    );
    expect(screen.getByText("No errors")).toBeInTheDocument();

    rerender(
      <SessionErrorDetailsPanel
        errors={[
          {
            createdAt: "at-1",
            eventType: "api_error",
            id: "e1",
            rawData: '{"code":500}',
            summary: "Server exploded",
          },
          {
            createdAt: "at-2",
            eventType: "tool_error",
            id: "e2",
            rawData: null,
            summary: "Tool failed",
          },
        ]}
      />
    );
    expect(screen.getByText("Server exploded")).toBeInTheDocument();
    expect(screen.getByText("Tool failed")).toBeInTheDocument();
    const rawBlocks = container.querySelectorAll("pre");
    expect(rawBlocks).toHaveLength(1);
    expect(rawBlocks[0]).toHaveTextContent('{"code":500}');
    expect(screen.queryByText("No errors")).toBeNull();
  });
});

describe("SessionAgentsSection", () => {
  it("renders the empty state without agents", () => {
    render(<SessionAgentsSection agents={[]} />);

    expect(screen.getByText("No agents")).toBeInTheDocument();
  });

  it("renders one card per agent and highlights the active one", () => {
    render(
      <SessionAgentsSection
        activeAgentId="agent-2"
        agents={[
          agent({ id: "agent-1", name: "Planner" }),
          agent({ id: "agent-2", name: "Coder" }),
        ]}
      />
    );

    expect(screen.queryByText("No agents")).toBeNull();
    expect(cardRoot("Coder")).toHaveClass("border-primary/35");
    expect(cardRoot("Planner")).not.toHaveClass("border-primary/35");
  });
});

describe("SessionTimelineSection", () => {
  const facets = {
    agents: [{ id: "a1", label: "Main" }],
    eventTypes: ["tool", "message", "error"],
    statuses: ["ok", "failed"],
    toolNames: ["Bash"],
  };

  it("renders the empty state when there are no event groups", () => {
    render(<SessionTimelineSection facets={facets} groups={[]} />);

    expect(screen.getByText("No events")).toBeInTheDocument();
    expect(screen.queryByText("2 statuses")).toBeNull();
  });

  it("summarizes facets and echoes every active filter", () => {
    render(
      <SessionTimelineSection
        activeFilters={{
          agents: [],
          eventTypes: ["message"],
          query: "deploy",
          statuses: ["failed"],
          toolNames: ["Bash"],
        }}
        facets={facets}
        groups={[eventGroup()]}
      />
    );

    expect(screen.getByText("2 statuses")).toBeInTheDocument();
    expect(screen.getByText("3 event types")).toBeInTheDocument();
    expect(screen.getByText("1 tools")).toBeInTheDocument();
    expect(screen.getByText("1 agents")).toBeInTheDocument();
    expect(screen.getByText("Search: deploy")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("message")).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
  });

  it("renders the group rows and the facet strip when the host passes no filters", () => {
    render(<SessionTimelineSection facets={facets} groups={[eventGroup()]} />);

    expect(screen.getByText("Group one")).toBeInTheDocument();
    expect(screen.getByText("2 statuses")).toBeInTheDocument();
    expect(screen.queryByText("No events")).toBeNull();
  });

  it("omits the search chip when no query is active", () => {
    render(
      <SessionTimelineSection
        activeFilters={{
          agents: [],
          eventTypes: [],
          query: "",
          statuses: [],
          toolNames: [],
        }}
        facets={facets}
        groups={[eventGroup()]}
      />
    );

    expect(screen.getByText("2 statuses")).toBeInTheDocument();
    expect(
      screen.queryByText((content) => content.startsWith("Search:"))
    ).toBeNull();
  });
});

describe("SessionOverviewSection", () => {
  it("states an unknown subagent count as no data with a cause caption", () => {
    render(<SessionOverviewSection stats={stats({ subagents: null })} />);

    expect(
      screen.getByText("Not available for this session")
    ).toBeInTheDocument();
  });

  it("renders a known subagent count as a number without the unavailable caption", () => {
    render(<SessionOverviewSection stats={stats({ subagents: 4321 })} />);

    expect(screen.getByText((4321).toLocaleString())).toBeInTheDocument();
    expect(screen.queryByText("Not available for this session")).toBeNull();
  });

  it("lists top tools, or says there was no tool activity", () => {
    const { rerender } = render(
      <SessionOverviewSection
        stats={stats({ topTools: [{ count: 9, toolName: "Grep" }] })}
      />
    );
    expect(screen.getByText("Grep")).toBeInTheDocument();
    expect(screen.queryByText("No tool activity.")).toBeNull();

    rerender(<SessionOverviewSection stats={stats({ topTools: [] })} />);
    expect(screen.getByText("No tool activity.")).toBeInTheDocument();
  });

  it("says subagent types are unavailable when the producer flags them so", () => {
    render(
      <SessionOverviewSection
        stats={stats({
          subagentTypes: [{ count: 1, label: "reviewer" }],
          subagentTypesAvailable: false,
        })}
      />
    );

    expect(
      screen.getByText("Subagent types aren't available for this session.")
    ).toBeInTheDocument();
    expect(screen.queryByText("reviewer 1")).toBeNull();
  });

  it("says the session ran no subagents when the tally is empty", () => {
    render(<SessionOverviewSection stats={stats({ subagentTypes: [] })} />);

    expect(
      screen.getByText("This session ran no subagents.")
    ).toBeInTheDocument();
  });

  it("marks compaction types as warnings and omits the remainder line when nothing is hidden", () => {
    render(
      <SessionOverviewSection
        stats={stats({
          subagentTypes: [
            { count: 2, isCompaction: true, label: "compact" },
            { count: 3, label: "reviewer" },
          ],
        })}
      />
    );

    expect(screen.getByText("compact 2")).toHaveClass("bg-warning/14");
    // The ordinary type keeps the outline chip, not the warning one.
    expect(screen.getByText("reviewer 3")).toHaveClass("bg-input");
    expect(screen.getByText("reviewer 3")).not.toHaveClass("bg-warning/14");
    expect(
      screen.queryByText((content) => content.includes("not shown"))
    ).toBeNull();
  });

  it("states one omitted type and one omitted subagent in the singular", () => {
    render(
      <SessionOverviewSection
        stats={stats({
          subagentTypes: [{ count: 3, label: "reviewer" }],
          subagentTypesOmitted: 1,
          subagentTypesOmittedAgentCount: 1,
        })}
      />
    );

    expect(
      screen.getByText("1 more type not shown (1 subagent)")
    ).toBeInTheDocument();
  });

  it("states several omitted types and subagents in the plural", () => {
    render(
      <SessionOverviewSection
        stats={stats({
          subagentTypes: [{ count: 3, label: "reviewer" }],
          subagentTypesOmitted: 2,
          subagentTypesOmittedAgentCount: 5,
        })}
      />
    );

    expect(
      screen.getByText("2 more types not shown (5 subagents)")
    ).toBeInTheDocument();
  });

  it("reads a missing omitted-agent count as zero", () => {
    render(
      <SessionOverviewSection
        stats={stats({
          subagentTypes: [{ count: 3, label: "reviewer" }],
          subagentTypesOmitted: 3,
        })}
      />
    );

    expect(
      screen.getByText("3 more types not shown (0 subagents)")
    ).toBeInTheDocument();
  });

  it("shows the active agent with its current tool, or without one", () => {
    const { rerender } = render(
      <SessionOverviewSection
        stats={stats({
          activeAgent: { currentTool: "Edit", name: "Builder" },
        })}
      />
    );
    expect(screen.getByText("Active agent")).toBeInTheDocument();
    expect(screen.getByText("Builder")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();

    rerender(
      <SessionOverviewSection
        stats={stats({ activeAgent: { currentTool: null, name: "Builder" } })}
      />
    );
    expect(screen.getByText("Builder")).toBeInTheDocument();
    expect(screen.queryByText("Edit")).toBeNull();

    rerender(<SessionOverviewSection stats={stats({ activeAgent: null })} />);
    expect(screen.queryByText("Active agent")).toBeNull();
  });
});

describe("JsonPanel", () => {
  it("prints the structured value when one exists", () => {
    render(<JsonPanel title="Raw payload" value='{"a":1}' />);

    expect(screen.getByText('{"a":1}')).toBeInTheDocument();
    expect(screen.queryByText("No raw payload")).toBeNull();
  });

  it("falls back to the default empty message titled from the panel", () => {
    render(<JsonPanel title="Raw Payload" value={null} />);

    expect(screen.getByText("No raw payload")).toBeInTheDocument();
    expect(
      screen.getByText("No structured data is available.")
    ).toBeInTheDocument();
  });

  it("uses a caller-supplied empty message", () => {
    render(<JsonPanel emptyMessage="Nothing here." title="Settings" />);

    expect(screen.getByText("Nothing here.")).toBeInTheDocument();
  });
});

function stats(overrides: Partial<SessionOverviewStats>): SessionOverviewStats {
  return {
    compactions: 0,
    durationLabel: null,
    errors: 0,
    eventMix: [],
    subagentTypes: [],
    subagents: 0,
    tokens: {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    toolCalls: 0,
    topTools: [],
    totalEvents: 0,
    ...overrides,
  };
}

function agent({ id, name }: { id: string; name: string }) {
  return {
    id,
    name,
    sessionId: "session-1",
    startedAt: "2026-07-22T12:00:00.000Z",
    status: AGENT_STATUS.COMPLETED,
    type: "subagent" as const,
  };
}

function eventGroup() {
  return {
    events: [
      {
        createdAt: "2026-07-22T12:00:00.000Z",
        eventType: "note",
        id: "event-1",
        sessionId: "session-1",
        status: AGENT_STATUS.COMPLETED,
        title: "Group event",
      },
    ],
    id: "g1",
    title: "Group one",
  };
}

function cardRoot(name: string): HTMLElement | null {
  return screen.getByText(name).closest(".rounded-xl");
}
