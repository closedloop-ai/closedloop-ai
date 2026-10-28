/**
 * @file retention-service-walk-exactly-once.test.ts
 * @description ISS-9780 — the incomplete-generation sweep visits every eligible
 * row exactly once, across page boundaries, with ties on the ordering column and
 * a mutation interleaved mid-walk.
 *
 * WHAT THIS SITE ACTUALLY IS. `purgeIncompleteInvocationGenerationsBatch` orders
 * ASCENDING on `updatedAt` — a MUTABLE column that is also its own predicate —
 * while the sweep deletes rows underneath it. That is the shape a keyset walk
 * cannot survive. This one survives it, and not because of the tiebreaker (which
 * this ordering already carried, from FEA-3294):
 *
 *   1. the walk RESTARTS from the beginning on every iteration — there is no
 *      cursor to be invalidated by a row whose key moved;
 *   2. the DELETE repeats the selection predicate, so a row that received a
 *      fresh part between SELECT and DELETE is preserved — and by receiving it,
 *      that row also LEAVES the population (`updatedAt < cutoff` stops holding),
 *      so the next iteration is not serving it again; and
 *   3. the loop stops on `candidateCount`, NOT on `deleted`, so a batch that was
 *      entirely raced still advances instead of reading "nothing deleted" as
 *      "nothing left".
 *
 * Property 3 is the load-bearing one and the one nothing pinned, so it is what
 * this suite is causal for: inverting the stop condition to `deleted` leaves
 * eligible rows unvisited and reddens the multiset assertion below. Removing the
 * tiebreaker does NOT redden it, and this file does not claim it would — under a
 * restart-from-start walk over a monotonically shrinking population, an unstable
 * tie order changes the ORDER rows are deleted in, not WHICH rows are.
 *
 * Multiset equality of the ids actually deleted, never a count or a Set size:
 * both of those pass when one row is skipped and another is served twice.
 */
import { withDb } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import {
  INCOMPLETE_INVOCATION_GENERATION_DELETE_BATCH_SIZE,
  sessionRetentionService,
} from "./retention-service";

vi.mock("@repo/aws/transcript-storage", () => ({
  deleteTranscriptObjects: vi.fn(),
}));

const SWEEP_NOW = new Date("2026-06-26T00:00:00.000Z");

/**
 * More than two full pages, so the walk crosses more than one boundary — a
 * corpus inside a single page cannot exercise the defect at all.
 */
const CORPUS = INCOMPLETE_INVOCATION_GENERATION_DELETE_BATCH_SIZE * 2 + 50;

/**
 * Three distinct `updatedAt` values across the whole corpus, so nearly every row
 * is tied with ~83 others on the ordering column. A corpus with distinct values
 * is the vacuous version of this fixture.
 */
const TIE_BUCKETS = 3;

/** A walk that cannot terminate must fail loudly, not hang out to a timeout. */
const MAX_SWEEP_ITERATIONS = 50;

type FakeGenerationRow = {
  id: string;
  updatedAt: Date;
  activeAt: Date | null;
  completedAt: Date | null;
};

function buildCorpus(): FakeGenerationRow[] {
  const rows: FakeGenerationRow[] = [];
  for (let index = 0; index < CORPUS; index++) {
    rows.push({
      id: `gen-${String(index).padStart(4, "0")}`,
      // Deliberately NOT index-ordered: the tie bucket cycles, so the ordering
      // column and the insertion order disagree.
      updatedAt: new Date(
        SWEEP_NOW.getTime() -
          (index % TIE_BUCKETS) * 60 * 60 * 1000 -
          48 * 3600 * 1000
      ),
      activeAt: null,
      completedAt: null,
    });
  }
  return rows;
}

/** Only the parts of the Prisma args the fake table reads. */
type FakeFindManyArgs = {
  where: { updatedAt: { lt: Date } };
  orderBy: Record<string, "asc" | "desc">[];
  take: number;
};

type FakeDeleteManyArgs = {
  where: { updatedAt: { lt: Date }; id: { in: string[] } };
};

function isEligible(row: FakeGenerationRow, cutoff: Date): boolean {
  return (
    row.activeAt === null &&
    row.completedAt === null &&
    row.updatedAt.getTime() < cutoff.getTime()
  );
}

/**
 * An in-memory table that applies the `orderBy` it is handed, and breaks ties
 * ADVERSARIALLY — the tied run is reversed on alternating calls, standing in for
 * a planner free to return ties in any order it likes. Only a total ordering
 * survives it.
 */
