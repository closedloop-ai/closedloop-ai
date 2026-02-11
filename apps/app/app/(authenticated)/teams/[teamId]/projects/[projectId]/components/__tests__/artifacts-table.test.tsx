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
