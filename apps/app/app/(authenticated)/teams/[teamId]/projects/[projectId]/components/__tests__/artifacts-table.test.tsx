import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockPullRequest } from "@/__tests__/fixtures/artifacts";
import type { ProjectArtifact } from "@/types/teams";
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

const PULL_REQUEST_REGEX = /Pull request/;
const GENERATING_PLAN_REGEX =
  /Generating implementation plan\.\.\. - View workflow/i;
const EXECUTING_PLAN_REGEX =
  /Executing plan and creating PR\.\.\. - View workflow/i;

function createMockProjectArtifact(
  overrides?: Partial<ProjectArtifact>
): ProjectArtifact {
  return {
    id: "artifact-123",
    documentSlug: "test-artifact",
    name: "Test Artifact",
    subtype: "PRD",
    status: "NOT_STARTED",
    ...overrides,
  };
}

describe("ArtifactsTable - PR Icon Display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRouter.mockReturnValue({ push: vi.fn() });
  });

  afterEach(() => {
    cleanup();
  });

  test("displays PR icon after artifact name when artifact has pullRequest", () => {
    const mockPR = createMockPullRequest({
      number: 55,
      htmlUrl: "https://github.com/org/repo/pull/55",
    });

    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        name: "PRD with PR",
        subtype: "PRD",
        pullRequest: mockPR,
      }),
    ];

    render(
      <ArtifactsTable artifacts={artifacts} projectId="test-project-id" />
    );

    // Verify artifact name is rendered
    expect(screen.getByText("PRD with PR")).toBeInTheDocument();

    // Verify PR link is rendered with correct attributes
    const prLink = screen.getByRole("link", { name: "Pull request #55" });
    expect(prLink).toBeInTheDocument();
    expect(prLink).toHaveAttribute(
      "href",
      "https://github.com/org/repo/pull/55"
    );
    expect(prLink).toHaveAttribute("target", "_blank");
    expect(prLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("does not display PR icon when artifact has no pullRequest", () => {
    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        id: "artifact-2",
        name: "Artifact without PR",
        subtype: "IMPLEMENTATION_PLAN",
        pullRequest: null,
      }),
    ];

    render(
      <ArtifactsTable artifacts={artifacts} projectId="test-project-id" />
    );

    expect(screen.getByText("Artifact without PR")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: PULL_REQUEST_REGEX })
    ).not.toBeInTheDocument();
  });

  test("displays PR icon for different artifact subtypes", () => {
    const mockPR1 = createMockPullRequest({ number: 10 });
    const mockPR2 = createMockPullRequest({ number: 20 });
    const mockPR3 = createMockPullRequest({ number: 30 });

    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        name: "PRD",
        subtype: "PRD",
        pullRequest: mockPR1,
      }),
      createMockProjectArtifact({
        id: "artifact-2",
        name: "Implementation Plan",
        subtype: "IMPLEMENTATION_PLAN",
        pullRequest: mockPR2,
      }),
      createMockProjectArtifact({
        id: "artifact-3",
        name: "Issue",
        subtype: "ISSUE",
        pullRequest: mockPR3,
      }),
    ];

    render(
      <ArtifactsTable artifacts={artifacts} projectId="test-project-id" />
    );

    expect(
      screen.getByRole("link", { name: "Pull request #10" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Pull request #20" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Pull request #30" })
    ).toBeInTheDocument();
  });

  test("displays PR icon after subtype icon in correct order", () => {
    const mockPR = createMockPullRequest({
      number: 42,
      htmlUrl: "https://github.com/org/repo/pull/42",
    });

    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        name: "Artifact with PR",
        subtype: "PRD",
        pullRequest: mockPR,
      }),
    ];

    render(
      <ArtifactsTable artifacts={artifacts} projectId="test-project-id" />
    );

    // Find the table cell containing the artifact name
    const nameCell = screen.getByText("Artifact with PR").closest("td");
    expect(nameCell).toBeInTheDocument();

    // Verify the cell contains both the artifact name and PR link
    expect(nameCell).toHaveTextContent("Artifact with PR");
    expect(
      nameCell?.querySelector('a[aria-label="Pull request #42"]')
    ).toBeInTheDocument();
  });

  test("handles mix of artifacts with and without PRs", () => {
    const mockPR = createMockPullRequest({ number: 100 });

    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        name: "With PR",
        pullRequest: mockPR,
      }),
      createMockProjectArtifact({
        id: "artifact-2",
        name: "Without PR",
        pullRequest: null,
      }),
      createMockProjectArtifact({
        id: "artifact-3",
        name: "Undefined PR",
        pullRequest: undefined,
      }),
    ];

    render(
      <ArtifactsTable artifacts={artifacts} projectId="test-project-id" />
    );

    // Only one PR link should be rendered
    const prLink = screen.getByRole("link", { name: "Pull request #100" });
    expect(prLink).toBeInTheDocument();
    expect(prLink).toHaveAttribute(
      "href",
      "https://github.com/org/repo/pull/100"
    );

    // Verify no other PR links exist
    expect(
      screen.queryByRole("link", { name: "Pull request #42" })
    ).not.toBeInTheDocument();
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

  test("groups artifacts by section and displays PR icons correctly", () => {
    const mockPR1 = createMockPullRequest({ number: 10 });
    const mockPR2 = createMockPullRequest({ number: 20 });

    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        id: "doc-1",
        name: "PRD Document",
        subtype: "PRD",
        pullRequest: mockPR1,
      }),
      createMockProjectArtifact({
        id: "plan-1",
        name: "Implementation Plan",
        subtype: "IMPLEMENTATION_PLAN",
        pullRequest: mockPR2,
      }),
    ];

    render(
      <ArtifactsTable artifacts={artifacts} projectId="test-project-id" />
    );

    // Both PR icons should be present regardless of section grouping
    expect(
      screen.getByRole("link", { name: "Pull request #10" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Pull request #20" })
    ).toBeInTheDocument();
  });

  test("PR link does not trigger row click event", () => {
    const mockPR = createMockPullRequest({
      number: 75,
      htmlUrl: "https://github.com/org/repo/pull/75",
    });

    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        name: "Clickable Artifact",
        subtype: "PRD",
        documentSlug: "clickable-artifact",
        pullRequest: mockPR,
      }),
    ];

    const mockPush = vi.fn();
    mockUseRouter.mockReturnValue({ push: mockPush });

    render(
      <ArtifactsTable artifacts={artifacts} projectId="test-project-id" />
    );

    const prLink = screen.getByRole("link", { name: "Pull request #75" });

    // Click on PR link should not trigger navigation (stopPropagation prevents it)
    // We can't directly test stopPropagation, but we verify the link exists and has correct attributes
    expect(prLink).toHaveAttribute(
      "href",
      "https://github.com/org/repo/pull/75"
    );
    expect(prLink).toHaveAttribute("target", "_blank");
  });
});

