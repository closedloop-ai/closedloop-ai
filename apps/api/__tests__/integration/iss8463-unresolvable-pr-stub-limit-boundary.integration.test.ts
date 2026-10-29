/**
 * ISS-8463 / #6241 review — the LIMIT boundary of the unresolvable-stub
 * backfill, against Postgres.
 *
 * Separate from the population-predicate suite because it asks a different
 * question: not "which rows are eligible" but "which of the eligible rows does
 * a capped run actually clear, and does the summary say so". The fixture both
 * share lives in `iss8463-stub-backfill-fixtures.ts`.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyStampBackfill,
  summarizeUnresolvableStubs,
} from "../../scripts/backfill-unresolvable-pr-stubs-queries";
import { joinAmbientTransactionForSessionSyncWrites } from "../utils/db-helpers";
import { baseFixture } from "./agent-session-pr-sync-helpers";
import {
  CUTOFF,
  NORMALIZED_REPO,
  NORMALIZED_SECOND_REPO,
  ROLLBACK_OPTIONS,
  seedInterleavedEligible,
} from "./iss8463-stub-backfill-fixtures";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

function groupsForOrg(
  population: Awaited<ReturnType<typeof summarizeUnresolvableStubs>>,
  organizationId: string
) {
  return population.groups.filter(
    (group) => group.organizationId === organizationId
  );
}

/** Cleared rows folded to one count per repo, the grain the KPI is stated at. */
function clearedByRepo(cleared: { repositoryFullName: string | null }[]) {
  const counts: Record<string, number> = Object.create(null);
  for (const row of cleared) {
    const key = row.repositoryFullName ?? "(none)";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * The defect #6241 review caught: a `LIMIT` smaller than the eligible population
 * clears only the globally oldest rows, but the summary labelled every eligible
 * row — and every eligible group — as the delivery-coverage step.
 *
 * Each case asserts the summary against what `applyStampBackfill` ACTUALLY
 * clears under the same cutoff and limit, so the two can only agree by being the
 * same window rather than by both being plausible.
 */
describeIfDb(
  "unresolvable PR stub backfill — LIMIT boundary (ISS-8463)",
  () => {
    it("eligible > LIMIT: reports the capped selection, not the population", async () => {
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const fx = await baseFixture();
        await seedInterleavedEligible(fx);

        const population = await summarizeUnresolvableStubs(CUTOFF, 3);

        expect(population.eligibleTotal).toBe(5);
        expect(population.selectedTotal).toBe(3);
        expect(population.truncated).toBe(true);
        // Two of the three oldest are in REPO and one is in SECOND_REPO, so
        // neither group's selected count equals its eligible count.
        expect(groupsForOrg(population, fx.organizationId)).toEqual([
          {
            organizationId: fx.organizationId,
            repositoryFullName: NORMALIZED_REPO,
            eligibleCount: 3n,
            selectedCount: 2n,
            desktopStubBacklog: 3n,
          },
          {
            organizationId: fx.organizationId,
            repositoryFullName: NORMALIZED_SECOND_REPO,
            eligibleCount: 2n,
            selectedCount: 1n,
            desktopStubBacklog: 2n,
          },
        ]);

        // The apply is the oracle: the projected step must be the realized one.
        const cleared = await applyStampBackfill({
          runId: randomUUID(),
          cutoff: CUTOFF,
          limit: 3,
        });
        expect(cleared).toHaveLength(population.selectedTotal);
        expect(clearedByRepo(cleared)).toEqual({
          [NORMALIZED_REPO]: 2,
          [NORMALIZED_SECOND_REPO]: 1,
        });
      }, ROLLBACK_OPTIONS);
    });

    it("eligible == LIMIT: reports the whole population and truncates nothing", async () => {
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const fx = await baseFixture();
        await seedInterleavedEligible(fx);

        const population = await summarizeUnresolvableStubs(CUTOFF, 5);

        expect(population.eligibleTotal).toBe(5);
        expect(population.selectedTotal).toBe(5);
        expect(population.truncated).toBe(false);
        for (const group of groupsForOrg(population, fx.organizationId)) {
          expect(group.selectedCount).toBe(group.eligibleCount);
        }

        const cleared = await applyStampBackfill({
          runId: randomUUID(),
          cutoff: CUTOFF,
          limit: 5,
        });
        expect(cleared).toHaveLength(5);
      }, ROLLBACK_OPTIONS);
    });

    it("eligible < LIMIT: the cap never binds and the outcome is complete", async () => {
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const fx = await baseFixture();
        await seedInterleavedEligible(fx);

        const population = await summarizeUnresolvableStubs(CUTOFF, 50);

        expect(population.eligibleTotal).toBe(5);
        expect(population.selectedTotal).toBe(5);
        // A LIMIT larger than the population truncates nothing; announcing a
        // partial outcome here would be a wrong number in the other direction.
        expect(population.truncated).toBe(false);

        const cleared = await applyStampBackfill({
          runId: randomUUID(),
          cutoff: CUTOFF,
          limit: 50,
        });
        expect(cleared).toHaveLength(5);
      }, ROLLBACK_OPTIONS);
    });
  }
);
