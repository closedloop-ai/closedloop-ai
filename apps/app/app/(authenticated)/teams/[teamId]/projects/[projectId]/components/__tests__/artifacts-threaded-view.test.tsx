import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createMockArtifact,
  createMockPullRequest,
} from "@/__tests__/fixtures/artifacts";
import { ArtifactsThreadedView } from "../artifacts-threaded-view";

// Mock dependencies
const mockRouterPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockRouterPush,
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/delete-confirmation-dialog", () => ({
  DeleteConfirmationDialog: () => (
    <div data-testid="delete-dialog">Delete Dialog</div>
  ),
}));

vi.mock("@/components/empty-state", () => ({
  EmptyState: ({
    title,
    description,
  }: {
    title: string;
    description: string;
  }) => (
    <div data-testid="empty-state">
      <div>{title}</div>
      <div>{description}</div>
    </div>
  ),
}));

vi.mock("@/hooks/use-delete-confirmation", () => ({
  useDeleteConfirmation: () => ({
    requestDelete: vi.fn(),
    confirmDelete: vi.fn(),
    setOpen: vi.fn(),
    isOpen: false,
    isPending: false,
    itemToDelete: null,
  }),
}));

vi.mock("../artifact-type-badge", () => ({
  ArtifactTypeBadge: ({ type }: { type: string }) => (
    <div data-testid={`badge-${type}`}>{type}</div>
  ),
}));

// Mock Radix dropdown to render inline (no portal) so menu items are queryable
vi.mock("@repo/design-system/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({
    children,
    asChild,
    ...props
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => <div {...props}>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button onClick={onClick} type="button">
      {children}
    </button>
  ),
}));

vi.mock("@/components/move-artifact-dialog", () => ({
  MoveArtifactDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div data-testid="move-artifact-dialog">
        Move Artifact Dialog
        <button onClick={() => onOpenChange(false)} type="button">
          Close
        </button>
      </div>
    ) : null,
}));

// Mock for useExternalLinks hook
const mockUseExternalLinks = vi.fn();
vi.mock("@/hooks/queries/use-external-links", () => ({
  useExternalLinks: () => mockUseExternalLinks(),
}));

const ARTIFACT_NAME_PATTERN = /The PRD|The Plan|Template/;
const PLAN_LABEL_PATTERN = /Plan:/;

const createWorkstreamArtifact = (
  overrides: Partial<ArtifactWithWorkstream>
): ArtifactWithWorkstream =>
  createMockArtifact({
    ...overrides,
  }) as ArtifactWithWorkstream;
const PRD_TEXT_REGEX = /PRD/;

describe("ArtifactsThreadedView - Empty State", () => {
  beforeEach(() => {
    mockUseExternalLinks.mockReturnValue({ data: [] });
  });

  afterEach(cleanup);

  test("renders empty state when no artifacts provided", () => {
    render(
      <ArtifactsThreadedView
        artifacts={[]}
        filterText=""
        projectId="project-1"
      />
    );

    expect(screen.getByTestId("empty-state")).toBeDefined();
    expect(screen.getByText("No artifacts yet")).toBeDefined();
    expect(
      screen.getByText(
        "Artifacts will appear here as you work on this project."
      )
    ).toBeDefined();
  });
});

