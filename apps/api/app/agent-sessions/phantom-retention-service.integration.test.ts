import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  phantomSessionWhere,
  purgePhantomSessionsBatch,
} from "./phantom-retention-service";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

describeIfDb("phantomSessionWhere pending chunk guard", () => {
  it("excludes an otherwise phantom row until its pending chunk marker clears", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const artifactId = await createTestSessionDetail({
        organizationId,
        userId: user.id,
        label: "pending-phantom",
        sessionTimestamp: new Date("2026-06-01T00:00:00.000Z"),
        cost: { pendingChunkRevision: 87 },
      });
      const cutoff = new Date("2026-06-02T00:00:00.000Z");

      const whilePending = await selectedSessionIds(cutoff, organizationId);
      expect(whilePending).not.toContain(artifactId);

      await withDb((db) =>
        db.sessionDetail.update({
          where: { artifactId },
          data: { pendingChunkRevision: null },
          select: { artifactId: true },
        })
      );

      const afterCommit = await selectedSessionIds(cutoff, organizationId);
      expect(afterCommit).toContain(artifactId);
    });
  });

  it("spares a row whose pending chunk marker lands after selection but before the delete", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const artifactId = await createTestSessionDetail({
        organizationId,
        userId: user.id,
        label: "gap-phantom",
        sessionTimestamp: new Date("2026-06-01T00:00:00.000Z"),
      });
      const cutoff = new Date("2026-06-02T00:00:00.000Z");

      const result = await withDb((db) => {
        // Chunk 0 commits inside the select→delete gap. Under READ COMMITTED
        // the DELETE sees the marker, so the executed Prisma predicate — not
        // the captured id list — is what has to spare the row.
        type SessionFindManyArgs = Parameters<
          typeof db.sessionDetail.findMany
        >[0];
        let markerApplied = false;
        const gapClient = {
          sessionDetail: {
            findMany: async (args: SessionFindManyArgs) => {
              const rows = await db.sessionDetail.findMany(args);
              if (!markerApplied) {
                markerApplied = true;
                await db.sessionDetail.update({
                  where: { artifactId },
                  data: { pendingChunkRevision: 91 },
                  select: { artifactId: true },
                });
              }
              return rows;
            },
          },
          sessionTranscript: db.sessionTranscript,
          artifact: db.artifact,
        };
        return purgePhantomSessionsBatch(
          gapClient as never,
          cutoff,
          organizationId
        );
      });

      expect(result.deleted).toBe(0);
      expect(result.deletedSessionIdsComplete).toBe(false);
      const survivor = await withDb((db) =>
        db.sessionDetail.findUnique({
          where: { artifactId },
          select: { artifactId: true },
        })
      );
      expect(survivor).not.toBeNull();
    });
  });
});

async function selectedSessionIds(
  cutoff: Date,
  organizationId: string
): Promise<string[]> {
  const sessions = await withDb((db) =>
    db.sessionDetail.findMany({
      where: phantomSessionWhere(cutoff, organizationId),
      select: { artifactId: true },
    })
  );
  return sessions.map((session) => session.artifactId);
}
