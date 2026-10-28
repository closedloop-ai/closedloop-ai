/**
 * @file retention-service-expired-walk-exactly-once.test.ts
 * @description ISS-10164 — the expired-session sweep visits every eligible row
 * exactly once across page boundaries, with ties on the ordering column and rows
 * vanishing underneath it mid-walk.
 *
 * WHAT THIS SITE IS. `purgeExpiredSessionsBatch` restarts from the beginning on
 * every iteration (there is no cursor), so what it needs to survive a shrinking
 * population is not a stable cursor but two properties this suite is causal for:
 *
 *   1. the page is TOTALLY ordered — `lastActivityAt asc` is non-unique, so the
 *      terminal `artifactId` (the `@id`) is what makes two batches agree on
 *      which rows a page contains rather than leaving it to the planner; and
 *   2. the loop stops on `candidateCount`, NOT on `deleted`, so a batch whose
 *      rows were removed by a concurrent writer between SELECT and DELETE still
 *      advances instead of reading "deleted fewer than a full page" as
 *      "the population is exhausted".
 *
 * Property 2 is the ISS-10164 defect: inverting the stop condition back to
 * `batch.deleted < SESSION_DELETE_BATCH_SIZE` leaves the whole tail of the
 * population unswept and reddens the multiset assertion below.
 *
 * The shortfall modelled here is a CONCURRENT DELETE, not a refresh spared by
 * the guarded delete. Both reach the loop the same way — the delete count comes
 * back under the page that was really consumed — and it is that understatement
 * the stop condition must not be read off. The refresh half of the guard is
 * pinned by `retention-service.test.ts`, where a survivor can be modelled
 * directly; here every candidate that survives does so because it is already
 * gone.
 *
 * Multiset equality of the ids actually deleted, never a count or a Set size:
 * both of those pass when one row is skipped and another is served twice.
 */
import { SessionOrigin, withDb } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_DELETE_BATCH_SIZE,
  sessionRetentionService,
} from "./retention-service";

vi.mock("@repo/aws/transcript-storage", () => ({
  deleteTranscriptObjects: vi.fn(),
}));

const SWEEP_NOW = new Date("2026-06-26T00:00:00.000Z");
const RETENTION_DAYS = 365;

/** More than two full pages, so the walk crosses more than one boundary. */
const CORPUS = SESSION_DELETE_BATCH_SIZE * 2 + 50;

/**
 * Three distinct `lastActivityAt` values across the whole corpus, so nearly
 * every row is tied with hundreds of others on the leading ordering key. A
 * corpus with distinct values is the vacuous version of this fixture.
 */
const TIE_BUCKETS = 3;

/** How many rows a concurrent writer removes out from under the first page. */
const CONCURRENTLY_REMOVED = 7;

/** A walk that cannot terminate must fail loudly, not hang out to a timeout. */
const MAX_SWEEP_ITERATIONS = 50;

type FakeSessionRow = {
  artifactId: string;
  computeTargetId: string;
  externalSessionId: string;
  lastActivityAt: Date;
  origin: string;
};

type OrderTerm = Record<string, "asc" | "desc">;

