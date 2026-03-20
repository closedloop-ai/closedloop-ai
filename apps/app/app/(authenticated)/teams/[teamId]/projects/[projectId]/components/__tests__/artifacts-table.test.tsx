import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockArtifact } from "@/__tests__/fixtures/artifacts";
import { ArtifactsTable } from "../artifacts-table";

// Mock next/navigation
const mockUseRouter = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => mockUseRouter(),
  usePathname: () => "/teams/test-team/projects/test-project",
  useSearchParams: () => new URLSearchParams(),
}));

// Mock delete confirmation hook
vi.mock("@/hooks/use-delete-confirmation", () => ({
  useDeleteConfirmation: () => ({
    isOpen: false,
    itemToDelete: null,
    confirmDelete: vi.fn(),
    cancelDelete: vi.fn(),
    requestDelete: vi.fn(),
    setOpen: vi.fn(),
    isPending: false,
  }),
}));

// Mock @dnd-kit/core
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// Mock @dnd-kit/sortable
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  verticalListSortingStrategy: {},
  arrayMove: vi.fn((arr, from, to) => {
    const result = [...arr];
    const [removed] = result.splice(from, 1);
    result.splice(to, 0, removed);
    return result;
  }),
  useSortable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  })),
}));

// Mock DropdownMenu components (needed to avoid rendering issues)
vi.mock("@repo/design-system/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({ children, onClick }: any) => (
    <button onClick={onClick} type="button">
      {children}
    </button>
  ),
}));

// Mock useApiClient
const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  patch: vi.fn(),
};

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

// Mock useMergeArtifacts
const mockMutateAsync = vi.fn();
vi.mock("@/hooks/queries/use-artifacts", () => ({
  useMergeArtifacts: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
}));

// Mock useProjectJudgeScores
vi.mock("@/hooks/queries/use-judges", () => ({
  useProjectJudgeScores: () => ({
    data: {
      "prd-artifact-1": {
        [EvaluationReportType.Plan]: null,
        [EvaluationReportType.Prd]: [
          {
            judgeScoreId: "js-1",
            caseId: "quality",
            metricName: "quality",
            score: 0.9,
            threshold: 0.8,
            justification: "Good",
            finalStatus: "PASSED",
            promptName: null,
          },
        ],
        [EvaluationReportType.Code]: null,
      },
    },
  }),
}));

// Mock sonner toast
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Mock Tooltip components so TooltipContent renders inline (not in a Portal)
// This lets us assert on the tooltip text without hover simulation.
vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({
    children,
  }: {
    children: ReactNode;
    asChild?: boolean;
  }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

const GENERATING_PLAN_REGEX = /Generating\.\.\. - View workflow/i;
const EXECUTING_PLAN_REGEX =
  /Executing plan and creating PR\.\.\. - View workflow/i;
const SELECT_ALL_IN_DOCUMENTS_REGEX = /select all in documents/i;
const SELECTED_REGEX = /selected/;

function createMockProjectArtifact(
  overrides?: Partial<ArtifactWithWorkstream>
): ArtifactWithWorkstream {
  return createMockArtifact(overrides) as ArtifactWithWorkstream;
}

// Test wrapper with QueryClientProvider
function createTestWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });

  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderWithProviders(ui: ReactNode) {
  const Wrapper = createTestWrapper();
  return render(<Wrapper>{ui}</Wrapper>);
}

describe("ArtifactsTable - Artifact Display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRouter.mockReturnValue({ push: vi.fn() });
  });

  afterEach(() => {
    cleanup();
  });

  test("displays artifact with title", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        title: "PRD with feature",
        type: "PRD",
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText=""
        projectId="test-project-id"
      />
    );

    expect(screen.getByText("PRD with feature")).toBeInTheDocument();
  });

  test("displays multiple artifacts", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        title: "PRD Document",
        type: "PRD",
      }),
      createMockProjectArtifact({
        id: "artifact-2",
        title: "My Feature Plan",
        type: "IMPLEMENTATION_PLAN",
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText=""
        projectId="test-project-id"
      />
    );

    expect(screen.getByText("PRD Document")).toBeInTheDocument();
    expect(screen.getByText("My Feature Plan")).toBeInTheDocument();
  });

  test("renders empty state when no artifacts provided", () => {
    renderWithProviders(
      <ArtifactsTable
        artifacts={[]}
        filterText=""
        projectId="test-project-id"
      />
    );

    expect(screen.getByText("No artifacts yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Artifacts will appear here as you work on this project."
      )
    ).toBeInTheDocument();
  });
});