describe("ArtifactsThreadedView - Workstream Grouping", () => {
  beforeEach(() => {
    mockUseExternalLinks.mockReturnValue({ data: [] });
  });

  afterEach(cleanup);

  test("groups artifacts by workstream", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "PRD Alpha",
        workstreamId: "ws-1",
        workstream: {
          id: "ws-1",
          title: "Feature X",
          state: "IMPLEMENTATION_IN_PROGRESS",
        },
      }),
      createMockArtifact({
        id: "2",
        title: "Plan Alpha",
        type: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstream: {
          id: "ws-1",
          title: "Feature X",
          state: "IMPLEMENTATION_IN_PROGRESS",
        },
      }),
      createMockArtifact({
        id: "3",
        title: "PRD Beta",
        workstreamId: "ws-2",
        workstream: {
          id: "ws-2",
          title: "Feature Y",
          state: "COMPLETED",
        },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    expect(screen.getByText("Feature X")).toBeDefined();
    expect(screen.getByText("Feature Y")).toBeDefined();
  });

  test("shows artifact count per workstream", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "PRD Alpha",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Feature X", state: "INITIATED" },
      }),
      createMockArtifact({
        id: "2",
        title: "Plan Alpha",
        type: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Feature X", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    expect(screen.getByText("2 artifacts")).toBeDefined();
  });

  test("shows singular 'artifact' for single artifact groups", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "PRD Solo",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Solo Stream", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    expect(screen.getByText("1 artifact")).toBeDefined();
  });

  test("uses PRD title as title for unassigned groups", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Orphan PRD",
        workstreamId: null,
        workstream: null,
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    expect(screen.getByText("Orphan PRD")).toBeDefined();
    expect(screen.queryByText("Unassigned")).toBeNull();
  });

  test("renders separate collapsible groups for multiple unassigned PRDs in alphabetical order", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Gamma PRD",
        type: "PRD",
        workstreamId: null,
        workstream: null,
      }),
      createMockArtifact({
        id: "2",
        title: "Alpha PRD",
        type: "PRD",
        workstreamId: null,
        workstream: null,
      }),
      createMockArtifact({
        id: "3",
        title: "Beta PRD",
        type: "PRD",
        workstreamId: null,
        workstream: null,
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    // All 3 PRD titles should be visible as group headers (each unassigned PRD forms its own group)
    expect(screen.getByText("Alpha PRD")).toBeDefined();
    expect(screen.getByText("Beta PRD")).toBeDefined();
    expect(screen.getByText("Gamma PRD")).toBeDefined();

    // Groups should be alphabetically ordered
    const allGroupHeaders = screen.getAllByText(PRD_TEXT_REGEX);
    const headerTexts = allGroupHeaders.map((el) => el.textContent);
    const sortedHeaderTexts = [...headerTexts].sort();
    expect(headerTexts).toEqual(sortedHeaderTexts);

    // No preview URL applies since workstreamId is null
    expect(screen.queryByText("Preview")).toBeNull();
  });

  test("falls back to 'Unassigned' when no PRD in group", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Template",
        type: "TEMPLATE",
        workstreamId: null,
        workstream: null,
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    expect(screen.getByText("Unassigned")).toBeDefined();
  });

  test("sorts artifacts within group: PRD, plan, template", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Template",
        type: "TEMPLATE",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
      createMockArtifact({
        id: "2",
        title: "The PRD",
        type: "PRD",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
      createMockArtifact({
        id: "3",
        title: "The Plan",
        type: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    const names = screen.getAllByText(ARTIFACT_NAME_PATTERN);
    expect(names[0].textContent).toBe("The PRD");
    expect(names[1].textContent).toBe("The Plan");
    expect(names[2].textContent).toBe("Template");
  });

  // T-2.1: WorkstreamStateBadge renders "In Progress" for IMPLEMENTATION_IN_PROGRESS state
  test("shows workstream state badge with 'In Progress' label for IMPLEMENTATION_IN_PROGRESS", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "PRD Alpha",
        workstreamId: "ws-1",
        workstream: {
          id: "ws-1",
          title: "Feature X",
          state: "IMPLEMENTATION_IN_PROGRESS",
        },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    expect(screen.getByText("In Progress")).toBeDefined();
  });

  test("artifacts sharing the same workstreamId are grouped together with no regression", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "PRD Shared",
        type: "PRD",
        workstreamId: "ws-shared",
        workstream: {
          id: "ws-shared",
          title: "Shared Stream",
          state: "INITIATED",
        },
      }),
      createMockArtifact({
        id: "2",
        title: "Plan Shared",
        type: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-shared",
        workstream: {
          id: "ws-shared",
          title: "Shared Stream",
          state: "INITIATED",
        },
      }),
      createMockArtifact({
        id: "3",
        title: "Unassigned PRD",
        type: "PRD",
        workstreamId: null,
        workstream: null,
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    // Only 2 collapsible groups should render: one for ws-shared, one for the unassigned artifact
    const groups = document.querySelectorAll(".rounded-lg.border");
    expect(groups.length).toBe(2);

    // The shared workstream group header must be visible
    expect(screen.getByText("Shared Stream")).toBeDefined();

    // The shared workstream group must show 2 artifacts
    expect(screen.getByText("2 artifacts")).toBeDefined();
  });
});

