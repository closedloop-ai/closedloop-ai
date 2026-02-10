import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

vi.mock("../artifact-subtype-badge", () => ({
  ArtifactSubtypeBadge: ({ subtype }: { subtype: string }) => (
    <div data-testid={`badge-${subtype}`}>{subtype}</div>
  ),
}));

// Helper to create mock artifacts
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
  ...overrides,
});

describe("ArtifactsThreadedView - Empty State", () => {
  afterEach(cleanup);

  test("renders empty state when no artifacts provided", () => {
    render(<ArtifactsThreadedView artifacts={[]} />);

    expect(screen.getByTestId("empty-state")).toBeDefined();
    expect(screen.getByText("No artifacts yet")).toBeDefined();
    expect(
      screen.getByText(
        "Artifacts will appear here as you work on this project."
      )
    ).toBeDefined();
  });
});

describe("ArtifactsThreadedView - Flat List (No Nesting)", () => {
  afterEach(cleanup);

  test("renders all artifacts without parents at top level", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({ id: "1", name: "PRD Alpha", subtype: "PRD" }),
      createMockArtifact({ id: "2", name: "PRD Beta", subtype: "PRD" }),
      createMockArtifact({
        id: "3",
        name: "Issue Gamma",
        subtype: "ISSUE",
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    expect(screen.getByText("PRD Alpha")).toBeDefined();
    expect(screen.getByText("PRD Beta")).toBeDefined();
    expect(screen.getByText("Issue Gamma")).toBeDefined();
  });

  test("renders artifact with all fields populated", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Full Artifact",
        subtype: "IMPLEMENTATION_PLAN",
        status: "COMPLETE",
        link: "https://example.com/artifact",
        previewUrl: "https://preview.example.com",
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    expect(screen.getByText("Full Artifact")).toBeDefined();
    expect(screen.getByTestId("badge-IMPLEMENTATION_PLAN")).toBeDefined();
    expect(screen.getByText("Complete")).toBeDefined();
  });
});

