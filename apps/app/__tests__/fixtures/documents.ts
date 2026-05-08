import { Priority } from "@repo/api/src/types/common";
import type {
  DocumentWithWorkstream,
  GenerationStatus,
  PullRequestInfo,
} from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";

/**
 * Factory for creating mock DocumentWithWorkstream objects.
 * Use this across all test files that need artifact test data.
 */
export const createMockDocument = (
  overrides?: Partial<DocumentWithWorkstream>
): DocumentWithWorkstream => ({
  id: "artifact-123",
  organizationId: "org-1",
  workstreamId: null,
  projectId: null,
  type: DocumentType.Prd,
  title: "Test Artifact",
  slug: "test-artifact",
  fileName: null,
  status: DocumentStatus.Draft,
  priority: Priority.Medium,
  latestVersion: 1,
  createdById: "user-1",
  assigneeId: null,
  assignee: null,
  approverId: null,
  approver: null,
  tokenUsage: null,
  targetRepo: null,
  targetBranch: null,
  templateForType: null,
  sortOrder: null,
  createdAt: new Date("2024-01-15T10:00:00Z"),
  updatedAt: new Date("2024-01-16T10:00:00Z"),
  ...overrides,
});

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
    checksStatus: null,
    reviewDecision: null,
    externalLinkId: null,
    repoFullName: "org/repo",
    ...overrides,
  };
};
