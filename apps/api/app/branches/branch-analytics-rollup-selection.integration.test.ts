/**
 * ISS-10079 — the due-organization SELECTION against a REAL Postgres.
 *
 * Its sibling `branch-analytics-rollup.integration.test.ts` proves what ONE
 * organization's refresh computes. This file proves WHICH organizations a run
 * reaches, which is a property of the ordering alone and so has to be executed
 * by Postgres to mean anything: the defect was a `LEFT JOIN` producing a NULL
 * sort key, and no mock reproduces a join.
 *
 * Separate from that sibling rather than appended to it because the two ask
 * different questions of the same producer, and because the sibling is at the
 * file-size ceiling.
 *
 * The old ordering runs here as a control against the same rows, so neither
 * case can pass by accident on a fixture too small to starve anything.
 *
 * The clock is INJECTED, not faked, and everything runs inside
 * `autoRollbackTransaction`, so nothing persists.
 */

import { randomUUID } from "node:crypto";
import { Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransactionJoining,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import { refreshDueBranchAnalyticsRollups } from "@/app/branches/branch-analytics-rollup";
import {
  BRANCH_ANALYTICS_ROLLUP_DUE_INTERVAL_MS,
  BRANCH_ANALYTICS_ROLLUP_LAG_CEILING_MS,
  BranchAnalyticsRollupState,
} from "@/app/branches/branch-analytics-rollup-contract";
import { recordBranchAnalyticsRollupFailure } from "@/app/branches/branch-analytics-rollup-write";

/**
 * ISS-11104 — this suite lets its ambient transaction absorb the nested
 * `withDb.tx` its production path opens, discarding that call's own budget.
 * The reason below is the whole statement: it is what a reviewer reads to tell
 * a suite that does not need the real boundary from one that is blind to it.
 */
const joinAmbientTransaction = autoRollbackTransactionJoining(
  "these cases pin selection fairness across organizations, not the per-batch commit boundary or its timeout, which have no committed-fixture coverage anywhere yet"
);

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const LAG_CEILING_SECONDS = BRANCH_ANALYTICS_ROLLUP_LAG_CEILING_MS / 1000;

/**
 * ISS-10079 measured the starvation at 150 never-rolled-up organizations
 * against the production bound of 100. The seed stays above the bound used
 * below so the control query is genuinely unable to reach anything else —
 * lowering either of these numbers past the other silently stops testing it.
 */
const NEVER_ROLLED_UP_SEED_COUNT = 150;
const SWEEP_ORGANIZATION_LIMIT = 100;
const SWEEP_AT = new Date("2026-08-01T13:00:00.000Z");
/**
 * Older than any DATED cursor an ambient database plausibly holds, which puts
 * the seeded organization first among them. It is not first outright: the due
 * class orders `as_of ASC NULLS FIRST`, so an ambient state row with a NULL
 * cursor sorts ahead of this one, and the case assumes fewer of those than the
 * due class's share of the bound (~51). That is the one ambient dependency
 * left, and it is named here so a failure is read as environmental rather than
 * sent looking at the ordering.
 */
const STARVED_AS_OF = new Date("2020-01-01T00:00:00.000Z");
/** Seeded above its own reserved share so the split below is not an accident. */
const DUE_STATE_SEED_COUNT = 60;
/**
 * These two cases each seed a couple of hundred organizations, which is well
 * past Prisma's 5s transaction default under coverage instrumentation. It must
 * stay STRICTLY under the integration tier's own `testTimeout` — a bound at or
 * above it is refused by `__tests__/integration-suite-timeout-budget.test.ts`,
 * and Vitest would kill the test first anyway, leaving the transaction running
 * detached on a pooled connection.
 */
const SEEDED_POPULATION_TX_TIMEOUT_MS = 20_000;

describeIfDb(
  "due Branch analytics rollup selection fairness (ISS-10079)",
  () => {
    it("reaches a state-carrying organization that the previous merged ordering could not, once never-rolled-up organizations outnumber the bound", async () => {
      await joinAmbientTransaction(
        async () => {
          const starvedOrganizationId = await createTestOrganization();
          await seedDueRollupState(starvedOrganizationId, STARVED_AS_OF);
          await seedOrganizationsWithoutRollupState(NEVER_ROLLED_UP_SEED_COUNT);

          // Counterfactual. Verbatim the ordering ISS-10079 replaced, run against
          // the rows this case just seeded: every organization with no state row
          // joins to a NULL `as_of` and sorts ahead of every organization that has
          // one, so a full page of them leaves no slot for the starved
          // organization however old its cursor is.
          const starvedSelection = await selectWithMergedNullsFirstOrdering(
            SWEEP_AT,
            SWEEP_ORGANIZATION_LIMIT
          );
          expect(starvedSelection).toHaveLength(SWEEP_ORGANIZATION_LIMIT);
          expect(starvedSelection).not.toContain(starvedOrganizationId);

          const summary = await refreshDueBranchAnalyticsRollups({
            now: SWEEP_AT,
            organizationLimit: SWEEP_ORGANIZATION_LIMIT,
          });

          // The production path did select it: a visit stamps `as_of` with the
          // run clock unconditionally, so the advanced cursor IS the selection.
          expect(await readRollupAsOf(starvedOrganizationId)).toEqual(SWEEP_AT);
          // Only one organization here carries state, so the never-rolled-up
          // class takes the whole remainder — which is the unused-capacity half
          // of the policy, NOT its reserved share. The share is pinned by the
          // case below, where both classes outnumber their half of the bound.
          expect(summary.neverRolledUpOrganizations).toBe(
            SWEEP_ORGANIZATION_LIMIT - 1
          );
          expect(summary.organizations).toBe(SWEEP_ORGANIZATION_LIMIT);
          // The starvation signal reads a real cursor rather than a mocked one.
          // The exact arithmetic is pinned in branch-analytics-rollup-due.test.ts;
          // here it only has to be at least as old as what this case seeded,
          // because an ambient organization may carry an older cursor still.
          expect(summary.oldestDueAsOfAgeMs).toBeGreaterThanOrEqual(
            SWEEP_AT.getTime() - STARVED_AS_OF.getTime()
          );
        },
        { timeout: SEEDED_POPULATION_TX_TIMEOUT_MS }
      );
    });

    it("splits the bound evenly once both classes outnumber their reserved share, so neither can take the page from the other", async () => {
      await joinAmbientTransaction(
        async () => {
          await seedDueRollupStates(DUE_STATE_SEED_COUNT, STARVED_AS_OF);
          await seedOrganizationsWithoutRollupState(NEVER_ROLLED_UP_SEED_COUNT);

          const summary = await refreshDueBranchAnalyticsRollups({
            now: SWEEP_AT,
            organizationLimit: SWEEP_ORGANIZATION_LIMIT,
          });

          // Exactly half, and exact rather than a range on purpose: both classes
          // are seeded past their share, so ambient rows can only ADD to a class
          // that is already saturated and cannot move this number. Order either
          // class ahead of the other outright and this fails (measured: leading
          // with `class_order DESC` reddens it). It does NOT speak for which
          // class wins a TIE at equal rank — swapping the two `class_order`
          // literals leaves the 50/50 split intact, and it is the rendered-SQL
          // pin in branch-analytics-rollup-due.test.ts that holds that.
          expect(summary.organizations).toBe(SWEEP_ORGANIZATION_LIMIT);
          expect(summary.neverRolledUpOrganizations).toBe(
            SWEEP_ORGANIZATION_LIMIT / 2
          );
          expect(summary.organizationLimitReached).toBe(true);
        },
        { timeout: SEEDED_POPULATION_TX_TIMEOUT_MS }
      );
    });

    it("visits a due organization ahead of one whose refresh failed since, however much older the failed one's last good pass is", async () => {
      await joinAmbientTransaction(async () => {
        const failedOrganizationId = await createTestOrganization();
        await seedDueRollupState(failedOrganizationId, STARVED_AS_OF);
        const dueOrganizationId = await createTestOrganization();
        await seedDueRollupState(dueOrganizationId, LATER_STARVED_AS_OF);
        await recordBranchAnalyticsRollupFailure(
          failedOrganizationId,
          new Error("refresh transaction closed"),
          new Date(SWEEP_AT.getTime() - 60_000)
        );

        // A bound of one hands the only slot to the state-carrying class.
        await refreshDueBranchAnalyticsRollups({
          now: SWEEP_AT,
          organizationLimit: 1,
        });

        expect(await readRollupAsOf(dueOrganizationId)).toEqual(SWEEP_AT);
        expect(await readRollupAsOf(failedOrganizationId)).toEqual(
          STARVED_AS_OF
        );
      });
    });
  }
);

/** One day after `STARVED_AS_OF`: still older than any ambient dated cursor. */
const LATER_STARVED_AS_OF = new Date("2020-01-02T00:00:00.000Z");

/** A rollup state row that is due on every count the selection predicate tests. */
function seedDueRollupState(organizationId: string, asOf: Date): Promise<void> {
  return withDb(async (db) => {
    await db.branchAnalyticsRollupState.create({
      data: {
        organizationId,
        state: BranchAnalyticsRollupState.Stale,
        asOf,
        lagSeconds: 0,
        backfillCompletedAt: asOf,
      },
      select: { organizationId: true },
    });
  });
}

/**
 * Organizations that each carry a due rollup state row, so the state-carrying
 * class can be pushed past its reserved share. Ids are generated here rather
 * than read back, because `createMany` returns a count and the state rows need
 * the organization ids to reference.
 */
async function seedDueRollupStates(count: number, asOf: Date): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const organizationIds = Array.from({ length: count }, () => randomUUID());
  await withDb((db) =>
    db.organization.createMany({
      data: organizationIds.map((id, index) => ({
        id,
        clerkId: `org_test_iss10079_due_${suffix}_${index}`,
        name: `ISS-10079 due ${index}`,
        slug: `iss10079-due-${suffix}-${index}`,
      })),
    })
  );
  await withDb((db) =>
    db.branchAnalyticsRollupState.createMany({
      data: organizationIds.map((organizationId) => ({
        organizationId,
        state: BranchAnalyticsRollupState.Stale,
        asOf,
        lagSeconds: 0,
        backfillCompletedAt: asOf,
      })),
    })
  );
}

