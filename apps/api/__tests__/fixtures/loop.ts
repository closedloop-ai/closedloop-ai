import { HarnessType } from "@repo/api/src/types/compute-target";
import type { Loop } from "@repo/api/src/types/loop";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import type { Loop as PrismaLoop } from "@repo/database";

/**
 * Canonical Prisma `Loop` row for mocks of `db.loop.{findFirst,findUnique,create}`.
 * For API-shaped payloads / service returns, use `buildLoop` below (`Loop` from
 * `@repo/api/src/types/loop`, i.e. `documentId` not `artifactId`).
 */
export function buildPrismaLoop(
  overrides: Partial<PrismaLoop> = {}
): PrismaLoop {
  return {
    id: "loop-1",
    organizationId: "org-1",
    userId: "user-1",
    status: LoopStatus.Running,
    command: LoopCommand.Plan,
    harness: HarnessType.Claude,
    artifactId: "artifact-1",
    artifactVersion: null,
    parentLoopId: null,
    computeTargetId: null,
    prompt: null,
    repo: null,
    additionalRepos: null,
    contextRefs: null,
    containerId: null,
    s3StateKey: null,
    prUrl: null,
    prNumber: null,
    branchName: null,
    sessionId: null,
    sessionArtifactId: null,
    tokensInput: 0,
    tokensOutput: 0,
    tokensByModel: null,
    estimatedCost: null,
    startedAt: null,
    completedAt: null,
    error: null,
    metadata: {},
    uploadedArtifacts: null,
    activeTokenJti: null,
    tokenExpiresAt: null,
    lastRunnerHeartbeatAt: null,
    runnerCapabilities: null,
    revivalCount: 0,
    lastRevivalAt: null,
    createdAt: new Date("2026-02-25T00:00:00Z"),
    updatedAt: new Date("2026-02-25T00:00:00Z"),
    ...overrides,
  };
}

export function buildLoop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: "loop-1",
    organizationId: "org-1",
    userId: "user-1",
    status: LoopStatus.Completed,
    command: LoopCommand.Plan,
    harness: HarnessType.Claude,
    documentId: "artifact-1",
    parentLoopId: null,
    computeTargetId: null,
    prompt: null,
    repo: { fullName: "org/repo", branch: "main" },
    additionalRepos: null,
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
    activeTokenJti: null,
    createdAt: new Date("2026-02-25T00:00:00Z"),
    updatedAt: new Date("2026-02-25T00:00:00Z"),
    ...overrides,
  };
}
