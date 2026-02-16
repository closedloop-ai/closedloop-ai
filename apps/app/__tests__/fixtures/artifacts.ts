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
    slug: "test-artifact",
    latestVersion: 1,
    status: "DRAFT",
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
 * If only `number` is provided, `htmlUrl` will be automatically generated to match.
 */
export const createMockPullRequest = (
  overrides?: Partial<PullRequestInfo>
): PullRequestInfo => {
  const number = overrides?.number ?? 42;
  const htmlUrl =
    overrides?.htmlUrl ?? `https://github.com/org/repo/pull/${number}`;

  return {
    id: "pr-123",
    number,
    title: "Add new feature",
    htmlUrl,
    state: "OPEN",
    headBranch: "feature-branch",
    baseBranch: "main",
    createdAt: new Date("2024-01-15T10:00:00Z"),
    ...overrides,
  };
};