/** Organizations with no rollup state row at all — the class that monopolized. */
async function seedOrganizationsWithoutRollupState(
  count: number
): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  await withDb((db) =>
    db.organization.createMany({
      data: Array.from({ length: count }, (_unused, index) => ({
        clerkId: `org_test_iss10079_${suffix}_${index}`,
        name: `ISS-10079 never rolled up ${index}`,
        slug: `iss10079-${suffix}-${index}`,
      })),
    })
  );
}

/**
 * The ordering ISS-10079 replaced, kept here and nowhere else as the control
 * this case measures against. It is deliberately a copy: a control that shares
 * code with the fix cannot disagree with it.
 */
async function selectWithMergedNullsFirstOrdering(
  now: Date,
  limit: number
): Promise<string[]> {
  const staleBefore = new Date(
    now.getTime() - BRANCH_ANALYTICS_ROLLUP_DUE_INTERVAL_MS
  );
  const rows = await withDb((db) =>
    db.$queryRaw<{ organizationId: string }[]>(Prisma.sql`
      WITH due_state_organizations AS MATERIALIZED (
        SELECT state.organization_id
        FROM branch_analytics_rollup_states state
        WHERE state.state <> ${BranchAnalyticsRollupState.Fresh}
          OR state.backfill_completed_at IS NULL
          OR state.as_of IS NULL
          OR state.as_of < ${staleBefore}
          OR state.lag_seconds IS NULL
          OR state.lag_seconds > ${LAG_CEILING_SECONDS}
        ORDER BY state.as_of ASC NULLS FIRST, state.organization_id ASC
        LIMIT ${limit}
      ),
      new_state_organizations AS MATERIALIZED (
        SELECT organization.id AS organization_id
        FROM organizations organization
        WHERE NOT EXISTS (
          SELECT 1
          FROM branch_analytics_rollup_states state
          WHERE state.organization_id = organization.id
        )
        ORDER BY organization.created_at ASC, organization.id ASC
        LIMIT ${limit}
      ),
      active_organizations AS MATERIALIZED (
        SELECT organization_id FROM due_state_organizations
        UNION
        SELECT organization_id FROM new_state_organizations
      )
      SELECT active.organization_id AS "organizationId"
      FROM active_organizations active
      LEFT JOIN branch_analytics_rollup_states state
        ON state.organization_id = active.organization_id
      WHERE state.organization_id IS NULL
        OR state.state <> ${BranchAnalyticsRollupState.Fresh}
        OR state.backfill_completed_at IS NULL
        OR state.as_of IS NULL
        OR state.as_of < ${staleBefore}
        OR state.lag_seconds IS NULL
        OR state.lag_seconds > ${LAG_CEILING_SECONDS}
      ORDER BY state.as_of ASC NULLS FIRST, active.organization_id ASC
      LIMIT ${limit}
    `)
  );
  return rows.map((row) => row.organizationId);
}

async function readRollupAsOf(organizationId: string): Promise<Date | null> {
  const state = await withDb((db) =>
    db.branchAnalyticsRollupState.findUnique({
      where: { organizationId },
      select: { asOf: true },
    })
  );
  return state?.asOf ?? null;
}
