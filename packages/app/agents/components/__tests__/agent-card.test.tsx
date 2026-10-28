import { AgentCard } from "@repo/app/agents/components/agent-card";
import type { SessionAgent } from "@repo/app/agents/lib/session-types";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-01-15T12:00:00.000Z");
const RE_DOLLAR_PREFIX = /^\$/;
const RE_STARTED_PREFIX = /^Started/;

function buildAgent(overrides: Partial<SessionAgent> = {}): SessionAgent {
  return {
    id: "agent-1",
    sessionId: "session-1",
    name: "Main agent",
    type: "main",
    status: "idle",
    startedAt: "2026-01-15T08:00:00.000Z",
    ...overrides,
  };
}

describe("AgentCard icon and container by agent type", () => {
  it("uses the primary Bot glyph for the main agent", () => {
    const { container } = render(
      <AgentCard agent={buildAgent({ type: "main" })} />
    );

    expect(container.querySelector(".bg-primary\\/12")).not.toBeNull();
    expect(container.querySelector(".bg-violet-500\\/12")).toBeNull();
  });

  it("uses the violet GitBranch glyph for a subagent", () => {
    const { container } = render(
      <AgentCard agent={buildAgent({ type: "subagent" })} />
    );

    expect(container.querySelector(".bg-violet-500\\/12")).not.toBeNull();
    expect(container.querySelector(".bg-primary\\/12")).toBeNull();
  });
});

describe("AgentCard active state", () => {
  it("applies the active ring treatment when active", () => {
    const { container } = render(
      <AgentCard active={true} agent={buildAgent()} />
    );

    expect(container.firstElementChild?.className).toContain("ring-primary/20");
  });

  it("applies the inactive hover treatment when not active", () => {
    const { container } = render(
      <AgentCard active={false} agent={buildAgent()} />
    );

    expect(container.firstElementChild?.className).not.toContain(
      "ring-primary/20"
    );
    expect(container.firstElementChild?.className).toContain(
      "hover:border-border"
    );
  });
});

describe("AgentCard optional fields", () => {
  it("renders a subagentType badge only when one is set", () => {
    const { rerender } = render(
      <AgentCard agent={buildAgent({ subagentType: "code-reviewer" })} />
    );
    expect(screen.getByText("code-reviewer")).toBeInTheDocument();

    rerender(<AgentCard agent={buildAgent({ subagentType: null })} />);
    expect(screen.queryByText("code-reviewer")).toBeNull();
  });

  it("renders the label only when set", () => {
    const { rerender } = render(
      <AgentCard agent={buildAgent({ label: "Bug Hunter A" })} />
    );
    expect(screen.getByText("Bug Hunter A")).toBeInTheDocument();

    rerender(<AgentCard agent={buildAgent({ label: null })} />);
    expect(screen.queryByText("Bug Hunter A")).toBeNull();
  });

  it("renders the current tool only when set", () => {
    const { rerender } = render(
      <AgentCard agent={buildAgent({ currentTool: "Read" })} />
    );
    expect(screen.getByText("Read")).toBeInTheDocument();

    rerender(<AgentCard agent={buildAgent({ currentTool: null })} />);
    expect(screen.queryByText("Read")).toBeNull();
  });

  it("renders the model only when set", () => {
    const { rerender } = render(
      <AgentCard agent={buildAgent({ model: "claude-sonnet" })} />
    );
    expect(screen.getByText("claude-sonnet")).toBeInTheDocument();

    rerender(<AgentCard agent={buildAgent({ model: null })} />);
    expect(screen.queryByText("claude-sonnet")).toBeNull();
  });
});

describe("AgentCard cost display", () => {
  it("shows the formatted cost when it is a positive number", () => {
    render(<AgentCard agent={buildAgent({ cost: 12.5 })} />);
    expect(screen.getByText("$12.50")).toBeInTheDocument();
  });

  it("hides the cost when it is exactly zero", () => {
    render(<AgentCard agent={buildAgent({ cost: 0 })} />);
    expect(screen.queryByText(RE_DOLLAR_PREFIX)).toBeNull();
  });

  it("hides the cost when it is missing", () => {
    render(<AgentCard agent={buildAgent({ cost: null })} />);
    expect(screen.queryByText(RE_DOLLAR_PREFIX)).toBeNull();
  });
});

describe("AgentCard timestamps", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prefers updatedAt over endedAt and startedAt for the activity clock", () => {
    render(
      <AgentCard
        agent={buildAgent({
          updatedAt: "2026-01-15T10:00:00.000Z",
          endedAt: "2026-01-15T09:00:00.000Z",
          startedAt: "2026-01-15T08:00:00.000Z",
        })}
      />
    );

    expect(screen.getByText("2 hours ago")).toBeInTheDocument();
  });

  it("falls back to endedAt when updatedAt is absent", () => {
    render(
      <AgentCard
        agent={buildAgent({
          updatedAt: null,
          endedAt: "2026-01-15T09:00:00.000Z",
          startedAt: "2026-01-15T08:00:00.000Z",
        })}
      />
    );

    expect(screen.getByText("3 hours ago")).toBeInTheDocument();
  });

  it("falls back to startedAt when neither updatedAt nor endedAt is set", () => {
    render(
      <AgentCard
        agent={buildAgent({
          updatedAt: null,
          endedAt: null,
          startedAt: "2026-01-15T08:00:00.000Z",
        })}
      />
    );

    expect(screen.getByText("4 hours ago")).toBeInTheDocument();
  });

  it("always shows a Started label with the start date", () => {
    render(<AgentCard agent={buildAgent()} />);
    expect(screen.getByText(RE_STARTED_PREFIX)).toBeInTheDocument();
  });
});

describe("AgentCard status badge", () => {
  const statuses: [SessionAgent["status"], string][] = [
    ["working", "Working"],
    ["waiting", "Waiting"],
    ["completed", "Completed"],
    ["error", "Error"],
    ["idle", "Idle"],
  ];

  for (const [status, label] of statuses) {
    it(`shows the ${label} status badge`, () => {
      render(<AgentCard agent={buildAgent({ status })} />);
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  }

  it("applies the waiting-accent left border", () => {
    const { container } = render(
      <AgentCard agent={buildAgent({ status: "waiting" })} />
    );
    expect(container.firstElementChild?.className).toContain(
      "border-l-warning"
    );
  });

  it("applies the working-accent left border", () => {
    const { container } = render(
      <AgentCard agent={buildAgent({ status: "working" })} />
    );
    expect(container.firstElementChild?.className).toContain(
      "border-l-success"
    );
  });

  it("applies the neutral border for a non-active status", () => {
    const { container } = render(
      <AgentCard agent={buildAgent({ status: "idle" })} />
    );
    expect(container.firstElementChild?.className).not.toContain(
      "border-l-warning"
    );
    expect(container.firstElementChild?.className).not.toContain(
      "border-l-success"
    );
  });
});
