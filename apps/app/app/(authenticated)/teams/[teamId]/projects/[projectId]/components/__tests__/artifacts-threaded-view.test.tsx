import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockPullRequest } from "@/__tests__/fixtures/artifacts";
import type { ProjectArtifact } from "@/types/teams";
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

vi.mock("@/components/preview-link", () => ({
  PreviewLink: ({ url }: { url?: string }) => (
    <div data-testid="preview-link">{url ? "Preview" : "n/a"}</div>
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

vi.mock("../artifact-subtype-badge", () => ({
  ArtifactSubtypeBadge: ({ subtype }: { subtype: string }) => (
    <div data-testid={`badge-${subtype}`}>{subtype}</div>
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

const ARTIFACT_NAME_PATTERN = /The PRD|The Plan|Feature Branch/;
const GENERATING_PLAN_REGEX =
  /Generating implementation plan\.\.\. - View workflow/i;
const EXECUTING_PLAN_REGEX =
  /Executing plan and creating PR\.\.\. - View workflow/i;

const createMockArtifact = (
  overrides: Partial<ProjectArtifact>
): ProjectArtifact => ({
  id: "artifact-1",
  documentSlug: "test-slug",
  name: "Test Artifact",
  subtype: "PRD",
  status: "NOT_STARTED",
  parentId: null,
  link: undefined,
  previewUrl: undefined,
  workstreamId: null,
  workstreamTitle: null,
  workstreamState: null,
  ...overrides,
});

describe("ArtifactsThreadedView - Empty State", () => {
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
  afterEach(cleanup);

  test("groups artifacts by workstream", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "PRD Alpha",
        workstreamId: "ws-1",
        workstreamTitle: "Feature X",
        workstreamState: "IMPLEMENTATION_IN_PROGRESS",
      }),
      createMockArtifact({
        id: "2",
        name: "Plan Alpha",
        subtype: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstreamTitle: "Feature X",
        workstreamState: "IMPLEMENTATION_IN_PROGRESS",
      }),
      createMockArtifact({
        id: "3",
        name: "PRD Beta",
        workstreamId: "ws-2",
        workstreamTitle: "Feature Y",
        workstreamState: "COMPLETED",
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    expect(screen.getByText("Feature X")).toBeDefined();
    expect(screen.getByText("Feature Y")).toBeDefined();
  });

  test("shows artifact count per workstream", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "PRD Alpha",
        workstreamId: "ws-1",
        workstreamTitle: "Feature X",
      }),
      createMockArtifact({
        id: "2",
        name: "Plan Alpha",
        subtype: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstreamTitle: "Feature X",
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    expect(screen.getByText("2 artifacts")).toBeDefined();
  });

  test("shows singular 'artifact' for single artifact groups", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "PRD Solo",
        workstreamId: "ws-1",
        workstreamTitle: "Solo Stream",
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    expect(screen.getByText("1 artifact")).toBeDefined();
  });

  test("uses PRD name as title for unassigned groups", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Orphan PRD",
        workstreamId: null,
        workstreamTitle: null,
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    expect(screen.getByText("Orphan PRD")).toBeDefined();
    expect(screen.queryByText("Unassigned")).toBeNull();
  });

  test("falls back to 'Unassigned' when no PRD in group", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Feature Branch",
        subtype: "BRANCH",
        workstreamId: null,
        workstreamTitle: null,
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    expect(screen.getByText("Unassigned")).toBeDefined();
  });

  test("sorts artifacts within group: PRD, plan, branch", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Feature Branch",
        subtype: "BRANCH",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
      }),
      createMockArtifact({
        id: "2",
        name: "The PRD",
        subtype: "PRD",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
      }),
      createMockArtifact({
        id: "3",
        name: "The Plan",
        subtype: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
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
    expect(names[2].textContent).toBe("Feature Branch");
  });

  test("shows workstream state badge", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "PRD Alpha",
        workstreamId: "ws-1",
        workstreamTitle: "Feature X",
        workstreamState: "IMPLEMENTATION_IN_PROGRESS",
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    expect(screen.getByText("Implementing")).toBeDefined();
  });
});

describe("ArtifactsThreadedView - Collapsible Behavior", () => {
  afterEach(cleanup);

  test("sections are collapsed by default", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "PRD Alpha",
        workstreamId: "ws-1",
        workstreamTitle: "Feature X",
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
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "PRD Alpha",
        workstreamId: "ws-1",
        workstreamTitle: "Feature X",
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
  afterEach(cleanup);

  test("renders artifact with subtype badge and status", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Full Artifact",
        subtype: "IMPLEMENTATION_PLAN",
        status: "COMPLETE",
        workstreamId: "ws-1",
        workstreamTitle: "Test WS",
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
    expect(screen.getByText("Complete")).toBeDefined();
  });

  test("renders correct badges for each subtype", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "A PRD",
        subtype: "PRD",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
      }),
      createMockArtifact({
        id: "2",
        name: "A Plan",
        subtype: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
      }),
      createMockArtifact({
        id: "3",
        name: "An Issue",
        subtype: "ISSUE",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    expect(screen.getByTestId("badge-PRD")).toBeDefined();
    expect(screen.getByTestId("badge-IMPLEMENTATION_PLAN")).toBeDefined();
    expect(screen.getByTestId("badge-ISSUE")).toBeDefined();
  });
});