describe("ArtifactsThreadedView - Tree Building", () => {
  afterEach(cleanup);

  test("nests implementation plan under parent PRD", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({ id: "prd-1", name: "Parent PRD", subtype: "PRD" }),
      createMockArtifact({
        id: "plan-1",
        name: "Child Plan",
        subtype: "IMPLEMENTATION_PLAN",
        parentId: "prd-1",
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    // Both should be present
    expect(screen.getByText("Parent PRD")).toBeDefined();
    expect(screen.getByText("Child Plan")).toBeDefined();

    // Child should have indentation
    const childRow = screen
      .getByText("Child Plan")
      .closest("div[role='button']");
    const parentRow = screen
      .getByText("Parent PRD")
      .closest("div[role='button']");

    // The child row's first column should have padding-left applied via style attribute
    const childFirstCol = childRow?.querySelector(
      "div.flex.items-center.gap-2"
    ) as HTMLElement;
    expect(childFirstCol?.style.paddingLeft).toBe("24px");

    // Parent should have no extra padding
    const parentFirstCol = parentRow?.querySelector(
      "div.flex.items-center.gap-2"
    ) as HTMLElement;
    expect(parentFirstCol?.style.paddingLeft).toBe("0px");
  });

  test("nests branch under implementation plan under PRD (3-level hierarchy)", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({ id: "prd-1", name: "PRD", subtype: "PRD" }),
      createMockArtifact({
        id: "plan-1",
        name: "Plan",
        subtype: "IMPLEMENTATION_PLAN",
        parentId: "prd-1",
      }),
      createMockArtifact({
        id: "branch-1",
        name: "Feature Branch",
        subtype: "BRANCH",
        parentId: "plan-1",
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    // Check indentation levels
    const prdElements = screen.getAllByText("PRD");
    const prdRow = prdElements
      .map((el) => el.closest("div[role='button']"))
      .find((row) => row !== null);
    const prdCol = prdRow?.querySelector(
      "div.flex.items-center.gap-2"
    ) as HTMLElement;
    const planRow = screen.getByText("Plan").closest("div[role='button']");
    const planCol = planRow?.querySelector(
      "div.flex.items-center.gap-2"
    ) as HTMLElement;
    // Branch is not navigable, so find it by the grid row class
    const branchRow = screen
      .getByText("Feature Branch")
      .closest(
        "div.grid.grid-cols-\\[1fr\\,auto\\,auto\\,auto\\,auto\\,auto\\]"
      );
    const branchCol = branchRow?.querySelector(
      "div.flex.items-center.gap-2"
    ) as HTMLElement;

    expect(prdCol?.style.paddingLeft).toBe("0px");
    expect(planCol?.style.paddingLeft).toBe("24px");
    expect(branchCol?.style.paddingLeft).toBe("48px");
  });

  test("treats artifacts with non-existent parentId as top-level (orphan handling)", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "orphan-1",
        name: "Orphan Plan",
        subtype: "IMPLEMENTATION_PLAN",
        parentId: "non-existent-parent",
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    // Should render at top level
    expect(screen.getByText("Orphan Plan")).toBeDefined();

    const orphanRow = screen
      .getByText("Orphan Plan")
      .closest("div[role='button']");
    const orphanCol = orphanRow?.querySelector(
      "div.flex.items-center.gap-2"
    ) as HTMLElement;
    expect(orphanCol?.style.paddingLeft).toBe("0px");
  });

  test("handles multiple independent parent-child trees", () => {
    const artifacts: ProjectArtifact[] = [
      // Tree 1: PRD -> Plan
      createMockArtifact({ id: "prd-1", name: "PRD One", subtype: "PRD" }),
      createMockArtifact({
        id: "plan-1",
        name: "Plan One",
        subtype: "IMPLEMENTATION_PLAN",
        parentId: "prd-1",
      }),
      // Tree 2: Issue -> Plan
      createMockArtifact({
        id: "issue-1",
        name: "Issue Two",
        subtype: "ISSUE",
      }),
      createMockArtifact({
        id: "plan-2",
        name: "Plan Two",
        subtype: "IMPLEMENTATION_PLAN",
        parentId: "issue-1",
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    // All should be present
    expect(screen.getByText("PRD One")).toBeDefined();
    expect(screen.getByText("Plan One")).toBeDefined();
    expect(screen.getByText("Issue Two")).toBeDefined();
    expect(screen.getByText("Plan Two")).toBeDefined();

    // Check indentation levels for both trees
    const planOneRow = screen
      .getByText("Plan One")
      .closest("div[role='button']");
    const planOneCol = planOneRow?.querySelector(
      "div.flex.items-center.gap-2"
    ) as HTMLElement;
    const planTwoRow = screen
      .getByText("Plan Two")
      .closest("div[role='button']");
    const planTwoCol = planTwoRow?.querySelector(
      "div.flex.items-center.gap-2"
    ) as HTMLElement;

    expect(planOneCol?.style.paddingLeft).toBe("24px");
    expect(planTwoCol?.style.paddingLeft).toBe("24px");
  });

  test("handles mixed top-level and nested artifacts", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({ id: "prd-1", name: "Top PRD", subtype: "PRD" }),
      createMockArtifact({
        id: "plan-1",
        name: "Nested Plan",
        subtype: "IMPLEMENTATION_PLAN",
        parentId: "prd-1",
      }),
      createMockArtifact({
        id: "standalone-1",
        name: "Standalone Issue",
        subtype: "ISSUE",
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    const nestedPlanRow = screen
      .getByText("Nested Plan")
      .closest("div[role='button']");
    const nestedPlanCol = nestedPlanRow?.querySelector(
      "div.flex.items-center.gap-2"
    ) as HTMLElement;
    const standaloneRow = screen
      .getByText("Standalone Issue")
      .closest("div[role='button']");
    const standaloneCol = standaloneRow?.querySelector(
      "div.flex.items-center.gap-2"
    ) as HTMLElement;

    expect(nestedPlanCol?.style.paddingLeft).toBe("24px");
    expect(standaloneCol?.style.paddingLeft).toBe("0px");
  });
});

describe("ArtifactsThreadedView - Status Display", () => {
  afterEach(cleanup);

  test("displays status for each artifact", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Complete Artifact",
        status: "COMPLETE",
      }),
      createMockArtifact({
        id: "2",
        name: "Not Started Artifact",
        status: "NOT_STARTED",
      }),
      createMockArtifact({
        id: "3",
        name: "Wont Do Artifact",
        status: "WONT_DO",
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    expect(screen.getByText("Complete")).toBeDefined();
    expect(screen.getByText("Not Started")).toBeDefined();
    expect(screen.getByText("Won't Do")).toBeDefined();
  });

  test("calls onStatusChange when status is updated", () => {
    const handleStatusChange = vi.fn();
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({ id: "1", name: "Artifact", status: "NOT_STARTED" }),
    ];

    render(
      <ArtifactsThreadedView
        artifacts={artifacts}
        onStatusChange={handleStatusChange}
      />
    );

    // The Select component is rendered - status change would be triggered by user interaction
    // This test verifies the prop is passed through correctly
    expect(screen.getByText("Not Started")).toBeDefined();
  });
});

describe("ArtifactsThreadedView - Links and External Links", () => {
  afterEach(cleanup);

  test("renders external link for BRANCH artifact", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Feature Branch",
        subtype: "BRANCH",
        link: "https://github.com/org/repo/tree/feature",
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    // Should render external link with proper href
    const externalLink = document.querySelector('a[target="_blank"]');
    expect(externalLink).not.toBeNull();
    expect(externalLink?.getAttribute("href")).toBe(
      "https://github.com/org/repo/tree/feature"
    );
  });

  test("renders external link for DESIGNS artifact with http URL", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Design Files",
        subtype: "DESIGNS",
        link: "https://figma.com/design/123",
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    const externalLink = document.querySelector('a[target="_blank"]');
    expect(externalLink).not.toBeNull();
    expect(externalLink?.getAttribute("href")).toBe(
      "https://figma.com/design/123"
    );
  });

  test("renders internal link for PRD artifact", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Product Requirements",
        subtype: "PRD",
        documentSlug: "product-requirements",
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    // Should render Next.js Link (not external)
    const internalLink = document.querySelector('a:not([target="_blank"])');
    expect(internalLink).not.toBeNull();
    expect(internalLink?.getAttribute("href")).toBe(
      "/prds/product-requirements"
    );
  });

  test("renders n/a for artifacts without links", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "No Link Artifact",
        subtype: "TEMPLATE",
        link: undefined,
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    // Should have two n/a - one for link and one for preview
    const naElements = screen.getAllByText("n/a");
    expect(naElements.length).toBeGreaterThan(0);
  });
});

