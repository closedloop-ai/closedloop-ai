/**
 * @file iss8145-session-ingest-batched-writes.integration.test.ts
 * @description ISS-8145 — a session carrying a producer-bound ref set persists
 * COMPLETELY, against a real database.
 *
 * The harm this guards is not an error; it is a silent partial. ISS-8062 chunked
 * the statements that hit the bind-parameter ceiling, which removed the hard
 * failure and left the 30s per-session transaction deadline as the only limit —
 * and a slice that outruns it rolls back after committing nothing, while a
 * slice that merely got slower still commits. So "it did not throw" is worth
 * nothing here: the assertions below pin COUNT and IDENTITY of every row, which
 * is the only way a dropped or collapsed commit shows up.
 *
 * The ref set is sized at `MAX_SYNCED_ARTIFACT_REFS_PRODUCER` — the bound the
 * shipping desktop applies to itself. It is a client-side courtesy rather than
 * a server guarantee, which is exactly why the server side must be able to
 * carry a full one without degrading.
 *
 * No timing assertion appears here, deliberately (`no-timing-assertions`): the
 * property under test is that the work COMPLETES and everything lands, and a
 * wall-clock bound would make the suite fail on a loaded machine while proving
 * nothing about completeness.
 */
import { randomUUID } from "node:crypto";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { desktopAgentSessionsPayloadObjectSchema } from "@/lib/desktop-agent-sessions-schema";
import { createTestOrganization, createTestUser } from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const REPOSITORY_FULL_NAME = "closedloop-ai/closedloop-ai";
const BRANCH_NAME = "feat/iss-8145-batched-writes";
const STARTED_AT = "2026-09-01T12:00:00.000Z";
const UPDATED_AT = "2026-09-01T12:05:00.000Z";
const EXTERNAL_SESSION_ID = "iss-8145-batched-session";
/** One branch ref plus the commits; the branch ref is what the commits resolve onto. */
const COMMIT_REF_COUNT = MAX_SYNCED_ARTIFACT_REFS_PRODUCER - 1;

describeIfDb(
  "ISS-8145 desktop session ingest — batched per-session writes",
  () => {
    it("persists every commit in a producer-bound ref set, by identity", async () => {
      const organizationId = await createTestOrganization();
      try {
        const user = await createTestUser(organizationId);
        const computeTarget = await createComputeTarget(
          organizationId,
          user.id
        );
        await createRepositoryAuthority(organizationId);
        const payload = buildPayload();

        await agentSessionsService.upsertSessions(
          {
            organizationId,
            userId: user.id,
            computeTargetId: computeTarget.id,
          },
          payload
        );

        const persisted = await readCommitShas(organizationId);
        // IDENTITY, not just the count: a batch that collapsed two refs onto one
        // row, or dropped a chunk's tail, keeps a plausible-looking total.
        expect(persisted).toEqual(expectedShas());
        expect(persisted).toHaveLength(COMMIT_REF_COUNT);

        // The desktop re-sends its full ref set on the next tick. Reconciling is
        // idempotent, so this must add nothing and lose nothing.
        await agentSessionsService.upsertSessions(
          {
            organizationId,
            userId: user.id,
            computeTargetId: computeTarget.id,
          },
          payload
        );
        expect(await readCommitShas(organizationId)).toEqual(expectedShas());
      } finally {
        await cleanupOrganization(organizationId);
      }
    });
  }
);

function createComputeTarget(organizationId: string, userId: string) {
  return withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: "iss-8145-batched-writes",
        platform: "darwin",
      },
      select: { id: true },
    })
  );
}

function createRepositoryAuthority(organizationId: string) {
  return withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: "repo-iss-8145",
          fullName: REPOSITORY_FULL_NAME,
        }),
        owner: "closedloop-ai",
        name: "closedloop-ai",
        htmlUrl: `https://github.com/${REPOSITORY_FULL_NAME}`,
      },
    })
  );
}