describe("ArtifactsThreadedView - Collapsible Behavior", () => {
  beforeEach(() => {
    mockUseExternalLinks.mockReturnValue({ data: [] });
  });

  afterEach(cleanup);

  test("sections are collapsed by default", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "PRD Alpha",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Feature X", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    // The trigger should exist but content should be collapsed
    const trigger = screen.getByText("Feature X").closest("button");
    expect(trigger).toBeDefined();
    expect(trigger?.dataset.state).toBe("closed");
  });

  test("clicking a section expands it to show artifacts", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "PRD Alpha",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Feature X", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("Feature X").closest("button");
    expect(trigger).not.toBeNull();

    fireEvent.click(trigger!);

    expect(screen.getByText("PRD Alpha")).toBeDefined();
  });
});

describe("ArtifactsThreadedView - Artifact Display", () => {
  beforeEach(() => {
    mockUseExternalLinks.mockReturnValue({ data: [] });
  });

  afterEach(cleanup);

  test("renders artifact with type badge and status", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Full Artifact",
        type: "IMPLEMENTATION_PLAN",
        status: "APPROVED",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Test WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    // Expand the section
    const trigger = screen.getByText("Test WS").closest("button");
    fireEvent.click(trigger!);

    expect(screen.getByText("Full Artifact")).toBeDefined();
    expect(screen.getByTestId("badge-IMPLEMENTATION_PLAN")).toBeDefined();
    expect(screen.getByText("Approved")).toBeDefined();
  });

  test("renders correct badges for each type", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "A PRD",
        type: "PRD",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
      createMockArtifact({
        id: "2",
        title: "A Plan",
        type: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    expect(screen.getByTestId("badge-PRD")).toBeDefined();
    expect(screen.getByTestId("badge-IMPLEMENTATION_PLAN")).toBeDefined();
  });
});

describe("ArtifactsThreadedView - Links", () => {
  beforeEach(() => {
    mockUseExternalLinks.mockReturnValue({ data: [] });
  });

  afterEach(cleanup);

  test("renders internal link for PRD artifact", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Product Requirements",
        type: "PRD",
        slug: "product-requirements",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    const internalLink = document.querySelector('a:not([target="_blank"])');
    expect(internalLink).not.toBeNull();
    expect(internalLink?.getAttribute("href")).toBe(
      "/prds/product-requirements"
    );
  });
});

describe("ArtifactsThreadedView - Navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseExternalLinks.mockReturnValue({ data: [] });
  });

  afterEach(cleanup);

  test("navigable artifacts have cursor-pointer class", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Product Requirements",
        type: "PRD",
        slug: "product-requirements",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    const row = screen
      .getByText("Product Requirements")
      .closest("div[role='button']");
    expect(row).not.toBeNull();
    expect(row?.className).toContain("cursor-pointer");
  });

  test("non-navigable artifacts do not have cursor-pointer", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Template",
        type: "TEMPLATE",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    const row = screen.getByText("Template").closest("div.flex");
    expect(row?.className).not.toContain("cursor-pointer");
  });
});

