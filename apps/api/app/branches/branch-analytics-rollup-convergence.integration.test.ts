/**
 * ISS-10817 — a tenant whose session set EXCEEDS one batch converges across
 * runs, against a REAL Postgres.
 *
 * WHAT THIS PINS, exactly: that successive runs advance — each run materializes
 * a bounded batch and the next run reaches sessions the previous one did not,
 * until the tenant drains. That is not visible to a mock, because which sessions
 * a second run reaches is decided entirely by what the first run WROTE, through
 * SQL this suite has to let Postgres execute.
 *
 * WHAT THIS DOES NOT PIN, so no reader mistakes it for guarded: the transaction
 * TIMEOUT that ISS-10817 actually fixed. `autoRollbackTransaction` opens an
 * ambient transaction and `withDb.tx` joins it rather than opening its own
 * (`packages/database/index.ts`), which drops the production
 * `BRANCH_ANALYTICS_ROLLUP_TX_TIMEOUT_MS` bound entirely — and at this fixture's
 * scale the statement is fast either way. Reverting the query rewrite in
 * `branch-analytics-rollup-refresh-reads.ts` leaves this suite green. What holds that
 * regression is the production EXPLAIN measurement recorded in that file's
 * `readSourceWatermarkAndRefreshBatch` docstring, not an assertion here.
 *
 * The fixture is deliberately built so it cannot pass by accident:
 *
 * - TWO organizations, so the write is proven ORG-SCOPED: the quiet tenant
 *   drains in full while the large one is mid-drain, and neither tenant's rows
 *   appear under the other. A single-organization fixture cannot tell a scoped
 *   write from an unscoped one.
 * - A session set spanning MORE THAN ONE batch, because a set that fits in one
 *   batch converges under the broken code too — it is exactly the shape that
 *   let the regression ship.
 * - The batch bound is passed in and pinned to a LITERAL. Deriving it from
 *   `BRANCH_ANALYTICS_ROLLUP_DEFAULT_SESSION_LIMIT` would make the fixture agree
 *   with whatever that constant says, including a value that cannot converge.
 */

