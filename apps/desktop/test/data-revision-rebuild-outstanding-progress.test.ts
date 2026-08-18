/**
 * @file data-revision-rebuild-outstanding-progress.test.ts
 * @description ISS-6241 (shafty023 review) — the rebuild's progress count must
 * not claim more completeness than the pass can substantiate.
 *
 * Two distinct defects, same family as the rest of the ticket:
 *
 * 1. `processed` is derived as `total - remaining`, and `remaining` came from
 *    the pending sets alone. Every path that took an id OUT of `pending` while
 *    deliberately leaving the row stale — a mapped `Retry` parse, an empty or
 *    unmatched parse, an unmapped source that may still own it, a session the
 *    repair tail withheld a stamp from — credited that session as PROCESSED. The
 *    pass could publish `N of N` with retry work still outstanding.
 *
 * 2. The batch path drained every stale session inside one call and reported
 *    only after it returned. OpenCode's rebuild source is a single
 *    `opencode.db`, so a large rebuild sat at `0 of N` for the whole pass and
 *    then jumped to `N of N`.
 *
 * These live in their own file rather than in `data-revision-rebuild.test.ts`,
 * which is at its grandfathered size ceiling.
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

function staleRows(count: number, prefix = "iss-6241-out"): StaleRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    harness: "claude",
    status: "inactive",
  }));
}

function sessionIdFromSource(source: unknown): string {
  return String(source).replace("/fake/", "").replace(".jsonl", "");
}

describe("ISS-6241 outstanding retry work is never counted as processed", () => {
  test("a mapped Retry parse failure does not reach N of N", async () => {
    // A non-parser-output throw is classified `Retry`: transient, so the row
    // keeps its stale revision and a later pass re-selects it. It leaves
    // `pending` all the same, which is what used to credit it as finished.
    const stale = staleRows(3);
    const reports: DataRevisionRebuildProgress[] = [];
    const collector = fakeCollector("claude", {
      sources: stale.map((row) => `/fake/${row.id}.jsonl`),
      sessionIdForSource: (source: string) => sessionIdFromSource(source),
    });

    await runDataRevisionRebuild({
      collectors: [collector],
      db: {
        listStaleRevisionSessions: async () => stale,
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => Promise.resolve(),
      },
      parseSource: (_collector: unknown, source: unknown) => {
        if (sessionIdFromSource(source) === stale[0].id) {
          return Promise.reject(new Error("transient read failure"));
        }
        return Promise.resolve([
          makeSession({ sessionId: sessionIdFromSource(source) }),
        ]);
      },
      reportProgress: (progress) => {
        reports.push({ ...progress });
      },
    });

    // `at(-1)` is undefined for an empty report list, which fails this same
    // assertion — a pass that published nothing is not a pass at 2 of 3.
    assert.deepEqual(
      reports.at(-1),
      { processed: 2, total: 3 },
      "the retryable session must stay outstanding, not be counted as done"
    );
  });

  test("an unmapped source that may still own its ids does not reach N of N", async () => {
    // An empty parse from a surviving batch source is NOT proof those ids have
    // no source, so the pass withholds missing-source fallback and retries on a
    // later boot. That withholding is precisely what makes them outstanding.
    const stale = staleRows(3);
    const reports: DataRevisionRebuildProgress[] = [];
    const collector = fakeCollector("claude", {
      batch: true,
      sources: ["/fake/opencode.db"],
      listSourcesForRebuild: () => ["/fake/opencode.db"],
    });

    await runDataRevisionRebuild({
      collectors: [collector],
      db: {
        listStaleRevisionSessions: async () => stale,
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => Promise.resolve(),
      },
      // The batch source survives but yields nothing this pass.
      parseSource: () => Promise.resolve([]),
      reportProgress: (progress) => {
        reports.push({ ...progress });
      },
    });

    assert.ok(
      reports.every((report) => report.processed < report.total),
      `no report may claim completion while every id is still retryable (saw ${JSON.stringify(reports)})`
    );
  });

  test("a partial repair leaves the withheld sessions outstanding", async () => {
    // ISS-6165 made the stamp gate per-session, so a partial failure retires the
    // sessions that repaired and leaves the rest stale. The count must agree
    // with that: `repairTailComplete` retires the repair cohorts wholesale, so
    // the withheld ids have to be tracked separately or the pass publishes
    // `N of N` while its own log names the failures.
    const stale = staleRows(4);
    const reports: DataRevisionRebuildProgress[] = [];
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
        // One of the four fails its rollup recompute and is withheld from the
        // stamp — it stays stale and retryable.
        recomputeAnalyticsRollups: (ids: string[]) =>
          Promise.resolve({
            recomputed: ids.length - 1,
            failed: 1,
            attempted: ids.length,
            committed: ids.length - 1,
            sessionIds: ids.slice(1),
            failedSessionIds: [ids[0]],
          } as never),
      },
      reportProgress: (progress) => {
        reports.push({ ...progress });
      },
    });

    assert.deepEqual(
      reports.at(-1),
      { processed: 3, total: 4 },
      "the session the repair withheld must not be counted as repaired"
    );
  });
});

describe("ISS-6241 the batch path reports live, not 0-then-N", () => {
  test("emits per-session progress inside a single-source batch drain", async () => {
    // OpenCode's whole rebuild is one `opencode.db`, so the batch loop IS the
    // pass. Reporting only after it returned meant a long rebuild showed no
    // movement at all and then completed in one jump.
    const stale = staleRows(5, "iss-6241-batch");
    const reports: DataRevisionRebuildProgress[] = [];
    const collector = fakeCollector("claude", {
      batch: true,
      sources: ["/fake/opencode.db"],
      listSourcesForRebuild: () => ["/fake/opencode.db"],
    });

    await runDataRevisionRebuild({
      collectors: [collector],
      db: {
        listStaleRevisionSessions: async () => stale,
        rebuildSessionFromParse: () =>
          Promise.resolve({ rebuilt: true, activeRace: false }),
        deleteSessionRow: () => Promise.resolve(),
      },
      // One source, every stale session inside it — the OpenCode shape.
      parseSource: () =>
        Promise.resolve(stale.map((row) => makeSession({ sessionId: row.id }))),
      reportProgress: (progress) => {
        reports.push({ ...progress });
      },
    });

    // The defect published exactly two distinct numerators: 0, then 5. Live
    // progress means the intermediate positions are actually observable.
    const numerators = [...new Set(reports.map((report) => report.processed))];
    assert.deepEqual(
      numerators,
      [0, 1, 2, 3, 4, 5],
      "every per-session transition inside the batch must be reported"
    );
  });
});
