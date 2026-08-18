/**
 * @file data-revision-rebuild-progress.test.ts
 * @description ISS-6241 — the DATA_REVISION rebuild's per-session progress
 * report, the producer half of the import splash's Compute count.
 *
 * The bar this feature lives or dies on is that the denominator is REAL. So
 * these tests assert the numbers against a population the test itself seeds,
 * and — more importantly — assert that NOTHING is reported when the pass cannot
 * substantiate a population. A fabricated total is worse than the bare activity
 * dot it replaces (ISS-5932: a `100%` once came from a `0/0`).
 *
 * The `fakeCollector` / `makePopulatedSession` helpers come from the shared
 * `normalized-session-test-utils` fixture rather than being duplicated here.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import type { DataRevisionRebuildProgress } from "../src/main/collectors/engine/data-revision-rebuild-progress.js";
import {
  fakeCollector,
  makePopulatedSession as makeSession,
} from "./normalized-session-test-utils.js";

type StaleRow = { id: string; harness: string; status: string };

function staleRows(count: number, status = "inactive"): StaleRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `iss-6241-${index}`,
    harness: "claude",
    status,
  }));
}

/**
 * Drive a rebuild over `stale` and collect every progress report it emits.
 * Sources are named to match the session ids, so each one drains exactly one
 * session from the pending set — which is what makes the numerator checkable.
 */
async function collectProgress(stale: StaleRow[]): Promise<{
  reports: DataRevisionRebuildProgress[];
  rebuilt: number;
}> {
  const reports: DataRevisionRebuildProgress[] = [];
  const collector = fakeCollector("claude", {
    sources: stale.map((row) => `/fake/${row.id}.jsonl`),
    sessionIdForSource: (source: string) =>
      String(source).replace("/fake/", "").replace(".jsonl", ""),
  });
  const result = await runDataRevisionRebuild({
    collectors: [collector],
    db: {
      listStaleRevisionSessions: async () => stale,
      rebuildSessionFromParse: () =>
        Promise.resolve({ rebuilt: true, activeRace: false }),
      deleteSessionRow: () => Promise.resolve(),
    },
    parseSource: (_collector: unknown, source: unknown) =>
      Promise.resolve([
        makeSession({
          sessionId: String(source).replace("/fake/", "").replace(".jsonl", ""),
        }),
      ]),
    reportProgress: (progress) => {
      reports.push({ ...progress });
    },
  });
  return { reports, rebuilt: result.rebuilt };
}

