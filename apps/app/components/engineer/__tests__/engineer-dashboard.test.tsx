import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/components/engineer/HealthCheckDialog", () => ({
  HealthCheckDialog: () => (
    <div data-testid="health-check-dialog">Health Check Dialog</div>
  ),
}));

vi.mock("@/components/engineer/HeaderOverflowMenu", () => ({
  HeaderOverflowMenu: () => <div data-testid="header-overflow-menu" />,
}));

vi.mock("@/components/engineer/LearningsDialog", () => ({
  LearningsDialog: () => <div data-testid="learnings-dialog" />,
}));

vi.mock("@/components/engineer/MCPConnectionStatus", () => ({
  MCPConnectionStatus: () => <div data-testid="mcp-status" />,
}));

vi.mock("@/components/engineer/TerminalChatDialog", () => ({
  TerminalChatDialog: () => <div data-testid="terminal-chat-dialog" />,
}));

vi.mock("@/components/engineer/TicketList", () => ({
  TicketList: () => <div data-testid="ticket-list" />,
}));

vi.mock("@/components/engineer/compute-target-selector", () => ({
  ComputeTargetSelector: () => <div data-testid="compute-target-selector" />,
}));

vi.mock("@/contexts/engineer-mcp-context", () => ({
  useOptionalEngineerMcp: () => null,
}));

vi.mock("@/hooks/engineer/use-engineer-issues", () => ({
  useEngineerIssues: () => ({
    tickets: [],
    isLoading: false,
    isFetching: false,
    error: null,
    isMcpFailed: false,
    user: { name: "Test User", email: "test@example.com" },
    updateTicketStatus: vi.fn(),
    getFullTicket: vi.fn(),
    postComment: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/engineer/use-feature-seen", () => ({
  useFeatureSeen: () => ({
    seen: true,
    markSeen: vi.fn(),
  }),
}));

vi.mock("@/hooks/engineer/useTerminalStatus", () => ({
  useTerminalStatus: () => ({
    displayText: "ready",
    prefix: null,
    phase: "idle",
    isTypewriter: false,
    persistentMsg: null,
  }),
}));

vi.mock("@/lib/engineer/mcp-mode", () => ({
  isEngineerMcpEnabled: false,
}));

vi.mock("@/lib/engineer/terminal-bus", () => ({
  terminalBus: {
    send: vi.fn(),
    clear: vi.fn(),
  },
}));

import { EngineerDashboard } from "../engineer-dashboard";

describe("EngineerDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.localStorage.clear();
  });

  it("does not mount its own health check dialog", () => {
    render(<EngineerDashboard />);

    expect(screen.queryByTestId("health-check-dialog")).toBeNull();
    expect(screen.getByTestId("ticket-list")).toBeInTheDocument();
  });
});
