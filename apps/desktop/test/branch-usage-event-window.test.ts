import assert from "node:assert/strict";
import test from "node:test";
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import {
  eventWindowSqlBounds,
  filterEventRowsByEventWindow,
} from "../src/main/branch/shared-branches-window.js";
import { readBranchUsageEventRows } from "../src/main/database/branch-reads.js";
import { seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";

/**
 * ISS-4941: the per-event `token_events` branch usage read must push the request
 * date window into SQL rather than hydrating the whole (highest-cardinality)
 * event corpus into the heap-capped db-host and filtering it in JS.
 *
 * Lives beside `branch-reads-contract.test.ts` rather than inside it because that
 * file sits at the 1,000-line ceiling.
 */
test("ISS-4941: readBranchUsageEventRows bounds the scan by created_at, keeping unusable timestamps", async () => {
  // The window is pushed into SQL so a windowed usage/analytics render scans only
  // its own slice of the highest-cardinality table instead of hydrating the whole
  // event corpus. The predicate is deliberately a CONSERVATIVE superset of the JS
  // window filter: a non-ISO `created_at` row must still come back, because the
  // cost-completeness fold reads exactly those as its invalid-timestamp coverage
  // signal. (`created_at` is NOT NULL, so the unusable case is a malformed
  // string, not a null.)
  await withAcDb(async (db) => {
    const s = seeder(db);
    const x = await s.branch({ branch: "feature/x" });
    await s.session("s1");
    await s.link({
      session: "s1",
      artifactId: x,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
    });
    const insertEvent = (createdAt: string) =>
      db.run(
        `INSERT INTO token_events
           (session_id, model, created_at, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cost_usd_estimated)
         VALUES ('s1', 'm1', $1, 1, 1, 0, 0, 0.1)`,
        createdAt
      );
    await insertEvent("2026-06-01T10:00:00.000Z"); // before the window
    await insertEvent("2026-06-20T10:00:00.000Z"); // in window
    await insertEvent("2026-07-30T10:00:00.000Z"); // after the window
    await insertEvent("not-a-timestamp"); // unusable instant — coverage signal
    // Shaped like an instant but impossible: SQLite rolls it forward to 03-02
    // (outside the window) while `Date.parse` rejects it. It must still come
    // back, or the usage card would claim complete cost coverage it doesn't have.
    await insertEvent("2026-02-30T10:00:00.000Z");
    // In-window instant written in offset form: chronologically 06-20T23:00Z, but
    // it sorts lexically PAST a `Z` end bound. Dropping it would understate spend.
    await insertEvent("2026-06-21T01:00:00.000+02:00");

    // Unbounded read still sees the whole population (the all-time path).
    const allEvents = await readBranchUsageEventRows(db.prisma);
    assert.equal(allEvents.length, 6);

    const windowed = await readBranchUsageEventRows(db.prisma, {
      startIso: "2026-06-10T00:00:00.000Z",
      endIso: "2026-06-30T00:00:00.000Z",
    });
    // Provable superset of the JS filter: the canonical out-of-window rows are
    // gone, every row the JS filter still has to adjudicate survived the scan.
    assert.deepEqual(windowed.map((row) => row.createdAt).sort(), [
      "2026-02-30T10:00:00.000Z",
      "2026-06-20T10:00:00.000Z",
      "2026-06-21T01:00:00.000+02:00",
      "not-a-timestamp",
    ]);

    // The invariant that makes this a pure perf change: applying the JS window
    // to the BOUNDED read yields exactly what applying it to the whole corpus
    // does, so no projected number moves.
    const request = {
      startDate: "2026-06-10T00:00:00.000Z",
      endDate: "2026-06-30T00:00:00.000Z",
    };
    assert.deepEqual(
      filterEventRowsByEventWindow(windowed, request)
        .map((row) => row.createdAt)
        .sort(),
      filterEventRowsByEventWindow(allEvents, request)
        .map((row) => row.createdAt)
        .sort()
    );

    // A half-open window bounds only the end it was given.
    const fromOnly = await readBranchUsageEventRows(db.prisma, {
      startIso: "2026-06-10T00:00:00.000Z",
    });
    assert.equal(
      fromOnly.filter((row) => row.createdAt === "2026-06-01T10:00:00.000Z")
        .length,
      0
    );
    assert.equal(
      fromOnly.filter((row) => row.createdAt === "2026-07-30T10:00:00.000Z")
        .length,
      1
    );
  });
});

test("ISS-4941: a bound or a row outside the fixed-width ISO shape fails open", async () => {
  // `Date.parse` accepts more than `toISOString()` writes, and for those extra
  // shapes lexical order is NOT chronological order — so the pushdown must
  // recognize them and decline to bound, or it drops rows the JS filter keeps
  // and windowed spend reports low (here: zero).
  await withAcDb(async (db) => {
    const s = seeder(db);
    const x = await s.branch({ branch: "feature/x" });
    await s.session("s1");
    await s.link({
      session: "s1",
      artifactId: x,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
    });
    const insertEvent = (createdAt: string) =>
      db.run(
        `INSERT INTO token_events
           (session_id, model, created_at, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cost_usd_estimated)
         VALUES ('s1', 'm1', $1, 1, 1, 0, 0, 0.1)`,
        createdAt
      );
    await insertEvent("2026-06-20T10:00:00.000Z");
    // Hour 24: SQLite echoes it back verbatim (so the round-trip arm does not
    // fire) while `Date.parse` normalizes it to 2026-06-21T00:00Z — which is
    // inside the window below, and lexically before its start.
    await insertEvent("2026-06-20T24:00:00.000Z");

    const shapeGuarded = await readBranchUsageEventRows(db.prisma, {
      startIso: "2026-06-21T00:00:00.000Z",
      endIso: "2026-06-22T00:00:00.000Z",
    });
    assert.deepEqual(
      shapeGuarded.map((row) => row.createdAt),
      ["2026-06-20T24:00:00.000Z"]
    );
    // The superset invariant holds through the JS filter, which keeps it.
    assert.equal(
      filterEventRowsByEventWindow(shapeGuarded, {
        startDate: "2026-06-21T00:00:00.000Z",
        endDate: "2026-06-22T00:00:00.000Z",
      }).length,
      1
    );

    // An expanded-year bound is reachable — `Date.parse` takes it, so it
    // survives the request-side normalization…
    const bounds = eventWindowSqlBounds({
      startDate: "2026-06-01T00:00:00.000Z",
      endDate: "+010000-01-01T00:00:00.000Z",
    });
    assert.equal(bounds?.endIso, "+010000-01-01T00:00:00.000Z");
    // …and `'2026-…' <= '+010000-…'` is FALSE byte-wise, so pushing it down
    // would drop every in-window row. Only the canonical start bound applies.
    const farFuture = await readBranchUsageEventRows(db.prisma, bounds);
    assert.deepEqual(farFuture.map((row) => row.createdAt).sort(), [
      "2026-06-20T10:00:00.000Z",
      "2026-06-20T24:00:00.000Z",
    ]);
  });
});

test("ISS-4941: the bounded read still carries the in-window malformed-token coverage signal", async () => {
  // `getSharedBranchUsage` feeds these rows to `buildDesktopBranchCostEvidence`
  // as BOTH the windowed subtotal and the `allEventRows` the `evidenceExceeded`
  // fallback derives its `Malformed` reason from. Bounding the scan re-scopes
  // that reason to the window, so the in-window corrupt row MUST still arrive —
  // otherwise a windowed card would report clean coverage over corrupt data.
  await withAcDb(async (db) => {
    const s = seeder(db);
    const x = await s.branch({ branch: "feature/x" });
    await s.session("s1");
    await s.link({
      session: "s1",
      artifactId: x,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
    });
    await db.run(
      `INSERT INTO token_events
         (session_id, model, created_at, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd_estimated)
       VALUES ('s1', 'm1', '2026-06-20T10:00:00.000Z', -5, 1, 0, 0, 0.1)`
    );

    const windowed = await readBranchUsageEventRows(db.prisma, {
      startIso: "2026-06-10T00:00:00.000Z",
      endIso: "2026-06-30T00:00:00.000Z",
    });
    assert.equal(windowed.length, 1);
    // The negative counter is clamped to 0 for display AND flagged, so the
    // completeness fold can report the corruption instead of hiding it.
    assert.equal(windowed[0]?.inputTokens, 0);
    assert.equal(windowed[0]?.tokenCountsInvalid, true);
  });
});
