import { Priority } from "@repo/api/src/types/common";
import type {
  DocumentWithProject,
  GenerationStatus,
  PullRequestInfo,
} from "@repo/api/src/types/document";
import {
  DocumentStatus,
  DocumentType,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";

/**
 * Factory for creating mock DocumentWithProject objects.
 * Use this across all test files that need artifact test data.
 */
export const createMockDocument = (
  overrides?: Partial<DocumentWithProject>
): DocumentWithProject => ({
  id: "artifact-123",
  organizationId: "org-1",
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
  repositorySnapshot: {
    repositories: [],
    source: SnapshotSource.None,
  },
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
    state: GitHubPRState.Open,
    headBranch: "feature-branch",
    baseBranch: "main",
    createdAt: new Date("2024-01-15T10:00:00Z"),
    checksStatus: null,
    reviewDecision: null,
    externalLinkId: null,
    repoFullName: "org/repo",
    ...overrides,
    isDraft: overrides?.isDraft ?? false,
  };
};

/**
 * Shared fixture user constant reused by document-table test files.
 * Matches the "Ada Lovelace" test user used across cell tests.
 */
export const TEST_USER = {
  id: "user-1",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  avatarUrl: null,
} as const;

/**
 * Thin wrapper over createMockDocument with document-table defaults
 * (a PRD attached to a project). Use the type-specific helpers below when a
 * Feature or ImplementationPlan is needed as the default.
 */
export const makeArtifact = (
  overrides?: Partial<DocumentWithProject>
): DocumentWithProject =>
  createMockDocument({
    id: "artifact-1",
    projectId: "project-1",
    title: "Test PRD",
    slug: "PRD-1",
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-02"),
    ...overrides,
  });

/**
 * Factory for a Feature-type DocumentWithProject.
 */
export const makeFeatureArtifact = (
  overrides?: Partial<DocumentWithProject>
): DocumentWithProject =>
  makeArtifact({
    id: "feature-1",
    type: DocumentType.Feature,
    title: "Test Feature",
    slug: "FEAT-1",
    ...overrides,
  });

/**
 * Factory for an ImplementationPlan-type DocumentWithProject.
 */
export const makePlanArtifact = (
  overrides?: Partial<DocumentWithProject>
): DocumentWithProject =>
  makeArtifact({
    id: "artifact-plan-1",
    type: DocumentType.ImplementationPlan,
    title: "Test Plan",
    slug: "PLAN-1",
    ...overrides,
  });
