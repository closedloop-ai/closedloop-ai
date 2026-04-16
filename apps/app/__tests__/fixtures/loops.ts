import type { Loop, LoopWithUser } from "@repo/api/src/types/loop";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";

/**
 * Factory for creating mock Loop objects.
 * Use this across all test files that need loop test data.
 */
export function createMockLoop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: "loop-001",
    organizationId: "org-1",
    userId: "user-1",
    status: LoopStatus.Failed,
    command: LoopCommand.Execute,
    documentId: null,
    workstreamId: null,
    parentLoopId: null,
    computeTargetId: null,
    prompt: "Do the thing",
    repo: null,
    contextRefs: null,
    containerId: null,
    s3StateKey: null,
    prUrl: null,
    prNumber: null,
    branchName: null,
    sessionId: null,
    tokensInput: 0,
    tokensOutput: 0,
    tokensByModel: null,
    estimatedCost: null,
    startedAt: null,
    completedAt: null,
    error: null,
    documentVersion: null,
    metadata: {},
    uploadedArtifacts: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Factory for creating mock LoopWithUser objects.
 * Use this across all test files that need loop-with-user test data.
 */
export function createMockLoopWithUser(
  overrides: Partial<LoopWithUser> = {}
): LoopWithUser {
  const { user, computeTarget, ...loopOverrides } = overrides;
  return {
    ...createMockLoop(loopOverrides),
    user: {
      id: "user-1",
      firstName: "Alice",
      lastName: "Smith",
      avatarUrl: null,
      email: "alice@example.com",
      ...user,
    },
    computeTarget: computeTarget ?? null,
    ...overrides,
  };
}