describe("ArtifactsThreadedView - Generation Status Indicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseExternalLinks.mockReturnValue({ data: [] });
  });

  afterEach(cleanup);

  test("renders generation status indicator for artifact with active status", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Generating Artifact",
        type: "PRD",
        workstreamId: "ws-1",
        workstream: {
          id: "ws-1",
          title: "Active Workstream",
          state: "IMPLEMENTATION_IN_PROGRESS",
        },
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

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("Active Workstream").closest("button");
    fireEvent.click(trigger!);

    expect(
      screen.getByText("Executing plan and creating PR...")
    ).toBeInTheDocument();
  });

  test("does not render indicator when status is NONE", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Artifact",
        type: "PRD",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
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

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    // Indicator component should render nothing for NONE status
    expect(screen.queryByText("Waiting to start...")).not.toBeInTheDocument();
  });

  test("does not render indicator when generationStatus is undefined", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Artifact",
        type: "PRD",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
        generationStatus: undefined,
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    expect(screen.queryByText("Waiting to start...")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Executing plan and creating PR...")
    ).not.toBeInTheDocument();
  });

  test("status transitions from PENDING to SUCCESS", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Transitioning Artifact",
        type: "PRD",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
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

    const { rerender } = render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    // Initially shows PENDING state
    expect(screen.getByText("Waiting to start...")).toBeInTheDocument();

    // Update to SUCCESS state
    const updatedArtifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Transitioning Artifact",
        type: "PRD",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
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
      <ArtifactsThreadedView
        artifacts={updatedArtifacts}
        filterText=""
        projectId="project-1"
      />
    );

    // SUCCESS state shows green checkmark, no message
    expect(screen.queryByText("Waiting to start...")).not.toBeInTheDocument();
    const container = screen.getByText("Transitioning Artifact").closest("div");
    expect(container?.querySelector(".text-green-600")).toBeInTheDocument();
  });
});

// T-3.1, T-3.2: PR state badge tests for IMPLEMENTATION_PLAN artifacts
describe("ArtifactsThreadedView - PR State Badge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseExternalLinks.mockReturnValue({ data: [] });
  });

  afterEach(cleanup);

  test("renders OPEN PR state badge for IMPLEMENTATION_PLAN with open pull request", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "My Plan",
        type: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Feature WS", state: "INITIATED" },
        pullRequest: createMockPullRequest({ state: "OPEN" }),
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("Feature WS").closest("button");
    fireEvent.click(trigger!);

    expect(screen.getByText("OPEN")).toBeInTheDocument();
  });

  test("renders MERGED PR state badge for IMPLEMENTATION_PLAN with merged pull request", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "My Plan",
        type: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Feature WS", state: "INITIATED" },
        pullRequest: createMockPullRequest({ state: "MERGED" }),
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("Feature WS").closest("button");
    fireEvent.click(trigger!);

    expect(screen.getByText("MERGED")).toBeInTheDocument();
  });

  test("does not render PR state badge when pullRequest is null", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "My Plan",
        type: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Feature WS", state: "INITIATED" },
        pullRequest: null,
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("Feature WS").closest("button");
    fireEvent.click(trigger!);

    expect(screen.queryByText("OPEN")).not.toBeInTheDocument();
    expect(screen.queryByText("MERGED")).not.toBeInTheDocument();
    expect(screen.queryByText("CLOSED")).not.toBeInTheDocument();
  });
});

// T-3.3: Review decision badge tests
describe("ArtifactsThreadedView - Review Decision Badge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseExternalLinks.mockReturnValue({ data: [] });
  });

  afterEach(cleanup);

  test("renders APPROVED review decision badge", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "Approved Plan",
        type: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
        pullRequest: createMockPullRequest({
          state: "OPEN",
          reviewDecision: "APPROVED",
        }),
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    expect(screen.getByText("APPROVED")).toBeInTheDocument();
  });

  test("renders CHANGES_REQUESTED review decision badge", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "Changes Needed Plan",
        type: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
        pullRequest: createMockPullRequest({
          state: "OPEN",
          reviewDecision: "CHANGES_REQUESTED",
        }),
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    expect(screen.getByText("CHANGES_REQUESTED")).toBeInTheDocument();
  });

  test("does not render review decision badge for COMMENTED review decision", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "Commented Plan",
        type: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
        pullRequest: createMockPullRequest({
          state: "OPEN",
          reviewDecision: "COMMENTED",
        }),
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    expect(screen.queryByText("COMMENTED")).not.toBeInTheDocument();
  });

  test("does not render review decision badge when reviewDecision is null", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "No Review Plan",
        type: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
        pullRequest: createMockPullRequest({
          state: "OPEN",
          reviewDecision: null,
        }),
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    expect(screen.queryByText("APPROVED")).not.toBeInTheDocument();
    expect(screen.queryByText("CHANGES_REQUESTED")).not.toBeInTheDocument();
  });
});