import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  buildEvent,
  SEEDED_SYNCED_AT,
  seedBranch,
  seedTokenEvents,
} from "@/__tests__/support/branches/branch-analytics-rollup.test-fixtures";
import {
  autoRollbackTransactionJoining,
  createTestOrganization,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import { refreshBranchAnalyticsRollupBatch } from "@/app/branches/branch-analytics-rollup";
import { BranchAnalyticsRollupState } from "@/app/branches/branch-analytics-rollup-contract";

/**
 * ISS-11104 — this suite lets its ambient transaction absorb the nested
 * `withDb.tx` its production path opens, discarding that call's own budget.
 * The reason below is the whole statement: it is what a reviewer reads to tell
 * a suite that does not need the real boundary from one that is blind to it.
 */
const joinAmbientTransaction = autoRollbackTransactionJoining(
  "convergence is observed through what each run WROTE, which is visible inside one transaction; the per-batch commit boundary and its timeout are explicitly not pinned here, as this file's header already states, and are pinned nowhere else either"
);

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/**
 * Non-circular on purpose: a literal, never
 * `BRANCH_ANALYTICS_ROLLUP_DEFAULT_SESSION_LIMIT`. A fixture built from the
 * constant it polices agrees with that constant's own mistake, which is how a
 * batch bound that cannot drain a tenant passes its own convergence test.
 */
const BATCH_SESSION_LIMIT = 3;
/**
 * Strictly more than two batches, so the second run cannot be the last one and
 * "it converged" cannot be satisfied by a set that always fitted.
 */
const LARGE_TENANT_SESSION_COUNT = 7;
/** Small enough to drain in one visit, so starving it is unambiguous. */
const QUIET_TENANT_SESSION_COUNT = 2;

const FIRST_RUN_AT = new Date("2026-08-01T12:00:00.000Z");
const SECOND_RUN_AT = new Date("2026-08-01T12:05:00.000Z");
const THIRD_RUN_AT = new Date("2026-08-01T12:10:00.000Z");
const EVENT_AT = new Date("2026-08-01T11:00:00.000Z");
/** Seeding two organizations of sessions exceeds Prisma's 5s transaction default. */
const SEEDED_POPULATION_TX_TIMEOUT_MS = 25_000;

describeIfDb(
  "Branch analytics rollup convergence across runs (ISS-10817)",
  () => {
    it("advances to sessions the previous run did not reach, and stops re-selecting the ones it materialized", async () => {
      await joinAmbientTransaction(
        async () => {
          const tenant = await seedTenant(
            "iss10817-large",
            LARGE_TENANT_SESSION_COUNT
          );

          const first = await refreshBranchAnalyticsRollupBatch({
            organizationId: tenant.organizationId,
            sessionLimit: BATCH_SESSION_LIMIT,
            now: FIRST_RUN_AT,
          });
          const afterFirst = await materializedSessionIds(
            tenant.organizationId
          );

          // The batch is bounded: a tenant of 7 does not get materialized in
          // one visit. Without a bound this is 7 — the whole tenant in one
          // write step, which is the shape ISS-9831 measured failing
          // `prisma_P2028`, and why the session limit exists at all. It is NOT
          // this ticket's cause; ISS-10817 was the selection statement's own
          // cost, which no row bound reduces.
          expect(first.sessionsRefreshed).toBe(BATCH_SESSION_LIMIT);
          expect(afterFirst).toHaveLength(BATCH_SESSION_LIMIT);
          // Still incomplete, so the state row stays Pending with no
          // `backfill_completed_at`. Either field alone satisfies the due
          // selector's predicate, which is what brings the next cron run back
          // to this organization. The calls below name the organization
          // directly, so this assertion is the only thing pinning "remains due".
          expect(first.complete).toBe(false);
          const stateAfterFirst = await rollupState(tenant.organizationId);
          expect(stateAfterFirst?.state).toBe(
            BranchAnalyticsRollupState.Pending
          );
          expect(stateAfterFirst?.backfillCompletedAt).toBeNull();

          const second = await refreshBranchAnalyticsRollupBatch({
            organizationId: tenant.organizationId,
            sessionLimit: BATCH_SESSION_LIMIT,
            now: SECOND_RUN_AT,
          });
          const afterSecond = await materializedSessionIds(
            tenant.organizationId
          );

          // PROGRESS, not repetition. The regression re-selected the identical
          // slice forever; asserting only `sessionsRefreshed === 3` a second
          // time would pass under it, so the load-bearing assertion is that the
          // second run's sessions are DISJOINT from the first run's.
          expect(second.sessionsRefreshed).toBe(BATCH_SESSION_LIMIT);
          const secondRunSessions = afterSecond.filter(
            (id) => !afterFirst.includes(id)
          );
          expect(secondRunSessions).toHaveLength(BATCH_SESSION_LIMIT);
          expect(afterSecond).toHaveLength(BATCH_SESSION_LIMIT * 2);

          const third = await refreshBranchAnalyticsRollupBatch({
            organizationId: tenant.organizationId,
            sessionLimit: BATCH_SESSION_LIMIT,
            now: THIRD_RUN_AT,
          });
          const afterThird = await materializedSessionIds(
            tenant.organizationId
          );

          // The tail is 7 - 3 - 3 = 1, so the third run drains it and reports
          // complete. A run that kept re-attempting the first slice never gets
          // here however many times it runs.
          expect(third.sessionsRefreshed).toBe(
            LARGE_TENANT_SESSION_COUNT - BATCH_SESSION_LIMIT * 2
          );
          expect(third.complete).toBe(true);
          expect(new Set(afterThird)).toEqual(new Set(tenant.sessionIds));
        },
        { timeout: SEEDED_POPULATION_TX_TIMEOUT_MS }
      );
    });

    it("scopes each organization's refresh to its own sessions while a larger one is mid-drain", async () => {
      await joinAmbientTransaction(
        async () => {
          const large = await seedTenant(
            "iss10817-busy",
            LARGE_TENANT_SESSION_COUNT
          );
          const quiet = await seedTenant(
            "iss10817-quiet",
            QUIET_TENANT_SESSION_COUNT
          );

          await refreshBranchAnalyticsRollupBatch({
            organizationId: large.organizationId,
            sessionLimit: BATCH_SESSION_LIMIT,
            now: FIRST_RUN_AT,
          });
          const quietSummary = await refreshBranchAnalyticsRollupBatch({
            organizationId: quiet.organizationId,
            sessionLimit: BATCH_SESSION_LIMIT,
            now: FIRST_RUN_AT,
          });

          // The quiet tenant drains in full on the same tick while the large one
          // is four sessions short. Both calls name their organization and
          // share no state, so this pins ORG SCOPING only. Whether the cron
          // reaches the quiet organization at all is decided by
          // `selectDueBranchAnalyticsRollupOrganizations`, which this suite
          // never runs.
          expect(quietSummary.sessionsRefreshed).toBe(
            QUIET_TENANT_SESSION_COUNT
          );
          expect(quietSummary.complete).toBe(true);
          expect(
            new Set(await materializedSessionIds(quiet.organizationId))
          ).toEqual(new Set(quiet.sessionIds));

          // And the two organizations' rollups stay scoped to their own rows —
          // a single-tenant fixture cannot tell a scoped write from an
          // unscoped one.
          const largeMaterialized = await materializedSessionIds(
            large.organizationId
          );
          expect(largeMaterialized).toHaveLength(BATCH_SESSION_LIMIT);
          for (const sessionId of largeMaterialized) {
            expect(large.sessionIds).toContain(sessionId);
          }
        },
        { timeout: SEEDED_POPULATION_TX_TIMEOUT_MS }
      );
    });
  }
);

type SeededTenant = {
  organizationId: string;
  sessionIds: string[];
};

/** One organization whose sessions are all branch-linked and all event-bearing. */
async function seedTenant(
  label: string,
  sessionCount: number
): Promise<SeededTenant> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const branchArtifactId = await seedBranch(organizationId, label);
  const sessionIds: string[] = [];
  for (let index = 0; index < sessionCount; index += 1) {
    const sessionArtifactId = await linkValidSessionToBranch({
      organizationId,
      userId: user.id,
      branchArtifactId,
      label: `${label}-${index}`,
      lastSyncedAt: SEEDED_SYNCED_AT,
    });
    await seedTokenEvents(sessionArtifactId, [
      buildEvent({
        suffix: `${label}-${index}`,
        inputTokens: 10,
        outputTokens: 20,
        estimatedCost: 1,
        eventCreatedAt: EVENT_AT,
      }),
    ]);
    sessionIds.push(sessionArtifactId);
  }
  return { organizationId, sessionIds };
}

/** The sessions this organization currently holds rollup rows for. */
async function materializedSessionIds(
  organizationId: string
): Promise<string[]> {
  const rows = await withDb((db) =>
    db.branchAnalyticsSessionRollup.findMany({
      where: { organizationId },
      select: { sessionArtifactId: true },
      distinct: ["sessionArtifactId"],
    })
  );
  return rows.map((row) => row.sessionArtifactId);
}

/** The fields of the state row the due selector reads to decide reachability. */
function rollupState(organizationId: string) {
  return withDb((db) =>
    db.branchAnalyticsRollupState.findUnique({
      where: { organizationId },
      select: { state: true, backfillCompletedAt: true },
    })
  );
}
