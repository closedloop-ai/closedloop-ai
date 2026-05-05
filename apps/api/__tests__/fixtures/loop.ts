import type { Loop } from "@repo/api/src/types/loop";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";

/**
 * Prisma-shaped loop record (artifactId / artifactVersion) used by mocks of
 * `db.loop.{findFirst,findUnique,create}`. The API-shaped equivalent is
 * `buildLoop` below — use that for service return values, this for db rows.
 */
export type PrismaLoopRecord = Record<string, unknown> & {
  id: string;
  status: string;
  command: string;
  artifactId: string | null;
};

export function buildPrismaLoop(
  overrides: Partial<PrismaLoopRecord> = {}
): PrismaLoopRecord {
  return {
    id: "loop-1",
    organizationId: "org-1",
    userId: "user-1",
    status: "RUNNING",
    command: "PLAN",
    artifactId: "artifact-1",
    artifactVersion: null,
    workstreamId: null,
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
    tokensInput: 0,
    tokensOutput: 0,
    tokensByModel: null,
    estimatedCost: null,
    startedAt: null,
    completedAt: null,
    error: null,
    metadata: {},
    uploadedArtifacts: null,
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
    documentId: "artifact-1",
    workstreamId: "ws-1",
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
    createdAt: new Date("2026-02-25T00:00:00Z"),
    updatedAt: new Date("2026-02-25T00:00:00Z"),
    ...overrides,
  };
}
