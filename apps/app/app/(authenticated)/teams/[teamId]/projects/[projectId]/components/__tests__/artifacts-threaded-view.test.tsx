import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

    render(<ArtifactsThreadedView artifacts={artifacts} />);

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

    render(<ArtifactsThreadedView artifacts={artifacts} />);

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

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    expect(screen.getByText("1 artifact")).toBeDefined();
  });

  test("places unassigned artifacts in 'Unassigned' group", () => {
    const artifacts: ProjectArtifact[] = [
      createMockArtifact({
        id: "1",
        name: "Orphan PRD",
        workstreamId: null,
        workstreamTitle: null,
      }),
    ];

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    expect(screen.getByText("Unassigned")).toBeDefined();
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

    render(<ArtifactsThreadedView artifacts={artifacts} />);

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

    render(<ArtifactsThreadedView artifacts={artifacts} />);

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

    render(<ArtifactsThreadedView artifacts={artifacts} />);

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

    render(<ArtifactsThreadedView artifacts={artifacts} />);

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

    render(<ArtifactsThreadedView artifacts={artifacts} />);

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

    render(<ArtifactsThreadedView artifacts={artifacts} />);

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

    render(<ArtifactsThreadedView artifacts={artifacts} />);

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

    render(<ArtifactsThreadedView artifacts={artifacts} />);

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

    render(<ArtifactsThreadedView artifacts={artifacts} />);

    const trigger = screen.getByText("WS").closest("button");
    fireEvent.click(trigger!);

    const row = screen.getByText("Template").closest("div.flex");
    expect(row?.className).not.toContain("cursor-pointer");
  });
});