function createFakeGenerationTable(rows: FakeGenerationRow[]) {
  const served: string[][] = [];
  let call = 0;
  return {
    served,
    findMany: vi.fn((args: FakeFindManyArgs) => {
      const cutoff: Date = args.where.updatedAt.lt;
      const eligible = rows.filter((row) => isEligible(row, cutoff));
      call += 1;
      const hostile = call % 2 === 0 ? [...eligible].reverse() : eligible;
      const orderBy: Record<string, "asc" | "desc">[] = args.orderBy;
      const sorted = [...hostile].sort((left, right) => {
        for (const term of orderBy) {
          const [key, direction] = Object.entries(term)[0] as [
            keyof FakeGenerationRow,
            "asc" | "desc",
          ];
          const leftValue =
            key === "updatedAt" ? left.updatedAt.getTime() : left.id;
          const rightValue =
            key === "updatedAt" ? right.updatedAt.getTime() : right.id;
          if (leftValue < rightValue) {
            return direction === "asc" ? -1 : 1;
          }
          if (leftValue > rightValue) {
            return direction === "asc" ? 1 : -1;
          }
        }
        return 0;
      });
      const page = sorted.slice(0, args.take).map((row) => ({ id: row.id }));
      served.push(page.map((row) => row.id));
      return Promise.resolve(page);
    }),
    deleteMany: vi.fn((args: FakeDeleteManyArgs) => {
      const cutoff: Date = args.where.updatedAt.lt;
      const targets: string[] = args.where.id.in;
      let count = 0;
      for (const id of targets) {
        const index = rows.findIndex((row) => row.id === id);
        // The guarded DELETE: a row that stopped matching between SELECT and
        // DELETE is preserved, exactly as the production predicate does.
        if (
          index >= 0 &&
          isEligible(rows[index] as FakeGenerationRow, cutoff)
        ) {
          rows.splice(index, 1);
          count += 1;
        }
      }
      return Promise.resolve({ count });
    }),
  };
}

describe("ISS-9780 — incomplete-generation sweep walk", () => {
  it("deletes every eligible row exactly once across page boundaries, under ties and a mid-walk mutation", async () => {
    const rows = buildCorpus();
    const initialIds = rows.map((row) => row.id);
    const table = createFakeGenerationTable(rows);

    // The interleaved mutation, at a KNOWN point in the read sequence rather
    // than on a timer: when the second page is selected, one row that is IN that
    // page and one row that is NOT yet visited both receive a fresh part. The
    // first must be preserved by the guarded delete; the second must leave the
    // population rather than be deleted or re-served forever.
    const racedInPage: string[] = [];
    const racedAhead: string[] = [];
    table.findMany.mockImplementation(
      ((original) => async (args: FakeFindManyArgs) => {
        const page = await original(args);
        if (table.served.length === 2) {
          const inPage = page[0]?.id;
          const ahead = rows.find(
            (row) =>
              !page.some((served: { id: string }) => served.id === row.id)
          );
          for (const target of [inPage, ahead?.id]) {
            const row = rows.find((candidate) => candidate.id === target);
            if (row) {
              row.updatedAt = SWEEP_NOW;
            }
          }
          if (inPage) {
            racedInPage.push(inPage);
          }
          if (ahead) {
            racedAhead.push(ahead.id);
          }
        }
        return page;
      })(
        table.findMany.getMockImplementation() as (
          args: FakeFindManyArgs
        ) => Promise<{ id: string }[]>
      )
    );

    let iterations = 0;
    const txSpy = vi
      .spyOn(withDb, "tx")
      .mockImplementation((callback: (tx: never) => unknown) => {
        iterations += 1;
        if (iterations > MAX_SWEEP_ITERATIONS) {
          throw new Error(
            `sweep did not converge within ${MAX_SWEEP_ITERATIONS} transactions — a cursor regression would hang here instead of failing`
          );
        }
        return Promise.resolve(
          callback({
            agentComponentInvocationGeneration: table,
            // The expired-session half of the sweep is not under test; an empty
            // first page ends that loop immediately.
            sessionDetail: { findMany: vi.fn().mockResolvedValue([]) },
          } as never)
        );
      });

    try {
      const result = await sessionRetentionService.runRetentionSweep(
        SWEEP_NOW,
        365
      );
      expect(result.exitCode).toBe(0);
    } finally {
      txSpy.mockRestore();
    }

    // The mutation actually happened, so the assertions below describe a raced
    // walk rather than a quiet one.
    expect(racedInPage).toHaveLength(1);
    expect(racedAhead).toHaveLength(1);

    const survivors = rows.map((row) => row.id);
    const deletedIds = initialIds.filter((id) => !survivors.includes(id));

    // Exactly-once: no id is deleted twice, and every id that stayed eligible
    // was deleted. Sorted-multiset equality — a count or a Set size passes when
    // one row is skipped and another duplicated.
    expect([...deletedIds].sort()).toEqual([...new Set(deletedIds)].sort());
    const expectedDeleted = initialIds
      .filter((id) => !(racedInPage.includes(id) || racedAhead.includes(id)))
      .sort();
    expect([...deletedIds].sort()).toEqual(expectedDeleted);

    // The two raced rows survive because they genuinely left the population —
    // not because the walk lost them.
    expect(survivors.sort()).toEqual([...racedInPage, ...racedAhead].sort());
  });
});
