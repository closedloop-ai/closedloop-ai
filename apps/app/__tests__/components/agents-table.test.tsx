import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPush = vi.fn();
const mockMutate = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: mockPush, replace: vi.fn() })),
  usePathname: vi.fn(() => "/agents"),
  useSearchParams: vi.fn(
    () =>
      new URLSearchParams() as unknown as ReturnType<
        typeof import("next/navigation").useSearchParams
      >
  ),
}));

vi.mock("@/hooks/queries/use-agents", () => ({
  useAgents: vi.fn(() => ({ data: null, isLoading: false, error: null })),
  useUpdateAgent: vi.fn(() => ({
    mutate: mockMutate,
    isPending: false,
  })),
  useCreateAgent: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

vi.mock("@/hooks/queries/use-bootstrap-agents", () => ({
  BootstrapStatus: {
    Idle: "idle",
    Creating: "creating",
    Dispatched: "dispatched",
    Running: "running",
    Ingesting: "ingesting",
    Completed: "completed",
    Error: "error",
  },
  useBootstrapAgents: vi.fn(() => ({
    state: { status: "idle" },
    dispatch: vi.fn(),
    reset: vi.fn(),
  })),
}));

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: vi.fn(() => ({
    data: [{ id: "ct-1", isOnline: true }],
    isLoading: false,
  })),
}));

vi.mock("@/hooks/queries/use-github-integration", () => ({
  useGitHubIntegrationStatus: vi.fn(() => ({
    data: { connected: false },
    isLoading: false,
  })),
  useGitHubRepositories: vi.fn(() => ({
    data: [],
    isLoading: false,
  })),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import type { AgentSummary } from "@repo/api/src/types/agent";
import { AgentsTable } from "@/app/(authenticated)/agents/components/agents-table";
import { useAgents } from "@/hooks/queries/use-agents";

const GENERATE_AGENTS_RE = /Generate Agents/i;
const CREATE_AGENT_MANUALLY_RE = /Create Agent Manually/i;
const CREATE_AGENT_RE = /Create Agent/i;

function makeAgent(overrides?: Partial<AgentSummary>): AgentSummary {
  return {
    id: "agent-001",
    name: "Frontend Architect",
    slug: "frontend-architect",
    role: "frontend-architect",
    description: "Specializes in React/Next.js",
    enabled: true,
    sourceRepo: "closedloop-ai/symphony-alpha",
    currentVersion: 3,
    createdAt: new Date("2026-04-01"),
    updatedAt: new Date("2026-04-20"),
    ...overrides,
  };
}

describe("AgentsTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when org has 0 agents", () => {
    vi.mocked(useAgents).mockReturnValue({
      data: { agents: [], total: 0 },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useAgents>);

    render(<AgentsTable />);

    expect(screen.getByText("No agents yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Generate agents from your repositories to get started, or create one manually."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: GENERATE_AGENTS_RE })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: CREATE_AGENT_MANUALLY_RE })
    ).toBeInTheDocument();
  });

  it("renders loading spinner while data is loading", () => {
    vi.mocked(useAgents).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as unknown as ReturnType<typeof useAgents>);

    const { container } = render(<AgentsTable />);
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("renders error state when fetch fails", () => {
    vi.mocked(useAgents).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Network error"),
    } as unknown as ReturnType<typeof useAgents>);

    render(<AgentsTable />);
    expect(screen.getByText("Network error")).toBeInTheDocument();
  });

  it("renders agent table with correct columns when agents exist", () => {
    vi.mocked(useAgents).mockReturnValue({
      data: {
        agents: [makeAgent()],
        total: 1,
      },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useAgents>);

    render(<AgentsTable />);

    expect(screen.getByText("Frontend Architect")).toBeInTheDocument();
    expect(screen.getByText("frontend-architect")).toBeInTheDocument();
    expect(
      screen.getByText("closedloop-ai/symphony-alpha")
    ).toBeInTheDocument();
    expect(screen.getByText("v3")).toBeInTheDocument();
  });

  it("renders Generate Agents and Create Agent buttons in header", () => {
    vi.mocked(useAgents).mockReturnValue({
      data: {
        agents: [makeAgent()],
        total: 1,
      },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useAgents>);

    render(<AgentsTable />);

    expect(
      screen.getByRole("button", { name: GENERATE_AGENTS_RE })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: CREATE_AGENT_RE })
    ).toBeInTheDocument();
  });

  it("shows 'Manual' as source when sourceRepo is null", () => {
    vi.mocked(useAgents).mockReturnValue({
      data: {
        agents: [makeAgent({ sourceRepo: null })],
        total: 1,
      },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useAgents>);

    render(<AgentsTable />);

    expect(screen.getByText("Manual")).toBeInTheDocument();
  });

  it("navigates to agent detail when row is clicked", () => {
    vi.mocked(useAgents).mockReturnValue({
      data: {
        agents: [makeAgent()],
        total: 1,
      },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useAgents>);

    render(<AgentsTable />);

    fireEvent.click(screen.getByText("Frontend Architect"));

    expect(mockPush).toHaveBeenCalledWith("/agents/frontend-architect");
  });

  it("renders page title and subtitle", () => {
    vi.mocked(useAgents).mockReturnValue({
      data: {
        agents: [makeAgent()],
        total: 1,
      },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useAgents>);

    render(<AgentsTable />);

    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(
      screen.getByText("Manage AI agents generated for your organization")
    ).toBeInTheDocument();
  });
});
