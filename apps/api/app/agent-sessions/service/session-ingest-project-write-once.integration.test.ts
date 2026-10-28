/**
 * ISS-10995 (operator ruling 2026-10-12): "the sync sets the project when the
 * record is first synced, but it don't change it after that". The Session
 * Details Project row is only worth having if that holds, so these cases drive
 * the REAL ingest and read the stored artifact back.
 *
 * Two projects throughout: with one, "the sync filed it" and "the sync left the
 * user's value alone" cannot be told apart.
 *
 * The lineage the ingest resolves is `attribution.sourceArtifactId`'s project
 * (`project-resolution.ts`), so each case drives it through a DOCUMENT artifact
 * filed in project A, exactly as a `iss-42-*` session reaches its issue.
 */
import { randomUUID } from "node:crypto";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  buildSessionChunk,
  type ChunkSyncContext,
  createComputeTarget,
  ingestChunk,
} from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createTestOrganization,
  createTestProject,
  createTestUser,
  joinAmbientTransactionForSessionSyncWrites,
} from "@/__tests__/utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const EXTERNAL_SESSION_ID = "iss-10995-project-write-once";
const FIRST_NAME = "fix/first-sync-title";
const RESYNCED_NAME = "fix/resynced-title";
const RESYNCED_UPDATED_AT = "2026-06-10T12:00:00.000Z";

type Fixture = {
  context: ChunkSyncContext;
  /** The project the session's lineage resolves to, on every sync. */
  lineageProjectId: string;
  /** The project a user files the session into by hand. */
  userProjectId: string;
  artifactId: string;
  /** What the payload claimed, and what the stored row kept. */
  sourceArtifactId: string;
  storedSourceArtifactId: string | null;
};

describeIfDb("ISS-10995: ingest writes a session's project once", () => {
  it("files a newly synced session into its lineage project", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession();

      // The payload's lineage actually landed, so the later-sync cases really
      // do re-resolve the project they claim ingest no longer re-applies.
      expect(fixture.storedSourceArtifactId).toBe(fixture.sourceArtifactId);
      await expect(readProjectId(fixture.artifactId)).resolves.toBe(
        fixture.lineageProjectId
      );
    });
  });

  it("leaves a re-filed session's project alone on a later sync", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession();
      // Stands in for the Details row's `POST /artifact-links/batch-move`; this
      // case pins only that ingest does not revert it.
      await withDb((db) =>
        db.artifact.update({
          where: { id: fixture.artifactId },
          data: { projectId: fixture.userProjectId },
          select: { id: true },
        })
      );

      await resync(fixture.context);

      const stored = await readArtifact(fixture.artifactId);
      // The update arm really ran: it rewrote a column it owns unconditionally.
      expect(stored.name).toBe(RESYNCED_NAME);
      expect(stored.projectId).toBe(fixture.userProjectId);
    });
  });

  it("fills an unfiled session's project when a later sync resolves one", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession();
      // An unparented session — what a first sync with no resolvable lineage
      // leaves behind. Without this case, "fill-only" and "never writes after
      // create" are indistinguishable.
      await withDb((db) =>
        db.artifact.update({
          where: { id: fixture.artifactId },
          data: { projectId: null },
          select: { id: true },
        })
      );

      await resync(fixture.context);

      await expect(readProjectId(fixture.artifactId)).resolves.toBe(
        fixture.lineageProjectId
      );
    });
  });
});

async function importSession(): Promise<Fixture> {
  const organizationId = await createTestOrganization();
  const uploader = await createTestUser(organizationId);
  const [lineageProjectId, userProjectId, computeTargetId] = await Promise.all([
    createTestProject(organizationId, uploader.id, { name: "Lineage project" }),
    createTestProject(organizationId, uploader.id, { name: "User project" }),
    createComputeTarget(organizationId, uploader.id, "lane-10995"),
  ]);
  const sourceArtifactId = await withDb(async (db) => {
    const document = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.DOCUMENT,
        name: "ISS-42",
        status: DocumentStatus.Draft,
        projectId: lineageProjectId,
        createdById: uploader.id,
      },
      select: { id: true },
    });
    return document.id;
  });
  const context = { organizationId, userId: uploader.id, computeTargetId };
  await ingestChunk(context, randomUUID(), {
    ...buildSessionChunk({
      externalSessionId: EXTERNAL_SESSION_ID,
      name: FIRST_NAME,
      eventIds: ["evt-0"],
    }),
    attribution: { sourceArtifactId },
  });
  const detail = await withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId: EXTERNAL_SESSION_ID,
        },
      },
      select: { artifactId: true, sourceArtifactId: true },
    })
  );
  return {
    context,
    lineageProjectId,
    userProjectId,
    artifactId: detail.artifactId,
    sourceArtifactId,
    storedSourceArtifactId: detail.sourceArtifactId,
  };
}

/** The same session, same lineage, a later batch. */
async function resync(context: ChunkSyncContext): Promise<void> {
  const detail = await withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId: context.computeTargetId,
          externalSessionId: EXTERNAL_SESSION_ID,
        },
      },
      select: { sourceArtifactId: true },
    })
  );
  await ingestChunk(context, randomUUID(), {
    ...buildSessionChunk({
      externalSessionId: EXTERNAL_SESSION_ID,
      name: RESYNCED_NAME,
      eventIds: ["evt-0", "evt-1"],
    }),
    attribution: { sourceArtifactId: detail.sourceArtifactId },
    updatedAt: RESYNCED_UPDATED_AT,
  });
}

function readArtifact(artifactId: string) {
  return withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: artifactId },
      select: { name: true, projectId: true },
    })
  );
}

async function readProjectId(artifactId: string): Promise<string | null> {
  const artifact = await readArtifact(artifactId);
  return artifact.projectId;
}
