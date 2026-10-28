/**
 * ISS-12251 (PLN-2176 T-1.3): a session's Owner is its artifact assignee, set
 * by the ingest CREATE arm to the uploading user and never written by the
 * UPDATE arm, so a reassignment survives every later sync. Read back through
 * the production detail read, so the T-1.2 projection is covered too.
 *
 * Two users throughout: with one, "the assignee is the uploader" and "the
 * assignee was left alone" cannot be told apart.
 */
import { randomUUID } from "node:crypto";
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { withDb } from "@repo/database";
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
  createTestUser,
  joinAmbientTransactionForSessionSyncWrites,
} from "@/__tests__/utils/db-helpers";
import { MAIN_FILE_KEY } from "@/app/agent-sessions/transcript-availability";
import { transcriptSearchIndexService } from "@/app/search/transcript-search-indexer";
import { agentSessionsService } from "../service";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const EXTERNAL_SESSION_ID = "iss-12251-assignee-session";
const FIRST_NAME = "fix/first-sync-title";
const RESYNCED_NAME = "fix/resynced-title";
const RESYNCED_UPDATED_AT = "2026-06-10T12:00:00.000Z";
const TRANSCRIPT_LINE = JSON.stringify({
  type: "user",
  message: { role: "user", content: "Fix the login bug" },
});

type Fixture = {
  context: ChunkSyncContext;
  otherUserId: string;
  artifactId: string;
};

describeIfDb("ISS-12251: ingest sets the session assignee", () => {
  it("assigns a newly synced session to its uploader", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession();

      const stored = await readOwnership(fixture.artifactId);
      expect(stored.assigneeId).toBe(fixture.context.userId);
      expect(stored.createdById).toBe(fixture.context.userId);

      const detail = await agentSessionsService.findSessionDetail({
        id: fixture.artifactId,
        organizationId: fixture.context.organizationId,
      });
      expect(detail?.assignee?.id).toBe(fixture.context.userId);
    });
  });

  it("leaves a reassigned session's assignee alone on a later sync", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession();
      // Stands in for `PATCH ownerUserId`, which writes the assignee from
      // PLN-2176 T-1.4 on; this case pins only that ingest does not revert it.
      await withDb((db) =>
        db.artifact.update({
          where: { id: fixture.artifactId },
          data: { assigneeId: fixture.otherUserId },
          select: { id: true },
        })
      );

      await ingestChunk(fixture.context, randomUUID(), {
        ...buildSessionChunk({
          externalSessionId: EXTERNAL_SESSION_ID,
          name: RESYNCED_NAME,
          eventIds: ["evt-0", "evt-1"],
        }),
        updatedAt: RESYNCED_UPDATED_AT,
      });

      const stored = await readOwnership(fixture.artifactId);
      // The update arm really ran: it rewrote a column it owns.
      expect(stored.name).toBe(RESYNCED_NAME);
      expect(stored.assigneeId).toBe(fixture.otherUserId);
    });
  });

  // PLN-2176 T-3.6: `@owner` search keys on `search_document.assignee_id`,
  // which the transcript indexer reads from the artifact assignee.
  it("indexes the synced session's search row under its assignee", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fixture = await importSession();
      const { organizationId, computeTargetId, userId } = fixture.context;
      await withDb(async (db) => {
        await db.organization.update({
          where: { id: organizationId },
          data: { searchIncludeTranscripts: true },
          select: { id: true },
        });
        await db.sessionTranscript.create({
          data: {
            organizationId,
            computeTargetId,
            externalSessionId: EXTERNAL_SESSION_ID,
            sessionDetailId: fixture.artifactId,
            sourceHarness: "claude_code",
            fileKey: MAIN_FILE_KEY,
            objectStorageKey: `${organizationId}/main.jsonl`,
            uploadStatus: TranscriptUploadStatus.Uploaded,
          },
          select: { id: true },
        });
      });

      const indexed = await transcriptSearchIndexService.index(
        {
          organizationId,
          computeTargetId,
          externalSessionId: EXTERNAL_SESSION_ID,
          fileKey: MAIN_FILE_KEY,
        },
        {
          readTranscriptBytes: () =>
            Promise.resolve(Buffer.from(TRANSCRIPT_LINE)),
        }
      );

      expect(indexed).toBe(true);
      const row = await withDb((db) =>
        db.searchDocument.findFirst({
          where: {
            organizationId,
            entityType: SearchEntityType.AgentSession,
            entityId: fixture.artifactId,
          },
          select: { assigneeId: true },
        })
      );
      expect(row?.assigneeId).toBe(userId);
    });
  });
});

async function importSession(): Promise<Fixture> {
  const organizationId = await createTestOrganization();
  const uploader = await createTestUser(organizationId);
  const other = await createTestUser(organizationId);
  const computeTargetId = await createComputeTarget(
    organizationId,
    uploader.id,
    "lane-12251"
  );
  const context = { organizationId, userId: uploader.id, computeTargetId };
  await ingestChunk(
    context,
    randomUUID(),
    buildSessionChunk({
      externalSessionId: EXTERNAL_SESSION_ID,
      name: FIRST_NAME,
      eventIds: ["evt-0"],
    })
  );
  const detail = await withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId: EXTERNAL_SESSION_ID,
        },
      },
      select: { artifactId: true },
    })
  );
  return { context, otherUserId: other.id, artifactId: detail.artifactId };
}

function readOwnership(artifactId: string) {
  return withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: artifactId },
      select: { name: true, assigneeId: true, createdById: true },
    })
  );
}
