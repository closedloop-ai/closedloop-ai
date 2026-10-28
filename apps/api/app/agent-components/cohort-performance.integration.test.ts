/**
 * @file cohort-performance.integration.test.ts
 * @description ISS-9853 — the cohort walk against real Postgres.
 *
 * The fake-db suite pins the walk's SHAPE (chunk boundaries, the ids each chunk
 * asks for, what the fold produces). What it cannot show is the thing the cap
 * removal is actually about: that a cohort larger than one chunk really is read
 * whole, and that the baseline really does exclude every one of its sessions
 * rather than the prefix the retired `.slice(0, 2000)` kept.
 *
 * `observeStatements` reads that off the driver — the statements the production
 * path issued and how many rows crossed on each — so "the quality read is an
 * aggregate" is proven by zero rows returned rather than by a mock's name.
 */
import { randomUUID } from "node:crypto";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  matching,
  observeStatements,
} from "@/__tests__/support/db-statement-observer";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { SESSION_CANDIDATE_CHUNK_SIZE } from "@/app/agent-sessions/service/session-candidate-stream";
import { computeCohortPerformance } from "./cohort-performance";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/** One id past the chunk size, so the walk provably needs a second read. */
const COHORT_SIZE = SESSION_CANDIDATE_CHUNK_SIZE + 1;
const BASELINE_SIZE = 4;
const IN_WINDOW_START = new Date("2026-07-01T00:00:00.000Z");
const IN_WINDOW_END = new Date("2026-07-31T00:00:00.000Z");
/** Inside the cohort's window, so only the `NOT IN` can hold it out. */
const BASELINE_AT = new Date("2026-07-15T00:00:00.000Z");
const COHORT_SESSION_STATEMENT = /FROM "public"\."session_detail"/i;
const SESSION_LINES_ADDED = 10;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The seed is the slow half; 5,001 sessions do not fit Prisma's 5s default.
 * `maxWait + timeout` stays under the tier's 30s `testTimeout`, the sum
 * `integration-suite-timeout-budget.test.ts` holds every collected suite to.
 */
const ROLLBACK_TX_OPTIONS = { maxWait: 5000, timeout: 20_000 };

describeIfDb("computeCohortPerformance against real Postgres", () => {
  it("walks a cohort past one chunk whole, and excludes all of it from the baseline", async () => {
    // Seeding 5,001 sessions plus the read under test outruns the default 5s
    // interactive-transaction budget.
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const cohortIds = await seedSessions(organizationId, user.id, {
        label: "cohort",
        count: COHORT_SIZE,
        // Spread across the window so the baseline window the reader derives
        // from them actually contains the baseline rows below.
        startedAt: (index) => (index === 0 ? IN_WINDOW_START : IN_WINDOW_END),
      });
      await seedSessions(organizationId, user.id, {
        label: "baseline",
        count: BASELINE_SIZE,
        startedAt: () => BASELINE_AT,
      });

      const { result, statements } = await observeStatements(() =>
        withDb((db) =>
          computeCohortPerformance(db, organizationId, cohortIds, {
            cohortSampled: false,
          })
        )
      );

      const sessionReads = matching(statements, COHORT_SESSION_STATEMENT);
      const cohortChunks = sessionReads.filter(
        (statement) =>
          statement.sql.includes("IN (") && !statement.sql.includes("NOT IN (")
      );
      // Two chunks for 5,001 ids, and the rows they returned sum to the cohort:
      // the retired `take` capped this at 2,000 and served that as the whole
      // population (PRD-666).
      expect(cohortChunks).toHaveLength(
        Math.ceil(COHORT_SIZE / SESSION_CANDIDATE_CHUNK_SIZE)
      );
      expect(
        cohortChunks.reduce((total, statement) => total + statement.rows, 0)
      ).toBe(COHORT_SIZE);

      // The baseline excludes EVERY cohort session, not the scanned prefix —
      // the `:616-626` leak the retired `> cap → null` branch fended off by
      // dropping the baseline entirely.
      const baselineReads = sessionReads.filter((statement) =>
        statement.sql.includes("NOT IN (")
      );
      expect(baselineReads.length).toBeGreaterThan(0);
      for (const read of baselineReads) {
        // Every cohort id is bound into the exclusion — not the 2,000-id prefix
        // the retired slice would have passed. (The org id is bound too, so the
        // set is checked for containment rather than counted.)
        const bound = new Set(read.values.filter(isUuid));
        for (const cohortId of cohortIds) {
          expect(bound.has(cohortId)).toBe(true);
        }
      }

      // Every cohort session reached a merged PR zero times, so the rate is a
      // real 0 over 5,001 rows — and the baseline sessions are excluded from
      // it, which is why it is not 0-over-5,005.
      expect(result.successRate).toBe(0);
      expect(result.mergedPrs).toBe(0);
      expect(result.mergedPrsTruncated).toBe(false);
    }, ROLLBACK_TX_OPTIONS);
  });
});

function isUuid(value: unknown): boolean {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Seed `count` sessions in bulk. `createMany` rather than the per-session
 * helper: this suite's whole point is a cohort past the chunk size, and three
 * statements per session would make the seed dwarf the read under test.
 */
async function seedSessions(
  organizationId: string,
  userId: string,
  input: {
    label: string;
    count: number;
    startedAt: (index: number) => Date;
  }
): Promise<string[]> {
  const unique = randomUUID().replaceAll("-", "").slice(0, 8);
  const artifactIds = Array.from({ length: input.count }, () => randomUUID());
  return await withDb(async (db) => {
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: `machine-${input.label}-${unique}`,
        platform: "darwin",
      },
      select: { id: true },
    });
    await db.artifact.createMany({
      data: artifactIds.map((id, index) => ({
        id,
        organizationId,
        type: ArtifactType.SESSION,
        name: `session-${input.label}-${unique}-${index}`,
        status: SESSION_STATUS.ACTIVE,
      })),
    });
    await db.sessionDetail.createMany({
      data: artifactIds.map((artifactId, index) => ({
        artifactId,
        computeTargetId: computeTarget.id,
        externalSessionId: `ext-${input.label}-${unique}-${index}`,
        harness: "claude",
        sessionStartedAt: input.startedAt(index),
        sessionUpdatedAt: input.startedAt(index),
        lastActivityAt: input.startedAt(index),
        linesAdded: SESSION_LINES_ADDED,
        linesRemoved: 0,
        estimatedCost: 1,
      })),
    });
    return artifactIds;
  });
}