/** Distinct, stable 40-char shas — the identity the assertions compare on. */
function commitSha(index: number): string {
  return index.toString(16).padStart(40, "0");
}

function expectedShas(): string[] {
  return Array.from({ length: COMMIT_REF_COUNT }, (_, index) =>
    commitSha(index + 1)
  ).sort();
}

function readCommitShas(organizationId: string): Promise<string[]> {
  return withDb(async (db) => {
    const rows = await db.commitDetail.findMany({
      where: { organizationId },
      select: { sha: true },
    });
    return rows.map((row) => row.sha).sort();
  });
}

function buildPayload(): DesktopAgentSessionsPayload {
  const payload = {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: randomUUID(),
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [buildSession()],
  } satisfies DesktopAgentSessionsPayload;
  const parsed = desktopAgentSessionsPayloadObjectSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `invalid integration payload: ${JSON.stringify(parsed.error.issues)}`
    );
  }
  return payload;
}

function buildSession(): SyncedAgentSession {
  return {
    externalSessionId: EXTERNAL_SESSION_ID,
    name: "ISS-8145 batched writes",
    status: "completed",
    harness: "claude",
    cwd: "/tmp/iss-8145",
    model: "claude-opus-5",
    startedAt: STARTED_AT,
    updatedAt: UPDATED_AT,
    endedAt: UPDATED_AT,
    agents: [
      {
        externalAgentId: "agent-iss-8145",
        name: "Implementation worker",
        type: "main",
        status: "completed",
      },
    ],
    events: [
      {
        externalEventId: `${EXTERNAL_SESSION_ID}-event-0`,
        agentExternalId: "agent-iss-8145",
        eventType: "message",
        createdAt: STARTED_AT,
      },
    ],
    tokenUsageByModel: [],
    tokenEvents: [],
    artifactRefs: [branchRef(), ...commitRefs()],
    prRefs: [],
  };
}

function branchRef(): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName: REPOSITORY_FULL_NAME,
    branchName: BRANCH_NAME,
    method: "git_push",
    relation: ArtifactRefRelation.Created,
    observedAt: UPDATED_AT,
  };
}

/** The commits all sit on ONE branch, so every one resolves and none defers. */
function commitRefs(): SyncedArtifactRef[] {
  return Array.from({ length: COMMIT_REF_COUNT }, (_, index) => ({
    kind: ArtifactRefTargetKind.Commit,
    repositoryFullName: REPOSITORY_FULL_NAME,
    branchName: BRANCH_NAME,
    sha: commitSha(index + 1),
    message: `ISS-8145 fixture commit ${index + 1}`,
    committedAt: UPDATED_AT,
    linesAdded: index + 1,
    linesRemoved: 0,
    filesChanged: 1,
    method: "git_commit",
    relation: ArtifactRefRelation.Created,
    observedAt: UPDATED_AT,
  }));
}

async function cleanupOrganization(organizationId: string): Promise<void> {
  await withDb(async (db) => {
    const artifacts = await db.artifact.findMany({
      where: { organizationId },
      select: { id: true },
    });
    const artifactIds = artifacts.map((artifact) => artifact.id);
    await db.agentSessionEvent.deleteMany({
      where: { agentSessionId: { in: artifactIds } },
    });
    await db.artifactLink.deleteMany({
      where: {
        OR: [
          { sourceId: { in: artifactIds } },
          { targetId: { in: artifactIds } },
        ],
      },
    });
    await db.commitDetail.deleteMany({ where: { organizationId } });
    await db.sessionDetail.deleteMany({
      where: { artifactId: { in: artifactIds } },
    });
    await db.branchDetail.deleteMany({ where: { organizationId } });
    await db.publicRepository.deleteMany({ where: { organizationId } });
    await db.artifact.deleteMany({ where: { id: { in: artifactIds } } });
    await db.computeTarget.deleteMany({ where: { organizationId } });
    await db.user.deleteMany({ where: { organizationId } });
    await db.organization.deleteMany({ where: { id: organizationId } });
  });
}