describe("ArtifactsTable - Generation Status Display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRouter.mockReturnValue({ push: vi.fn() });
  });

  afterEach(() => {
    cleanup();
  });

  test("renders generation status indicator for artifact with active status", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        title: "Generating Artifact",
        type: "PRD",
        generationStatus: {
          status: "RUNNING",
          command: "execute",
          htmlUrl: "https://github.com/org/repo/actions/runs/123",
          startedAt: new Date(),
          completedAt: null,
          correlationId: "test-correlation-id",
        },
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText=""
        projectId="test-project-id"
      />
    );

    expect(
      screen.getByText("Executing plan and creating PR...")
    ).toBeInTheDocument();
  });

  test("does not render indicator when status is NONE", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        title: "Artifact",
        type: "PRD",
        generationStatus: {
          status: "NONE",
          command: null,
          htmlUrl: null,
          startedAt: null,
          completedAt: null,
          correlationId: null,
        },
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText=""
        projectId="test-project-id"
      />
    );

    // Indicator component should render nothing for NONE status
    expect(screen.queryByText("Waiting to start...")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Queued for execution...")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Queued for generation...")
    ).not.toBeInTheDocument();
  });

  test("does not render indicator when generationStatus is undefined", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        title: "Artifact",
        type: "PRD",
        generationStatus: undefined,
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText=""
        projectId="test-project-id"
      />
    );

    expect(screen.queryByText("Waiting to start...")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Executing plan and creating PR...")
    ).not.toBeInTheDocument();
  });

  test("renders clickable link when htmlUrl is provided", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        title: "Running Artifact",
        type: "IMPLEMENTATION_PLAN",
        generationStatus: {
          status: "RUNNING",
          command: "plan",
          htmlUrl: "https://github.com/org/repo/actions/runs/456",
          startedAt: new Date(),
          completedAt: null,
          correlationId: "test-id",
        },
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText=""
        projectId="test-project-id"
      />
    );

    const link = screen.getByRole("link", {
      name: GENERATING_PLAN_REGEX,
    });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/org/repo/actions/runs/456"
    );
    expect(link).toHaveAttribute("target", "_blank");
  });

  test("status transitions from PENDING to SUCCESS", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        title: "Transitioning Artifact",
        type: "PRD",
        generationStatus: {
          status: "PENDING",
          command: "execute",
          htmlUrl: null,
          startedAt: null,
          completedAt: null,
          correlationId: "test-id",
        },
      }),
    ];

    const Wrapper = createTestWrapper();
    const { rerender } = render(
      <Wrapper>
        <ArtifactsTable
          artifacts={artifacts}
          filterText=""
          projectId="test-project-id"
        />
      </Wrapper>
    );

    // Initially shows PENDING state
    expect(screen.getByText("Waiting to start...")).toBeInTheDocument();

    // Update to SUCCESS state
    const updatedArtifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        title: "Transitioning Artifact",
        type: "PRD",
        generationStatus: {
          status: "SUCCESS",
          command: "execute",
          htmlUrl: "https://github.com/org/repo/actions/runs/789",
          startedAt: new Date(),
          completedAt: new Date(),
          correlationId: "test-id",
        },
      }),
    ];

    rerender(
      <Wrapper>
        <ArtifactsTable
          artifacts={updatedArtifacts}
          filterText=""
          projectId="test-project-id"
        />
      </Wrapper>
    );

    // SUCCESS state shows green checkmark, no message
    expect(screen.queryByText("Waiting to start...")).not.toBeInTheDocument();
    const container = screen.getByText("Transitioning Artifact").closest("td");
    expect(container?.querySelector(".text-green-600")).toBeInTheDocument();
  });

  test("screen reader announcements via aria-label", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        title: "Accessible Artifact",
        type: "PRD",
        generationStatus: {
          status: "RUNNING",
          command: "execute",
          htmlUrl: "https://github.com/org/repo/actions/runs/999",
          startedAt: new Date(),
          completedAt: null,
          correlationId: "test-id",
        },
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText=""
        projectId="test-project-id"
      />
    );

    const link = screen.getByRole("link", {
      name: EXECUTING_PLAN_REGEX,
    });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("aria-label");
  });
});

