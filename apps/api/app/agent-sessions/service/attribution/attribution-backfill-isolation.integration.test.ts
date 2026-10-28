/**
 * ISS-12552: one session whose backfill fails is counted and
 * the walk continues, so a single slow or broken session cannot stall the run
 * every time it resumes.
 */
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  AttributionBackfillStatus,
  runAttributionBackfill,
} from "./attribution-backfill";

const failing = vi.hoisted(() => ({ sessionId: "" }));

vi.mock("./backfill-session-evidence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./backfill-session-evidence")>();
  return {
    ...actual,
    backfillSessionEvidence: vi.fn(
      (...args: Parameters<typeof actual.backfillSessionEvidence>) => {
        if (args[1].agentSessionId === failing.sessionId) {
          return Promise.reject(new Error("transaction timed out"));
        }
        return actual.backfillSessionEvidence(...args);
      }
    ),
  };
});

const tracker = createCommittedTestOrganizationTracker();
const organizationIds: string[] = [];

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12552 attribution backfill failure isolation",
  () => {
    afterEach(async () => {
      const ids = organizationIds.splice(0);
      await withDb((db) =>
        db.attributionBackfillRun.deleteMany({
          where: { organizationId: { in: ids } },
        })
      );
      await tracker.cleanup();
    });

    it("counts a failing session and completes the walk past it", async () => {
      const organizationId = await tracker.create();
      organizationIds.push(organizationId);
      const user = await createTestUser(organizationId);
      const sessions: string[] = [];
      for (const label of ["first", "second", "third"]) {
        sessions.push(
          await createTestSessionDetail({
            organizationId,
            userId: user.id,
            label,
          })
        );
      }
      sessions.sort();
      failing.sessionId = sessions[1] ?? "";

      const outcome = await runAttributionBackfill({
        organizationId,
        pageSize: 2,
      });

      expect(outcome.status).toBe(AttributionBackfillStatus.Completed);
      expect(outcome.counts).toMatchObject({ sessionsScanned: 3, failed: 1 });
      const run = await withDb((db) =>
        db.attributionBackfillRun.findUnique({
          where: { id: outcome.runId },
          select: { cursor: true },
        })
      );
      expect(run?.cursor).toBe(sessions[2]);
    });
  }
);