describe("ISS-6241 data-revision rebuild progress", () => {
  test("reports a REAL denominator: the seeded terminal-stale population", async () => {
    const { reports, rebuilt } = await collectProgress(staleRows(4));

    assert.equal(rebuilt, 4);
    assert.ok(reports.length > 0, "the pass must report progress");
    // Every report carries the same, seeded total — not a running discovery.
    assert.deepEqual(
      [...new Set(reports.map((r) => r.total))],
      [4],
      "total must be the seeded population and must not drift"
    );
    // It opens at zero-of-four and closes at four-of-four.
    assert.deepEqual(reports.at(0), { processed: 0, total: 4 });
    assert.deepEqual(reports.at(-1), { processed: 4, total: 4 });
  });

  test("the numerator only ever advances, and never passes its own total", async () => {
    const { reports } = await collectProgress(staleRows(5));

    let previous = -1;
    for (const report of reports) {
      assert.ok(
        report.processed > previous,
        `processed must strictly advance (saw ${report.processed} after ${previous})`
      );
      assert.ok(
        report.processed <= report.total,
        `processed ${report.processed} must never exceed total ${report.total}`
      );
      previous = report.processed;
    }
  });

  test("counts only sessions the pass will WORK, excluding the active ones it skips", async () => {
    // `groupTerminalStaleByHarness` drops non-terminal rows into `skippedActive`
    // and never works them. Counting them would park the number short of its own
    // total for the whole pass — the bar would say 3 of 5 and stop, forever.
    const { reports } = await collectProgress([
      ...staleRows(3),
      { id: "iss-6241-active-a", harness: "claude", status: "active" },
      { id: "iss-6241-active-b", harness: "claude", status: "active" },
    ]);

    assert.deepEqual(
      [...new Set(reports.map((r) => r.total))],
      [3],
      "the two active rows are skipped, so the population is 3, not 5"
    );
    assert.deepEqual(reports.at(-1), { processed: 3, total: 3 });
  });

  test("does not reach N of N while the repair tail still has work (ISS-6241)", async () => {
    // BUG HUNTER A, review of this PR. `processed` is `total - remaining`, so a
    // session counted as gone the instant it leaves a pending set reads as
    // FINISHED. The missing-source cohort leaves `pending` at the bulk drains
    // but is then worked by `recomputeMissingSourceRollups` and
    // `rebuildStoredComponentInvocations` — so the count hit N of N and then sat
    // there through a slow, paused repair pass. A bar pinned at 100% for minutes
    // is the same "healthy or hung?" question this ticket exists to answer.
    //
    // No source maps to these sessions, so every one of them lands in
    // missingSource and the whole population is repair-bound.
    const stale = staleRows(3);
    const reports: DataRevisionRebuildProgress[] = [];
    const seenDuringRepair: DataRevisionRebuildProgress[] = [];
    const collector = fakeCollector("claude", {
      sources: [],
      sessionIdForSource: () => null,
    });
    await runDataRevisionRebuild({
      collectors: [collector],
      db: {
        listStaleRevisionSessions: async () => stale,
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => Promise.resolve(),
        // The repair tail. Whatever the count says WHILE this runs is what the
        // user is looking at during the slow part.
        recomputeAnalyticsRollups: (ids: string[]) => {
          seenDuringRepair.push(...reports);
          return Promise.resolve({
            recomputed: ids.length,
            sessionIds: ids,
          } as never);
        },
      },
      reportProgress: (progress) => {
        reports.push({ ...progress });
      },
    });

    // While the repair tail was running, the count must NOT have claimed the
    // whole population was finished.
    assert.ok(
      seenDuringRepair.length > 0,
      "the repair tail must have observed at least one report"
    );
    assert.ok(
      seenDuringRepair.every((r) => r.processed < r.total),
      `no report may read as complete during the repair tail (saw ${JSON.stringify(seenDuringRepair)})`
    );
    // And once the tail is done, it DOES reach its total — the count must still
    // be able to finish, or it would just be dishonest in the other direction.
    assert.deepEqual(reports.at(-1), { processed: 3, total: 3 });
  });

  test("reports NOTHING when there is no population to substantiate a total", async () => {
    // The honest indeterminate case. Publishing `0 of 0` here is exactly the
    // shape ISS-5932 exists to prevent, so the pass must stay silent and let the
    // consumer keep rendering its indeterminate state.
    const { reports } = await collectProgress([]);

    assert.deepEqual(reports, []);
  });

  test("reports nothing when every stale row is skipped as active", async () => {
    // A population that exists in the query but not in the WORK. Same rule: no
    // workable sessions means no denominator, not a zero one.
    const { reports } = await collectProgress(staleRows(3, "active"));

    assert.deepEqual(reports, []);
  });

  test("stays silent when no consumer asked for progress", async () => {
    // The reporter is opt-in: a rebuild with no `reportProgress` must not pay to
    // compute a number nobody reads, and must behave exactly as before.
    const stale = staleRows(2);
    const collector = fakeCollector("claude", {
      sources: stale.map((row) => `/fake/${row.id}.jsonl`),
      sessionIdForSource: (source: string) =>
        String(source).replace("/fake/", "").replace(".jsonl", ""),
    });
    const result = await runDataRevisionRebuild({
      collectors: [collector],
      db: {
        listStaleRevisionSessions: async () => stale,
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => Promise.resolve(),
      },
      parseSource: (_collector: unknown, source: unknown) =>
        Promise.resolve([
          makeSession({
            sessionId: String(source)
              .replace("/fake/", "")
              .replace(".jsonl", ""),
          }),
        ]),
    });

    assert.equal(result.rebuilt, 2);
    assert.equal(result.staleTotal, 2);
  });
});