describe("ArtifactsTable - Filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRouter.mockReturnValue({ push: vi.fn() });
  });

  afterEach(() => {
    cleanup();
  });

  test("renders all artifacts when filterText is empty", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({ id: "a1", title: "Login Flow", type: "PRD" }),
      createMockProjectArtifact({
        id: "a2",
        title: "Dashboard UI",
        type: "IMPLEMENTATION_PLAN",
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText=""
        projectId="test-project-id"
      />
    );

    expect(screen.getByText("Login Flow")).toBeInTheDocument();
    expect(screen.getByText("Dashboard UI")).toBeInTheDocument();
  });

  test("filters by artifact title", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({ id: "a1", title: "Login Flow", type: "PRD" }),
      createMockProjectArtifact({
        id: "a2",
        title: "Dashboard UI",
        type: "PRD",
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText="login"
        projectId="test-project-id"
      />
    );

    expect(screen.getByText("Login Flow")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard UI")).not.toBeInTheDocument();
  });

  test("filters by snippet content", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "a1",
        title: "Artifact With Snippet",
        type: "PRD",
        snippet: "payment gateway integration",
      }),
      createMockProjectArtifact({
        id: "a2",
        title: "Artifact Without Snippet",
        type: "PRD",
        snippet: null,
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText="payment"
        projectId="test-project-id"
      />
    );

    expect(screen.getByText("Artifact With Snippet")).toBeInTheDocument();
    expect(
      screen.queryByText("Artifact Without Snippet")
    ).not.toBeInTheDocument();
  });

  test("filters by workstream title", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "a1",
        title: "PRD Alpha",
        type: "PRD",
        workstream: { id: "ws-1", title: "Feature Y", state: "INITIATED" },
      }),
      createMockProjectArtifact({
        id: "a2",
        title: "PRD Beta",
        type: "PRD",
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText="feature y"
        projectId="test-project-id"
      />
    );

    expect(screen.getByText("PRD Alpha")).toBeInTheDocument();
    expect(screen.queryByText("PRD Beta")).not.toBeInTheDocument();
  });

  test("shows no-results EmptyState when filter matches nothing", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "a1",
        title: "Some Artifact",
        type: "PRD",
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText="zzznomatch"
        projectId="test-project-id"
      />
    );

    expect(screen.getByText("No matching artifacts")).toBeInTheDocument();
    expect(screen.queryByText("No artifacts yet")).not.toBeInTheDocument();
  });

  test("re-render with changed filterText updates filtered results", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({ id: "a1", title: "Login Flow", type: "PRD" }),
      createMockProjectArtifact({
        id: "a2",
        title: "Dashboard UI",
        type: "PRD",
      }),
    ];

    const Wrapper = createTestWrapper();
    const { rerender } = render(
      <Wrapper>
        <ArtifactsTable
          artifacts={artifacts}
          filterText="login"
          projectId="test-project-id"
        />
      </Wrapper>
    );

    expect(screen.getByText("Login Flow")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard UI")).not.toBeInTheDocument();

    rerender(
      <Wrapper>
        <ArtifactsTable
          artifacts={artifacts}
          filterText="dashboard"
          projectId="test-project-id"
        />
      </Wrapper>
    );

    expect(screen.queryByText("Login Flow")).not.toBeInTheDocument();
    expect(screen.getByText("Dashboard UI")).toBeInTheDocument();
  });
});