describe("ArtifactsThreadedView - Links", () => {
  afterEach(cleanup);

  test("renders external link for BRANCH artifact", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Feature Branch",
        subtype: "BRANCH",
        link: "https://github.com/org/repo/tree/feature",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    const externalLink = document.querySelector('a[target="_blank"]');
    expect(externalLink).not.toBeNull();
    expect(externalLink?.getAttribute("href")).toBe(
      "https://github.com/org/repo/tree/feature"
    );
  });

  test("renders internal link for PRD artifact", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Product Requirements",
        subtype: "PRD",
        documentSlug: "product-requirements",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
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
  });

  afterEach(cleanup);

  test("navigable artifacts have cursor-pointer class", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Product Requirements",
        subtype: "PRD",
        documentSlug: "product-requirements",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
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
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Template",
        subtype: "TEMPLATE",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
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
  });

  afterEach(cleanup);

  test("renders generation status indicator for artifact with active status", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Generating Artifact",
        subtype: "PRD",
        workstreamId: "ws-1",
        workstreamTitle: "Active Workstream",
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
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Artifact",
        subtype: "PRD",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
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
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Artifact",
        subtype: "PRD",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
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

  test("renders clickable link when htmlUrl is provided", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Running Artifact",
        subtype: "IMPLEMENTATION_PLAN",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
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

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

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
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Transitioning Artifact",
        subtype: "PRD",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
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
    const updatedArtifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Transitioning Artifact",
        subtype: "PRD",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
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

  test("screen reader announcements via aria-label", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Accessible Artifact",
        subtype: "PRD",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
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

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    const link = screen.getByRole("link", {
      name: EXECUTING_PLAN_REGEX,
    });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("aria-label");
  });

  test("indicator placement does not conflict with workstream badges", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Artifact with Status",
        subtype: "PRD",
        workstreamId: "ws-1",
        workstreamTitle: "Active Workstream",
        workstreamState: "IMPLEMENTATION_IN_PROGRESS",
        generationStatus: {
          status: "RUNNING",
          command: "execute",
          htmlUrl: "https://github.com/org/repo/actions/runs/111",
          startedAt: new Date(),
          completedAt: null,
          correlationId: "test-id",
        },
      }),
    ];

    render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    // Verify workstream badge is rendered in trigger
    expect(screen.getByText("Implementing")).toBeInTheDocument();

    const trigger = screen.getByText("Active Workstream").closest("button");
    fireEvent.click(trigger!);

    // Verify both badge and indicator are rendered in artifact row
    expect(screen.getByTestId("badge-PRD")).toBeInTheDocument();
    expect(
      screen.getByText("Executing plan and creating PR...")
    ).toBeInTheDocument();

    // Verify they're both in the same artifact row (outer div has gap-3)
    const row = screen.getByText("Artifact with Status").closest(".rounded-md");
    expect(row).not.toBeNull();
    expect(row?.querySelector(".text-muted-foreground")).toBeInTheDocument(); // file type icon
    expect(screen.queryByText("OPEN")).toBeNull();
    expect(screen.queryByText("MERGED")).toBeNull();
  });
});

describe("ArtifactsThreadedView - Workstream PR Border", () => {
  afterEach(cleanup);

  test("shows blue border when workstream has OPEN PR", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Artifact 1",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
        pullRequest: createMockPullRequest({ state: "OPEN" }),
      }),
    ];

    const { container } = render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    const collapsible = container.querySelector("[data-state]");
    expect(collapsible?.className).toContain("border-l-blue-500");
  });

  test("shows green border when workstream has MERGED PR", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Artifact 1",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
        pullRequest: createMockPullRequest({ state: "MERGED" }),
      }),
    ];

    const { container } = render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    const collapsible = container.querySelector("[data-state]");
    expect(collapsible?.className).toContain("border-l-green-500");
  });

  test("prioritizes OPEN over MERGED when multiple PRs in workstream", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Artifact 1",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
        pullRequest: createMockPullRequest({ state: "OPEN" }),
      }),
      createMockArtifact({
        id: "2",
        name: "Artifact 2",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
        pullRequest: createMockPullRequest({ state: "MERGED" }),
      }),
    ];

    const { container } = render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    const collapsible = container.querySelector("[data-state]");
    expect(collapsible?.className).toContain("border-l-blue-500");
    expect(collapsible?.className).not.toContain("border-l-green-500");
  });

  test("shows no border when workstream has no PRs", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Artifact 1",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
        pullRequest: null,
      }),
    ];

    const { container } = render(
      <ArtifactsThreadedView artifacts={artifacts} projectId="project-1" />
    );

    const collapsible = container.querySelector("[data-state]");
    expect(collapsible?.className).not.toContain("border-l-blue-500");
    expect(collapsible?.className).not.toContain("border-l-green-500");
  });
});

describe("ArtifactsThreadedView - Move Artifact", () => {
  afterEach(cleanup);

  test("renders 'Move to project' menu item in dropdown", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Test Artifact",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
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
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Test Artifact",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
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
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Test Artifact",
        workstreamId: "ws-1",
        workstreamTitle: "WS",
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