function buildCorpus(): FakeSessionRow[] {
  const rows: FakeSessionRow[] = [];
  for (let index = 0; index < CORPUS; index++) {
    rows.push({
      artifactId: `artifact-${String(index).padStart(4, "0")}`,
      computeTargetId: `ct-${index % 5}`,
      externalSessionId: `session-${index}`,
      // Deliberately NOT index-ordered: the tie bucket cycles, so the ordering
      // column and the insertion order disagree.
      lastActivityAt: new Date(
        SWEEP_NOW.getTime() -
          (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000 -
          (index % TIE_BUCKETS) * 60 * 60 * 1000
      ),
      origin: SessionOrigin.DESKTOP_SYNC,
    });
  }
  return rows;
}

function isExpired(row: FakeSessionRow, cutoff: Date): boolean {
  return (
    row.origin === SessionOrigin.DESKTOP_SYNC &&
    row.lastActivityAt.getTime() < cutoff.getTime()
  );
}

function orderValue(row: FakeSessionRow, key: string): number | string {
  return key === "lastActivityAt"
    ? row.lastActivityAt.getTime()
    : row.artifactId;
}

function compareByTerms(
  left: FakeSessionRow,
  right: FakeSessionRow,
  terms: readonly OrderTerm[]
): number {
  for (const term of terms) {
    const entry = Object.entries(term)[0];
    if (!entry) {
      continue;
    }
    const [key, direction] = entry as [string, "asc" | "desc"];
    const leftValue = orderValue(left, key);
    const rightValue = orderValue(right, key);
    if (leftValue < rightValue) {
      return direction === "asc" ? -1 : 1;
    }
    if (leftValue > rightValue) {
      return direction === "asc" ? 1 : -1;
    }
  }
  return 0;
}

/**
 * An in-memory `session_detail` that APPLIES the `orderBy` it is handed and
 * breaks ties ADVERSARIALLY — the eligible set is reversed on alternating calls,
 * standing in for a planner free to return a tied run in any order. Only a total
 * ordering survives it.
 *
 * `sessionDetail.findMany` serves the TWO read shapes the sweep issues per
 * batch, and they are not interchangeable: the CANDIDATE page carries the
 * expiry predicate and an `orderBy`, while the SURVIVORS probe added with the
 * ISS-10164 guarded delete carries only `artifactId: { in }` and asks which of
 * the ids it just tried to delete still have a row. Only the candidate page
 * advances the adversarial tie-break and fires the concurrent writer below;
 * treating the probe as a page would reorder the walk and re-run the race on
 * every batch.
 */
function createFakeSessionTable(rows: FakeSessionRow[]) {
  const served: string[][] = [];
  const shortfalls: Array<{ candidateCount: number; deleted: number }> = [];
  let call = 0;
  return {
    served,
    shortfalls,
    sessionDetail: {
      findMany: vi.fn(
        (args: {
          where: {
            lastActivityAt?: { lt: Date };
            artifactId?: { in: string[] };
          };
          orderBy?: OrderTerm[];
          take?: number;
        }) => {
          const probedIds = args.where.artifactId?.in;
          if (probedIds) {
            // The survivors probe. A row is spliced out of `rows` the moment
            // something deletes it, so an id still present here is one the
            // guarded delete did not take — exactly what "it still has a
            // `SessionDetail`" means on the real table.
            return Promise.resolve(
              rows
                .filter((row) => probedIds.includes(row.artifactId))
                .map((row) => ({ artifactId: row.artifactId }))
            );
          }
          const cutoff = args.where.lastActivityAt?.lt;
          if (!cutoff) {
            throw new Error(
              "fake sessionDetail.findMany got neither the expiry predicate nor a survivors probe — the sweep issues a read this fake does not model, and silently serving it would let the walk assertions below pass against a shape nobody checked"
            );
          }
          const eligible = rows.filter((row) => isExpired(row, cutoff));
          call += 1;
          const hostile = call % 2 === 0 ? [...eligible].reverse() : eligible;
          const sorted = [...hostile].sort((left, right) =>
            compareByTerms(left, right, args.orderBy ?? [])
          );
          const page = sorted.slice(0, args.take);
          served.push(page.map((row) => row.artifactId));
          // The concurrent writer: immediately after the FIRST page is selected,
          // another transaction deletes some of the rows that page is about to
          // delete. Those ids are gone before this batch's DELETE runs, so the
          // delete count comes back short of the page that was really consumed.
          if (served.length === 1) {
            for (const victim of page.slice(0, CONCURRENTLY_REMOVED)) {
              const index = rows.findIndex(
                (row) => row.artifactId === victim.artifactId
              );
              if (index >= 0) {
                rows.splice(index, 1);
              }
            }
          }
          return Promise.resolve(
            page.map((row) => ({
              artifactId: row.artifactId,
              computeTargetId: row.computeTargetId,
              externalSessionId: row.externalSessionId,
            }))
          );
        }
      ),
    },
    sessionTranscript: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    artifact: {
      deleteMany: vi.fn((args: { where: { id: { in: string[] } } }) => {
        let count = 0;
        for (const id of args.where.id.in) {
          const index = rows.findIndex((row) => row.artifactId === id);
          if (index >= 0) {
            rows.splice(index, 1);
            count += 1;
          }
        }
        const candidateCount = args.where.id.in.length;
        if (count < candidateCount) {
          shortfalls.push({ candidateCount, deleted: count });
        }
        return Promise.resolve({ count });
      }),
    },
    // The incomplete-generation half of the sweep is not under test; an empty
    // first page ends that loop immediately.
    agentComponentInvocationGeneration: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
    },
  };
}

describe("ISS-10164 — expired-session sweep walk", () => {
  it("deletes every expired row exactly once across page boundaries when a concurrent writer shortens a full page", async () => {
    const rows = buildCorpus();
    const initialIds = rows.map((row) => row.artifactId);
    const table = createFakeSessionTable(rows);

    let iterations = 0;
    const txSpy = vi
      .spyOn(withDb, "tx")
      .mockImplementation((callback: (tx: never) => unknown) => {
        iterations += 1;
        if (iterations > MAX_SWEEP_ITERATIONS) {
          throw new Error(
            `sweep did not converge within ${MAX_SWEEP_ITERATIONS} transactions — a walk regression would hang here instead of failing`
          );
        }
        return Promise.resolve(callback(table as never));
      });

    try {
      const result = await sessionRetentionService.runRetentionSweep(
        SWEEP_NOW,
        RETENTION_DAYS
      );
      expect(result.exitCode).toBe(0);
      // The sweep reports the shortfall rather than leaving an operator to infer
      // it from a small delete count.
      expect(result.summary).toContain(
        `${CONCURRENTLY_REMOVED} expired session candidate(s) vanished between select and delete`
      );
    } finally {
      txSpy.mockRestore();
    }

    // The race actually happened on a FULL page, so the assertions below
    // describe the raced walk this suite exists for rather than a quiet one.
    expect(table.shortfalls).toEqual([
      {
        candidateCount: SESSION_DELETE_BATCH_SIZE,
        deleted: SESSION_DELETE_BATCH_SIZE - CONCURRENTLY_REMOVED,
      },
    ]);

    // Exactly-once: the store is empty, so every expired row was consumed, and
    // no id was served-and-deleted twice. Sorted-multiset equality — a count or
    // a Set size passes when one row is skipped and another is duplicated.
    expect(rows).toEqual([]);
    const servedIds = table.served.flat();
    expect([...servedIds].sort()).toEqual([...new Set(servedIds)].sort());
    expect([...servedIds].sort()).toEqual([...initialIds].sort());
  });
});