// T-4.1: Sibling plan indicator tests for PRD rows
describe("ArtifactsThreadedView - Sibling Plan Indicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseExternalLinks.mockReturnValue({ data: [] });
  });

  afterEach(cleanup);

  test("PRD row shows sibling plan status when an IMPLEMENTATION_PLAN exists in the same group", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "My PRD",
        type: "PRD",
        status: "APPROVED",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
      createWorkstreamArtifact({
        id: "2",
        title: "My Plan",
        type: "IMPLEMENTATION_PLAN",
        status: "DRAFT",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    // PRD row should show the sibling plan's status
    expect(screen.getByText("Plan: Draft")).toBeInTheDocument();
  });

  test("PRD row does not show sibling plan indicator when no IMPLEMENTATION_PLAN exists", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "Solo PRD",
        type: "PRD",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    expect(screen.queryByText(PLAN_LABEL_PATTERN)).not.toBeInTheDocument();
  });

  test("IMPLEMENTATION_PLAN row does not show sibling plan indicator", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "My PRD",
        type: "PRD",
        status: "APPROVED",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
      createWorkstreamArtifact({
        id: "2",
        title: "My Plan",
        type: "IMPLEMENTATION_PLAN",
        status: "REVIEW",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    // There should be exactly one "Plan: ..." indicator (on the PRD row, not on the plan row)
    const planIndicators = screen.getAllByText(PLAN_LABEL_PATTERN);
    expect(planIndicators).toHaveLength(1);
  });
});

// T-5.1: Preview deployment state badge in WorkstreamSection header
describe("ArtifactsThreadedView - Preview Deployment State Badge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  test("renders deployment state badge in header when preview link has READY state metadata", () => {
    mockUseExternalLinks.mockReturnValue({
      data: [
        {
          id: "link-1",
          workstreamId: "ws-1",
          externalUrl: "https://preview.example.com/feature-x",
          type: "PREVIEW_DEPLOYMENT",
          metadata: {
            state: "READY",
            environment: "preview",
            ref: null,
            sha: null,
          },
        },
      ],
    });

    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "PRD Alpha",
        workstreamId: "ws-1",
        workstream: {
          id: "ws-1",
          title: "Feature X",
          state: "IMPLEMENTATION_IN_PROGRESS",
        },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    // Deployment state badge (uppercased "READY") should appear in the section header
    expect(screen.getByText("READY")).toBeInTheDocument();
  });

  test("renders deployment state badge with BUILDING state", () => {
    mockUseExternalLinks.mockReturnValue({
      data: [
        {
          id: "link-1",
          workstreamId: "ws-1",
          externalUrl: "https://preview.example.com/feature-x",
          type: "PREVIEW_DEPLOYMENT",
          metadata: {
            state: "BUILDING",
            environment: "preview",
            ref: null,
            sha: null,
          },
        },
      ],
    });

    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "PRD Alpha",
        workstreamId: "ws-1",
        workstream: {
          id: "ws-1",
          title: "Feature X",
          state: "INITIATED",
        },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    expect(screen.getByText("BUILDING")).toBeInTheDocument();
  });

  test("does not render deployment state badge when metadata has no state", () => {
    mockUseExternalLinks.mockReturnValue({
      data: [
        {
          id: "link-1",
          workstreamId: "ws-1",
          externalUrl: "https://preview.example.com/feature-x",
          type: "PREVIEW_DEPLOYMENT",
          metadata: null,
        },
      ],
    });

    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "PRD Alpha",
        workstreamId: "ws-1",
        workstream: {
          id: "ws-1",
          title: "Feature X",
          state: "INITIATED",
        },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    expect(screen.queryByText("READY")).not.toBeInTheDocument();
    expect(screen.queryByText("BUILDING")).not.toBeInTheDocument();
  });
});