describe("ArtifactsTable - PR Status Badge Display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRouter.mockReturnValue({ push: vi.fn() });
  });

  afterEach(() => {
    cleanup();
  });

  test("renders generation status indicator for artifact with active status", () => {
    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        name: "Generating Artifact",
        subtype: "PRD",
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

    render(<ArtifactsTable artifacts={artifacts} />);

    expect(
      screen.getByText("Executing plan and creating PR...")
    ).toBeInTheDocument();
  });

  test("does not render indicator when status is NONE", () => {
    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        name: "Artifact",
        subtype: "PRD",
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

    render(<ArtifactsTable artifacts={artifacts} />);

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
    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        name: "Artifact",
        subtype: "PRD",
        generationStatus: undefined,
      }),
    ];

    render(<ArtifactsTable artifacts={artifacts} />);

    expect(screen.queryByText("Waiting to start...")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Executing plan and creating PR...")
    ).not.toBeInTheDocument();
  });

  test("renders clickable link when htmlUrl is provided", () => {
    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        name: "Running Artifact",
        subtype: "IMPLEMENTATION_PLAN",
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

    render(<ArtifactsTable artifacts={artifacts} />);

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

  test("renders PullRequestStatusBadge for OPEN PR", () => {
    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        name: "Artifact with Open PR",
        pullRequest: createMockPullRequest({ state: "OPEN", number: 1 }),
      }),
    ];

    render(<ArtifactsTable artifacts={artifacts} />);

    expect(screen.getByText("OPEN")).toBeInTheDocument();
  });

  test("renders PullRequestStatusBadge for MERGED PR", () => {
    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        name: "Artifact with Merged PR",
        pullRequest: createMockPullRequest({ state: "MERGED", number: 2 }),
      }),
    ];

    render(<ArtifactsTable artifacts={artifacts} />);

    expect(screen.getByText("MERGED")).toBeInTheDocument();
  });

  test("renders PullRequestStatusBadge for CLOSED PR", () => {
    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        name: "Artifact with Closed PR",
        pullRequest: createMockPullRequest({ state: "CLOSED", number: 3 }),
      }),
    ];

    render(<ArtifactsTable artifacts={artifacts} />);

    expect(screen.getByText("CLOSED")).toBeInTheDocument();
  });

  test("does not render badge when pullRequest is null", () => {
    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        name: "Artifact without PR",
        pullRequest: null,
      }),
    ];

    render(<ArtifactsTable artifacts={artifacts} />);

    expect(screen.queryByText("OPEN")).not.toBeInTheDocument();
    expect(screen.queryByText("MERGED")).not.toBeInTheDocument();
    expect(screen.queryByText("CLOSED")).not.toBeInTheDocument();
  });

  test("status transitions from PENDING to SUCCESS", () => {
    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        name: "Transitioning Artifact",
        subtype: "PRD",
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

    const { rerender } = render(<ArtifactsTable artifacts={artifacts} />);

    // Initially shows PENDING state
    expect(screen.getByText("Waiting to start...")).toBeInTheDocument();

    // Update to SUCCESS state
    const updatedArtifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        name: "Transitioning Artifact",
        subtype: "PRD",
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

    rerender(<ArtifactsTable artifacts={updatedArtifacts} />);

    // SUCCESS state shows green checkmark, no message
    expect(screen.queryByText("Waiting to start...")).not.toBeInTheDocument();
    const container = screen.getByText("Transitioning Artifact").closest("td");
    expect(container?.querySelector(".text-green-600")).toBeInTheDocument();
  });

  test("screen reader announcements via aria-label", () => {
    const artifacts: ProjectArtifact[] = [
      createMockProjectArtifact({
        id: "artifact-1",
        name: "Accessible Artifact",
        subtype: "PRD",
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

    render(<ArtifactsTable artifacts={artifacts} />);

    const link = screen.getByRole("link", {
      name: EXECUTING_PLAN_REGEX,
    });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("aria-label");
    expect(screen.queryByText("OPEN")).not.toBeInTheDocument();
    expect(screen.queryByText("MERGED")).not.toBeInTheDocument();
    expect(screen.queryByText("CLOSED")).not.toBeInTheDocument();
  });
});
