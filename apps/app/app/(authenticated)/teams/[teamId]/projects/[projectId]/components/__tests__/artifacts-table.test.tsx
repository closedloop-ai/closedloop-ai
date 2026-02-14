import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockArtifact } from "@/__tests__/fixtures/artifacts";
import { ArtifactsTable } from "../artifacts-table";

// Mock next/navigation
const mockUseRouter = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => mockUseRouter(),
}));

// Mock delete confirmation hook
vi.mock("@/hooks/use-delete-confirmation", () => ({
  useDeleteConfirmation: () => ({
    isOpen: false,
    itemToDelete: null,
    confirmDelete: vi.fn(),
    cancelDelete: vi.fn(),
    showConfirmation: vi.fn(),
  }),
}));

const GENERATING_PLAN_REGEX =
  /Generating implementation plan\.\.\. - View workflow/i;
const EXECUTING_PLAN_REGEX =
  /Executing plan and creating PR\.\.\. - View workflow/i;

function createMockProjectArtifact(
  overrides?: Partial<ArtifactWithWorkstream>
): ArtifactWithWorkstream {
  return createMockArtifact(overrides) as ArtifactWithWorkstream;
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

    render(
      <ArtifactsTable artifacts={artifacts} projectId="test-project-id" />
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
        title: "Implementation Plan",
        type: "IMPLEMENTATION_PLAN",
      }),
    ];

    render(
      <ArtifactsTable artifacts={artifacts} projectId="test-project-id" />
    );

    expect(screen.getByText("PRD Document")).toBeInTheDocument();
    expect(screen.getByText("Implementation Plan")).toBeInTheDocument();
  });

  test("renders empty state when no artifacts provided", () => {
    render(<ArtifactsTable artifacts={[]} projectId="test-project-id" />);

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

    render(
      <ArtifactsTable artifacts={artifacts} projectId="test-project-id" />
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

    render(
      <ArtifactsTable artifacts={artifacts} projectId="test-project-id" />
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

    render(
      <ArtifactsTable artifacts={artifacts} projectId="test-project-id" />
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

    render(
      <ArtifactsTable artifacts={artifacts} projectId="test-project-id" />
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

    const { rerender } = render(
      <ArtifactsTable artifacts={artifacts} projectId="test-project-id" />
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
      <ArtifactsTable
        artifacts={updatedArtifacts}
        projectId="test-project-id"
      />
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

    render(
      <ArtifactsTable artifacts={artifacts} projectId="test-project-id" />
    );

    const link = screen.getByRole("link", {
      name: EXECUTING_PLAN_REGEX,
    });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("aria-label");
  });
});
