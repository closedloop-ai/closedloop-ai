/**
 * Integration tests for the SESSION artifact storage migration (PLN-854 /
 * FEA-1699). These run against a real Postgres because they exercise the
 * class-table-inheritance write path: `upsertSessions` creates a parent
 * `artifacts` row + `session_detail` row + a SES-* slug in one transaction,
 * and reads join the two tables back into the unchanged API response shape.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { ArtifactType as PrismaArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { computeTargetsService } from "@/app/compute-targets/service";
import { generateSlug } from "@/lib/slug-generator";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;
const describeIfDb = hasDatabase ? describe : describe.skip;

const SESSION_STARTED_AT = new Date("2026-06-10T10:00:00.000Z");
const SESSION_UPDATED_AT = new Date("2026-06-10T11:00:00.000Z");
const SES_SLUG_PATTERN = /^SES-\d+$/;

function createComputeTarget(
  organizationId: string,
  userId: string,
  machineName = "integration-machine"
) {
  return withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName,
        platform: "darwin",
      },
      select: { id: true },
    })
  );
}

function buildSyncedSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "ext-session-1",
    name: "Integration session",
    status: "active",
    harness: "claude",
    cwd: "/tmp/worktree",
    model: "claude-opus",
    startedAt: SESSION_STARTED_AT.toISOString(),
    updatedAt: SESSION_UPDATED_AT.toISOString(),
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

function buildPayload(
  sessions: SyncedAgentSession[]
): DesktopAgentSessionsPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "1f1d6a3e-1b2c-4d5e-8f90-1a2b3c4d5e6f",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

function findSessionArtifact(
  computeTargetId: string,
  externalSessionId: string
) {
  return withDb((db) =>
    db.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId,
        },
      },
      select: {
        artifactId: true,
        harness: true,
        sourceArtifactId: true,
        artifact: {
          select: {
            type: true,
            name: true,
            status: true,
            slug: true,
            projectId: true,
            createdById: true,
          },
        },
      },
    })
  );
}

describeIfDb("agent session artifact migration (FEA-1699)", () => {
  it("creates a SESSION artifact + session_detail + SES-* slug on sync", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);

      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload([buildSyncedSession({ name: "Session A" })])
      );

      const detail = await findSessionArtifact(
        computeTarget.id,
        "ext-session-1"
      );
      expect(detail).not.toBeNull();
      expect(detail?.artifact.type).toBe(PrismaArtifactType.SESSION);
      expect(detail?.artifact.name).toBe("Session A");
      expect(detail?.artifact.status).toBe("active");
      expect(detail?.artifact.slug).toMatch(SES_SLUG_PATTERN);
      // No attribution → unparented session artifact.
      expect(detail?.artifact.projectId).toBeNull();
      // Owner is mirrored onto the artifact for owner-display purposes.
      expect(detail?.artifact.createdById).toBe(user.id);

      const list = await agentSessionsService.findSessions({
        organizationId,
        filters: {},
      });
      expect(list.items.map((item) => item.id)).toContain(detail?.artifactId);
      const item = list.items.find((i) => i.id === detail?.artifactId);
      expect(item?.slug).toBe(detail?.artifact.slug);
    });
  });

  it("falls back to a stable name when the synced session has none", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);

      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload([
          buildSyncedSession({ externalSessionId: "ext-noname", name: null }),
        ])
      );

      const detail = await findSessionArtifact(computeTarget.id, "ext-noname");
      expect(detail?.artifact.name).toBe("Session ext-noname");
    });
  });

  it("re-syncing the same session updates in place without a duplicate or new slug", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);

      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload([buildSyncedSession({ name: "First", status: "active" })])
      );
      const first = await findSessionArtifact(
        computeTarget.id,
        "ext-session-1"
      );

      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload([
          buildSyncedSession({ name: "Second", status: "completed" }),
        ])
      );
      const second = await findSessionArtifact(
        computeTarget.id,
        "ext-session-1"
      );

      // Same artifact id and slug; hoisted fields updated in place.
      expect(second?.artifactId).toBe(first?.artifactId);
      expect(second?.artifact.slug).toBe(first?.artifact.slug);
      expect(second?.artifact.name).toBe("Second");
      expect(second?.artifact.status).toBe("completed");

      const sessionArtifactCount = await withDb((db) =>
        db.artifact.count({
          where: { organizationId, type: ArtifactType.Session },
        })
      );
      expect(sessionArtifactCount).toBe(1);
    });
  });

  it("resolves the project from source-artifact attribution and scopes project queries", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, user.id);
      const computeTarget = await createComputeTarget(organizationId, user.id);

      // A document artifact in the project supplies the resolvable projectId.
      const sourceSlug = await generateSlug(organizationId, SlugPrefix.Prd);
      const sourceArtifact = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId,
            projectId,
            type: ArtifactType.Document,
            name: "Source PRD",
            slug: sourceSlug,
            status: "DRAFT",
          },
          select: { id: true },
        })
      );

      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload([
          buildSyncedSession({
            externalSessionId: "ext-attributed",
            attribution: { sourceArtifactId: sourceArtifact.id },
          }),
          buildSyncedSession({ externalSessionId: "ext-unparented" }),
        ])
      );

      const attributed = await findSessionArtifact(
        computeTarget.id,
        "ext-attributed"
      );
      expect(attributed?.artifact.projectId).toBe(projectId);

      const scoped = await agentSessionsService.findSessions({
        organizationId,
        filters: { projectId },
      });
      const scopedIds = scoped.items.map((item) => item.id);
      expect(scopedIds).toContain(attributed?.artifactId);
      // The unparented session must be excluded from a project-scoped query.
      const unparented = await findSessionArtifact(
        computeTarget.id,
        "ext-unparented"
      );
      expect(unparented?.artifact.projectId).toBeNull();
      expect(scopedIds).not.toContain(unparented?.artifactId);
    });
  });

  it("preserves project attribution when a resync payload omits attribution", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, user.id);
      const computeTarget = await createComputeTarget(organizationId, user.id);

      const sourceSlug = await generateSlug(organizationId, SlugPrefix.Prd);
      const sourceArtifact = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId,
            projectId,
            type: ArtifactType.Document,
            name: "Source PRD",
            slug: sourceSlug,
            status: "DRAFT",
          },
          select: { id: true },
        })
      );

      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload([
          buildSyncedSession({
            externalSessionId: "ext-sticky",
            attribution: { sourceArtifactId: sourceArtifact.id },
          }),
        ])
      );

      // Attribution is optional on the wire: older Desktop builds and
      // chunked/partial batches can resync the same session without it. The
      // existing project parent must survive such a resync.
      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload([
          buildSyncedSession({
            externalSessionId: "ext-sticky",
            name: "Renamed after resync",
          }),
        ])
      );

      const detail = await findSessionArtifact(computeTarget.id, "ext-sticky");
      expect(detail?.artifact.projectId).toBe(projectId);
      expect(detail?.artifact.name).toBe("Renamed after resync");
      // Detail-level attribution must survive too — the resync omitted
      // attribution entirely, which must not clear captured columns.
      expect(detail?.sourceArtifactId).toBe(sourceArtifact.id);
    });
  });

  it("removes session artifacts when the owning compute target is deleted", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);

      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload([buildSyncedSession()])
      );
      const before = await findSessionArtifact(
        computeTarget.id,
        "ext-session-1"
      );
      expect(before).not.toBeNull();

      const deleted = await computeTargetsService.deleteOwned(
        computeTarget.id,
        organizationId,
        user.id
      );
      expect(deleted).toBe(true);

      // Parent artifact and detail are both gone — no orphaned artifact row.
      const orphanArtifacts = await withDb((db) =>
        db.artifact.count({
          where: { organizationId, type: ArtifactType.Session },
        })
      );
      expect(orphanArtifacts).toBe(0);
      const remainingDetail = await withDb((db) =>
        db.sessionDetail.count({ where: { computeTargetId: computeTarget.id } })
      );
      expect(remainingDetail).toBe(0);
    });
  });

  it("supports artifact links from a session to another artifact", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const projectId = await createTestProject(organizationId, user.id);
      const computeTarget = await createComputeTarget(organizationId, user.id);

      await agentSessionsService.upsertSessions(
        { organizationId, userId: user.id, computeTargetId: computeTarget.id },
        buildPayload([buildSyncedSession()])
      );
      const session = await findSessionArtifact(
        computeTarget.id,
        "ext-session-1"
      );

      const targetSlug = await generateSlug(organizationId, SlugPrefix.Prd);
      const target = await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId,
            projectId,
            type: ArtifactType.Document,
            name: "Output doc",
            slug: targetSlug,
            status: "DRAFT",
          },
          select: { id: true },
        })
      );

      const link = await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId,
            sourceId: session?.artifactId ?? "",
            targetId: target.id,
            linkType: LinkType.RelatesTo,
          },
          select: { id: true, sourceId: true, targetId: true, linkType: true },
        })
      );

      expect(link.sourceId).toBe(session?.artifactId);
      expect(link.targetId).toBe(target.id);
      expect(link.linkType).toBe(LinkType.RelatesTo);
    });
  });
});
