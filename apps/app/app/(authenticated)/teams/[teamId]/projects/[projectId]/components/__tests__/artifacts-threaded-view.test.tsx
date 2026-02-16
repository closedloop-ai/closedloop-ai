import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockArtifact } from "@/__tests__/fixtures/artifacts";
import { ArtifactsThreadedView } from "../artifacts-threaded-view";

// Mock dependencies
const mockRouterPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockRouterPush,
  }),
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

const createWorkstreamArtifact = (
  overrides: Partial<ArtifactWithWorkstream>
): ArtifactWithWorkstream =>
  createMockArtifact({
    ...overrides,
  }) as ArtifactWithWorkstream;

describe("ArtifactsThreadedView - Empty State", () => {
  beforeEach(() => {
    mockUseExternalLinks.mockReturnValue({ data: [] });
  });

  afterEach(cleanup);

  test("renders empty state when no artifacts provided", () => {
    render(<ArtifactsThreadedView artifacts={[]} projectId="project-1" />);

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
      createWorkstreamArtifact({
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
      createWorkstreamArtifact({
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
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    expect(screen.getByText("Feature X")).toBeDefined();
    expect(screen.getByText("Feature Y")).toBeDefined();
  });

  test("shows artifact count per workstream", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "PRD Alpha",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Feature X", state: "INITIATED" },
      }),
      createWorkstreamArtifact({
        id: "2",
        title: "Plan Alpha",
        type: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Feature X", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    expect(screen.getByText("2 artifacts")).toBeDefined();
  });

  test("shows singular 'artifact' for single artifact groups", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "PRD Solo",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Solo Stream", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    expect(screen.getByText("1 artifact")).toBeDefined();
  });

  test("uses PRD title as title for unassigned groups", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "Orphan PRD",
        workstreamId: null,
        workstream: null,
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    expect(screen.getByText("Orphan PRD")).toBeDefined();
    expect(screen.queryByText("Unassigned")).toBeNull();
  });

  test("falls back to 'Unassigned' when no PRD in group", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "Template",
        type: "TEMPLATE",
        workstreamId: null,
        workstream: null,
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    expect(screen.getByText("Unassigned")).toBeDefined();
  });

  test("sorts artifacts within group: PRD, plan, template", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "Template",
        type: "TEMPLATE",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
      createWorkstreamArtifact({
        id: "2",
        title: "The PRD",
        type: "PRD",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
      createWorkstreamArtifact({
        id: "3",
        title: "The Plan",
        type: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    const names = screen.getAllByText(ARTIFACT_NAME_PATTERN);
    expect(names[0].textContent).toBe("The PRD");
    expect(names[1].textContent).toBe("The Plan");
    expect(names[2].textContent).toBe("Template");
  });

  test("shows workstream state badge", () => {
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
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    expect(screen.getByText("Implementing")).toBeDefined();
  });
});

describe("ArtifactsThreadedView - Collapsible Behavior", () => {
  beforeEach(() => {
    mockUseExternalLinks.mockReturnValue({ data: [] });
  });

  afterEach(cleanup);

  test("sections are collapsed by default", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "PRD Alpha",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Feature X", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    // The trigger should exist but content should be collapsed
    const trigger = screen.getByText("Feature X").closest("button");
    expect(trigger).toBeDefined();
    expect(trigger?.dataset.state).toBe("closed");
  });

  test("clicking a section expands it to show artifacts", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "PRD Alpha",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Feature X", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
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
      createWorkstreamArtifact({
        id: "1",
        title: "Full Artifact",
        type: "IMPLEMENTATION_PLAN",
        status: "APPROVED",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "Test WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
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
      createWorkstreamArtifact({
        id: "1",
        title: "A PRD",
        type: "PRD",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
      createWorkstreamArtifact({
        id: "2",
        title: "A Plan",
        type: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
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
      createWorkstreamArtifact({
        id: "1",
        title: "Product Requirements",
        type: "PRD",
        slug: "product-requirements",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
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
      createWorkstreamArtifact({
        id: "1",
        title: "Product Requirements",
        type: "PRD",
        slug: "product-requirements",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
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
      createWorkstreamArtifact({
        id: "1",
        title: "Template",
        type: "TEMPLATE",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
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
      createWorkstreamArtifact({
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
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    const trigger = screen.getByText("Active Workstream").closest("button");
    fireEvent.click(trigger!);

    expect(
      screen.getByText("Executing plan and creating PR...")
    ).toBeInTheDocument();
  });

  test("does not render indicator when status is NONE", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
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
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    // Indicator component should render nothing for NONE status
    expect(screen.queryByText("Waiting to start...")).not.toBeInTheDocument();
  });

  test("does not render indicator when generationStatus is undefined", () => {
    const artifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
        id: "1",
        title: "Artifact",
        type: "PRD",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
        generationStatus: undefined,
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
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
      createWorkstreamArtifact({
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
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    // Initially shows PENDING state
    expect(screen.getByText("Waiting to start...")).toBeInTheDocument();

    // Update to SUCCESS state
    const updatedArtifacts: ArtifactWithWorkstream[] = [
      createWorkstreamArtifact({
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
        projectId="project-1"
      />
    );

    // SUCCESS state shows green checkmark, no message
    expect(screen.queryByText("Waiting to start...")).not.toBeInTheDocument();
    const container = screen.getByText("Transitioning Artifact").closest("div");
    expect(container?.querySelector(".text-green-600")).toBeInTheDocument();
  });
});

describe("ArtifactsThreadedView - Preview Links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  test("renders PreviewLink when preview URL is available for workstream", () => {
    // Mock external links data with a preview URL
    mockUseExternalLinks.mockReturnValue({
      data: [
        {
          id: "link-1",
          workstreamId: "ws-1",
          externalUrl: "https://preview.example.com/feature-x",
          type: "PREVIEW_DEPLOYMENT",
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
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
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
      createWorkstreamArtifact({
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
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
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
      createWorkstreamArtifact({
        id: "1",
        title: "Test Artifact",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
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
      createWorkstreamArtifact({
        id: "1",
        title: "Test Artifact",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
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
      createWorkstreamArtifact({
        id: "1",
        title: "Test Artifact",
        workstreamId: "ws-1",
        workstream: { id: "ws-1", title: "WS", state: "INITIATED" },
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
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