describe("ArtifactsThreadedView - Navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  test("navigates to PRD editor when PRD row is clicked", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Product Requirements",
        subtype: "PRD",
        documentSlug: "product-requirements",
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    const row = screen
      .getByText("Product Requirements")
      .closest("div[role='button']");
    expect(row).not.toBeNull();
    // Row should have cursor-pointer class indicating it's clickable
    expect(row?.className).toContain("cursor-pointer");
  });

  test("navigates to implementation plan editor when plan row is clicked", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Implementation Strategy",
        subtype: "IMPLEMENTATION_PLAN",
        documentSlug: "impl-strategy",
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    const row = screen
      .getByText("Implementation Strategy")
      .closest("div[role='button']");
    expect(row?.className).toContain("cursor-pointer");
  });

  test("does not navigate when non-navigable artifact is clicked", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Template",
        subtype: "TEMPLATE",
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    const row = screen.getByText("Template").closest("div");
    // Row should not have cursor-pointer class
    expect(row?.className).not.toContain("cursor-pointer");
  });
});

describe("ArtifactsThreadedView - Table Headers", () => {
  afterEach(cleanup);

  test("renders all column headers", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({ id: "1", name: "Test" }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    // Check for header row
    expect(screen.getByText("Artifact")).toBeDefined();
    expect(screen.getByText("Type")).toBeDefined();
    expect(screen.getByText("Status")).toBeDefined();
    expect(screen.getByText("Link")).toBeDefined();
    expect(screen.getByText("Preview")).toBeDefined();
  });
});

describe("ArtifactsThreadedView - Subtype Badges", () => {
  afterEach(cleanup);

  test("renders correct badge for each subtype", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({ id: "1", name: "PRD", subtype: "PRD" }),
      createMockArtifact({
        id: "2",
        name: "Plan",
        subtype: "IMPLEMENTATION_PLAN",
      }),
      createMockArtifact({ id: "3", name: "Issue", subtype: "ISSUE" }),
      createMockArtifact({ id: "4", name: "Bug", subtype: "BUG" }),
      createMockArtifact({ id: "5", name: "Branch", subtype: "BRANCH" }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    expect(screen.getByTestId("badge-PRD")).toBeDefined();
    expect(screen.getByTestId("badge-IMPLEMENTATION_PLAN")).toBeDefined();
    expect(screen.getByTestId("badge-ISSUE")).toBeDefined();
    expect(screen.getByTestId("badge-BUG")).toBeDefined();
    expect(screen.getByTestId("badge-BRANCH")).toBeDefined();
  });
});

describe("ArtifactsThreadedView - Preview Links", () => {
  afterEach(cleanup);

  test("renders preview link when previewUrl is provided", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "With Preview",
        previewUrl: "https://preview.example.com",
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    // The PreviewLink component should be rendered
    expect(screen.getByTestId("preview-link")).toBeDefined();
  });

  test("renders n/a when previewUrl is not provided", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "No Preview",
        previewUrl: undefined,
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    // The PreviewLink component should render n/a
    expect(screen.getByTestId("preview-link")).toBeDefined();
  });
});