describe("ArtifactsTable - Merge Selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRouter.mockReturnValue({ push: vi.fn() });
  });

  afterEach(() => {
    cleanup();
  });

  test("selecting all in section shows selection count in toolbar", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        title: "PRD Alpha",
        type: "PRD",
        projectId: "test-project-id",
      }),
      createMockProjectArtifact({
        id: "artifact-2",
        title: "PRD Beta",
        type: "PRD",
        projectId: "test-project-id",
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText=""
        projectId="test-project-id"
      />
    );

    // Toolbar should not be visible yet
    expect(screen.queryByText(SELECTED_REGEX)).not.toBeInTheDocument();

    // Click the "Select all in Documents" checkbox in section header
    const selectAllCheckbox = screen.getByRole("checkbox", {
      name: SELECT_ALL_IN_DOCUMENTS_REGEX,
    });
    fireEvent.click(selectAllCheckbox);

    // Toolbar should now show selection count
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  test("2 same-project artifacts selected enables Merge button", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        title: "PRD Alpha",
        type: "PRD",
        projectId: "test-project-id",
      }),
      createMockProjectArtifact({
        id: "artifact-2",
        title: "PRD Beta",
        type: "PRD",
        projectId: "test-project-id",
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText=""
        projectId="test-project-id"
      />
    );

    // Select all in section to get 2 same-project artifacts
    const selectAllCheckbox = screen.getByRole("checkbox", {
      name: SELECT_ALL_IN_DOCUMENTS_REGEX,
    });
    fireEvent.click(selectAllCheckbox);

    // Merge button should be enabled (not disabled)
    const mergeButton = screen.getByRole("button", { name: "Merge" });
    expect(mergeButton).not.toBeDisabled();
  });

  test("2 different-project artifacts selected disables Merge button", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        title: "PRD Alpha",
        type: "PRD",
        projectId: "project-a",
      }),
      createMockProjectArtifact({
        id: "artifact-2",
        title: "PRD Beta",
        type: "PRD",
        projectId: "project-b",
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText=""
        projectId="test-project-id"
      />
    );

    // Select all artifacts
    const selectAllCheckbox = screen.getByRole("checkbox", {
      name: SELECT_ALL_IN_DOCUMENTS_REGEX,
    });
    fireEvent.click(selectAllCheckbox);

    // Merge button should be disabled with tooltip reason
    const mergeButton = screen.getByRole("button", { name: "Merge" });
    expect(mergeButton).toBeDisabled();

    // Tooltip should explain why
    const tooltips = screen.getAllByTestId("tooltip-content");
    const mergeTooltip = tooltips.find((el) =>
      el.textContent?.includes("Both artifacts must be from the same project")
    );
    expect(mergeTooltip).toBeInTheDocument();
  });

  test("3+ artifacts selected disables Merge button", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        title: "PRD Alpha",
        type: "PRD",
        projectId: "test-project-id",
      }),
      createMockProjectArtifact({
        id: "artifact-2",
        title: "PRD Beta",
        type: "PRD",
        projectId: "test-project-id",
      }),
      createMockProjectArtifact({
        id: "artifact-3",
        title: "PRD Gamma",
        type: "PRD",
        projectId: "test-project-id",
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText=""
        projectId="test-project-id"
      />
    );

    // Select all 3 artifacts in section
    const selectAllCheckbox = screen.getByRole("checkbox", {
      name: SELECT_ALL_IN_DOCUMENTS_REGEX,
    });
    fireEvent.click(selectAllCheckbox);

    // 3 artifacts should be selected
    expect(screen.getByText("3 selected")).toBeInTheDocument();

    // Merge button should be disabled
    const mergeButton = screen.getByRole("button", { name: "Merge" });
    expect(mergeButton).toBeDisabled();

    // Tooltip should explain why
    const tooltips = screen.getAllByTestId("tooltip-content");
    const mergeTooltip = tooltips.find((el) =>
      el.textContent?.includes("Merge requires exactly 2 artifacts")
    );
    expect(mergeTooltip).toBeInTheDocument();
  });

  test("Clear Selection button removes all selections", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        title: "PRD Alpha",
        type: "PRD",
        projectId: "test-project-id",
      }),
      createMockProjectArtifact({
        id: "artifact-2",
        title: "PRD Beta",
        type: "PRD",
        projectId: "test-project-id",
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText=""
        projectId="test-project-id"
      />
    );

    // Select all in section
    const selectAllCheckbox = screen.getByRole("checkbox", {
      name: SELECT_ALL_IN_DOCUMENTS_REGEX,
    });
    fireEvent.click(selectAllCheckbox);

    // Verify selection count appears
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    // Click Clear Selection
    const clearButton = screen.getByRole("button", { name: "Clear Selection" });
    fireEvent.click(clearButton);

    // Toolbar should be gone
    expect(screen.queryByText(SELECTED_REGEX)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear Selection" })
    ).not.toBeInTheDocument();
  });
});

describe("ArtifactsTable - Judge Scores Display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRouter.mockReturnValue({ push: vi.fn() });
  });

  afterEach(() => {
    cleanup();
  });

  test("renders Judge Scores column header and score cell for PRD artifact", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockProjectArtifact({
        id: "prd-artifact-1",
        title: "Quality PRD",
        type: "PRD",
      }),
    ];

    renderWithProviders(
      <ArtifactsTable
        artifacts={artifacts}
        filterText=""
        projectId="test-project-id"
      />
    );

    // Column header for judge scores should be present
    expect(screen.getByText("Judges")).toBeInTheDocument();

    // Score cell should show the formatted percentage for score 0.9
    // (may appear in both the trigger span and tooltip content)
    const scoreElements = screen.getAllByText("90%");
    expect(scoreElements.length).toBeGreaterThan(0);
  });
});
