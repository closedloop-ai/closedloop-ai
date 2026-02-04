import type {
  ArtifactWithWorkstream,
  GenerationStatus,
  PullRequestInfo,
} from "@repo/api/src/types/artifact";

/**
 * Factory for creating mock ArtifactWithWorkstream objects.
 * Use this across all test files that need artifact test data.
 */
export const createMockArtifact = (
  overrides?: Partial<ArtifactWithWorkstream>
): ArtifactWithWorkstream =>
  ({
    id: "artifact-123",
    title: "Test Artifact",
    type: "PRD",
    version: 1,
    documentSlug: "test-artifact",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-16T10:00:00Z",
    ...overrides,
  }) as ArtifactWithWorkstream;

/**
 * Factory for creating mock GenerationStatus objects.
 */
export const createMockGenerationStatus = (
  overrides?: Partial<GenerationStatus>
): GenerationStatus => ({
  status: "SUCCESS",
  command: "execute",
  htmlUrl: "https://github.com/org/repo/actions/runs/123",
  startedAt: new Date("2024-01-15T10:00:00Z"),
  completedAt: new Date("2024-01-15T10:05:00Z"),
  correlationId: "corr-123",
  ...overrides,
});

/**
 * Factory for creating mock PullRequestInfo objects.
 */
export const createMockPullRequest = (
  overrides?: Partial<PullRequestInfo>
): PullRequestInfo => ({
  id: "pr-123",
  number: 42,
  title: "Add new feature",
  htmlUrl: "https://github.com/org/repo/pull/42",
  state: "OPEN",
  headBranch: "feature-branch",
  baseBranch: "main",
  createdAt: new Date("2024-01-15T10:00:00Z"),
  ...overrides,
});