describe("ArtifactsThreadedView - Preview Links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  test("renders PreviewLink when preview URL is available for workstream", () => {
    // Mock external links data with a preview URL (metadata included)
    mockUseExternalLinks.mockReturnValue({
      data: [
        {
          id: "link-1",
          workstreamId: "ws-1",
          externalUrl: "https://preview.example.com/feature-x",
          type: "PREVIEW_DEPLOYMENT",
          metadata: null,
        },
      ],
    });

    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "PRD Alpha",
        workstreamId: "ws-1",
        workstream: {
          id: "ws-1",
          title: "Feature X",
          state: "IMPLEMENTATION_IN_PROGRESS",
        },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    // PreviewLink should be rendered in the trigger section
    const previewLink = screen.getByText("Preview");
    expect(previewLink).toBeInTheDocument();
    expect(previewLink.closest("a")).toHaveAttribute(
      "href",
      "https://preview.example.com/feature-x"
    );
    expect(previewLink.closest("a")).toHaveAttribute("target", "_blank");
  });

  test("does not render PreviewLink when no preview URL is available", () => {
    // Mock external links with empty data
    mockUseExternalLinks.mockReturnValue({
      data: [],
    });

    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "PRD Beta",
        workstreamId: "ws-2",
        workstream: {
          id: "ws-2",
          title: "Feature Y",
          state: "INITIATED",
        },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    // PreviewLink should not be rendered
    expect(screen.queryByText("Preview")).not.toBeInTheDocument();
  });
});

describe("ArtifactsThreadedView - Move Artifact", () => {
  beforeEach(() => {
    mockUseExternalLinks.mockReturnValue({ data: [] });
  });

  afterEach(cleanup);

  test("renders 'Move to project' menu item in dropdown", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Test Artifact",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    // Find and click the dropdown menu trigger
    const dropdownTrigger = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(dropdownTrigger);

    // Verify 'Move to project' menu item is rendered
    expect(screen.getByText("Move to project")).toBeInTheDocument();
  });

  test("clicking 'Move to project' opens MoveArtifactDialog", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Test Artifact",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    // Open dropdown menu
    const dropdownTrigger = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(dropdownTrigger);

    // Click 'Move to project'
    const moveMenuItem = screen.getByText("Move to project");
    fireEvent.click(moveMenuItem);

    // Verify dialog opens
    expect(screen.getByTestId("move-artifact-dialog")).toBeInTheDocument();
    expect(screen.getByText("Move Artifact Dialog")).toBeInTheDocument();
  });

  test("closing MoveArtifactDialog hides it", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Test Artifact",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    // Open dropdown and click move
    const dropdownTrigger = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(dropdownTrigger);
    const moveMenuItem = screen.getByText("Move to project");
    fireEvent.click(moveMenuItem);

    // Verify dialog is open
    expect(screen.getByTestId("move-artifact-dialog")).toBeInTheDocument();

    // Close dialog
    const closeButton = screen.getByRole("button", { name: "Close" });
    fireEvent.click(closeButton);

    // Verify dialog is closed
    expect(
      screen.queryByTestId("move-artifact-dialog")
    ).not.toBeInTheDocument();
  });
});

describe("ArtifactsThreadedView - Filter", () => {
  beforeEach(() => {
    mockUseExternalLinks.mockReturnValue({ data: [] });
  });

  afterEach(cleanup);

  test("renders all groups when filterText is empty", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "PRD Group A",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Feature A", state: "INITIATED" },
      }),
      createMockArtifact({
        id: "2",
        title: "PRD Group B",
        workstreamId: "ws-2",
        workstream: { id: "ws-2", title: "Feature B", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText=""
        projectId="project-1"
      />
    );

    expect(screen.getByText("Feature A")).toBeInTheDocument();
    expect(screen.getByText("Feature B")).toBeInTheDocument();
  });

  test("filters groups by artifact title", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Login PRD",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Login Feature", state: "INITIATED" },
      }),
      createMockArtifact({
        id: "2",
        title: "Dashboard PRD",
        workstreamId: "ws-2",
        workstream: {
          id: "ws-2",
          title: "Dashboard Feature",
          state: "INITIATED",
        },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText="login prd"
        projectId="project-1"
      />
    );

    expect(screen.getByText("Login Feature")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard Feature")).not.toBeInTheDocument();
  });

  test("filters groups by snippet", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Auth PRD",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Auth Group", state: "INITIATED" },
        snippet: "authentication module",
      }),
      createMockArtifact({
        id: "2",
        title: "Other PRD",
        workstreamId: "ws-2",
        workstream: { id: "ws-2", title: "Other Group", state: "INITIATED" },
        snippet: null,
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText="authentication"
        projectId="project-1"
      />
    );

    expect(screen.getByText("Auth Group")).toBeInTheDocument();
    expect(screen.queryByText("Other Group")).not.toBeInTheDocument();
  });

  test("filters groups by workstream title", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Checkout PRD",
        workstreamId: "ws-1",
        workstream: {
          id: "ws-1",
          title: "Checkout Feature",
          state: "INITIATED",
        },
      }),
      createMockArtifact({
        id: "2",
        title: "Other PRD",
        workstreamId: "ws-2",
        workstream: { id: "ws-2", title: "Other Feature", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText="checkout"
        projectId="project-1"
      />
    );

    expect(screen.getByText("Checkout Feature")).toBeInTheDocument();
    expect(screen.queryByText("Other Feature")).not.toBeInTheDocument();
  });

  test("shows no-results EmptyState when filter matches nothing", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Some PRD",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Some Feature", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText="zzznomatch"
        projectId="project-1"
      />
    );

    expect(screen.getByText("No matching artifacts")).toBeInTheDocument();
    expect(screen.queryByText("No artifacts yet")).not.toBeInTheDocument();
  });

  test("group with partial match retains all artifacts in the group", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Matching PRD",
        type: "PRD",
        workstreamId: "ws-1",
        workstream: {
          id: "ws-1",
          title: "Shared Workstream",
          state: "INITIATED",
        },
      }),
      createMockArtifact({
        id: "2",
        title: "Non-matching Plan",
        type: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstream: {
          id: "ws-1",
          title: "Shared Workstream",
          state: "INITIATED",
        },
      }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText="matching prd"
        projectId="project-1"
      />
    );

    const trigger = screen.getByText("Shared Workstream").closest("button");
    fireEvent.click(trigger!);

    // Both artifacts remain visible because the whole group is retained
    expect(screen.getByText("Matching PRD")).toBeInTheDocument();
    expect(screen.getByText("Non-matching Plan")).toBeInTheDocument();
  });

  test("re-render with changed filterText updates filtered groups", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createMockArtifact({
        id: "1",
        title: "Alpha PRD",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Alpha Group", state: "INITIATED" },
      }),
      createMockArtifact({
        id: "2",
        title: "Beta PRD",
        workstreamId: "ws-2",
        workstream: { id: "ws-2", title: "Beta Group", state: "INITIATED" },
      }),
    ];

    const { rerender } = render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText="alpha"
        projectId="project-1"
      />
    );

    expect(screen.getByText("Alpha Group")).toBeInTheDocument();
    expect(screen.queryByText("Beta Group")).not.toBeInTheDocument();

    rerender(
      <ArtifactsThreadedView
        artifacts={artifacts}
        filterText="beta"
        projectId="project-1"
      />
    );

    expect(screen.queryByText("Alpha Group")).not.toBeInTheDocument();
    expect(screen.getByText("Beta Group")).toBeInTheDocument();
  });
});
