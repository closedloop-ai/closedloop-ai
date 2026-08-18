import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionListCursorSortKey } from "../src/main/agent-sync/agent-session-read-model.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { createSessionAttributionResolverCache } from "../src/main/session/shared-agent-sessions-api.js";
import { insertSqliteSession } from "./sqlite-session-fixtures.js";

/**
 * Goal stage 1b, against real SQLite: what the natural-order cursor page
 * SELECTS, and that a batch hydration never returns fewer rows than it was
 * asked for.
 *
 * The sibling `shared-agent-sessions-unsorted-cursor-page.test.ts` pins the
 * ROUTE (a sortless read pages in SQL instead of hydrating the corpus). This
 * pins the two things a fake source cannot: that the SQL page reproduces the
 * exact sequence the hydrated fallback was serving, and that the hydrate the
 * page then performs is row-complete across its internal chunk boundary.
 */

const HYDRATE_CHUNK_BOUNDARY_SESSIONS = 205;

async function withDatabase(
  run: (
    db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
  ) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-07T12:00:00.000Z",
  });
  try {
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("the natural-order cursor page returns the same sequence as the whole-corpus cursor rows", async () => {
  await withDatabase(async (db) => {
    await insertSqliteSession(db, "b-oldest", {
      updatedAt: "2026-06-16T12:00:00.000Z",
    });
    await insertSqliteSession(db, "a-newest", {
      updatedAt: "2026-06-19T12:00:00.000Z",
    });
    await insertSqliteSession(db, "c-middle", {
      updatedAt: "2026-06-17T12:00:00.000Z",
    });
    // A tie on `updated_at`, so the `id DESC` tiebreak is exercised rather than
    // assumed — it is half of what makes the two orders identical.
    await insertSqliteSession(db, "a-newest-tie", {
      updatedAt: "2026-06-19T12:00:00.000Z",
    });

    const fallbackOrder = (await db.syncSource.listAllSessionCursorRows()).map(
      (row) => row.id
    );
    const page = await db.syncSource.listSessionCursorPage?.({
      limit: 10,
      offset: 0,
      sortBy: SessionListCursorSortKey.Updated,
      sortDir: "desc",
    });

    // `sortSyncedSessions` leaves a sortless working set in its incoming order,
    // and that incoming order IS `listAllSessionCursorRows`. So this equality is
    // the whole parity claim of the change: a sortless read served by the page
    // sees precisely the rows, in precisely the order, it saw before.
    assert.deepEqual(
      page?.rows.map((row) => row.id),
      fallbackOrder
    );
    assert.deepEqual(fallbackOrder, [
      "a-newest-tie",
      "a-newest",
      "c-middle",
      "b-oldest",
    ]);
    assert.equal(page?.total, 4);
  });
});

test("the natural-order page slices by offset without dropping or duplicating a row", async () => {
  await withDatabase(async (db) => {
    for (let index = 0; index < 6; index++) {
      await insertSqliteSession(db, `session-${index}`, {
        updatedAt: `2026-06-${String(10 + index).padStart(2, "0")}T12:00:00.000Z`,
      });
    }

    const all = (await db.syncSource.listAllSessionCursorRows()).map(
      (row) => row.id
    );
    const pages: string[] = [];
    for (let offset = 0; offset < 6; offset += 2) {
      const page = await db.syncSource.listSessionCursorPage?.({
        limit: 2,
        offset,
        sortBy: SessionListCursorSortKey.Updated,
        sortDir: "desc",
      });
      pages.push(...(page?.rows ?? []).map((row) => row.id));
    }

    assert.deepEqual(pages, all);
    assert.equal(new Set(pages).size, 6);
  });
});

test("the natural-order page applies a window and a search, and answers past its total", async () => {
  await withDatabase(async (db) => {
    await insertSqliteSession(db, "in-window-match", {
      name: "alpha run",
      updatedAt: "2026-06-18T12:00:00.000Z",
      startedAt: "2026-06-18T12:00:00.000Z",
    });
    await insertSqliteSession(db, "in-window-miss", {
      name: "beta run",
      updatedAt: "2026-06-17T12:00:00.000Z",
      startedAt: "2026-06-17T12:00:00.000Z",
    });
    await insertSqliteSession(db, "out-of-window", {
      name: "alpha run",
      updatedAt: "2020-01-01T12:00:00.000Z",
      startedAt: "2020-01-01T12:00:00.000Z",
    });

    // Goal stage 1b made "no sort AND a window/search" a reachable route for the
    // first time: before it, a sortless read could not enter this page at all,
    // so a predicate the page silently dropped would never have been exercised.
    const page = await db.syncSource.listSessionCursorPage?.({
      limit: 10,
      offset: 0,
      sortBy: SessionListCursorSortKey.Updated,
      sortDir: "desc",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      endDate: new Date("2026-12-31T00:00:00.000Z"),
      search: "alpha",
    });

    assert.deepEqual(
      page?.rows.map((row) => row.id),
      ["in-window-match"]
    );
    assert.equal(page?.total, 1);

    // Offset AT and PAST the total answers an empty page rather than erroring or
    // wrapping, and keeps reporting the real cohort size.
    for (const offset of [1, 5]) {
      const beyond = await db.syncSource.listSessionCursorPage?.({
        limit: 10,
        offset,
        sortBy: SessionListCursorSortKey.Updated,
        sortDir: "desc",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: new Date("2026-12-31T00:00:00.000Z"),
        search: "alpha",
      });
      assert.deepEqual(beyond?.rows ?? [], []);
      assert.equal(beyond?.total, 1);
    }
  });
});

test("loadSyncedSessions returns one row per requested id across its internal chunk boundary", async () => {
  await withDatabase(async (db) => {
    const ids: string[] = [];
    for (let index = 0; index < HYDRATE_CHUNK_BOUNDARY_SESSIONS; index++) {
      const id = `chunked-session-${String(index).padStart(4, "0")}`;
      ids.push(id);
      await insertSqliteSession(db, id, {
        updatedAt: "2026-06-18T12:00:00.000Z",
      });
    }

    const loaded = await db.syncSource.loadSyncedSessions(
      ids,
      createSessionAttributionResolverCache(),
      { omitEventData: true }
    );

    // The row-completeness invariant this whole surface rests on: an EMPTY or
    // short return from `loadSyncedSessions` is read by the cloud-sync drain
    // (`agent-session-sync-service.ts`) as proof the sessions were locally
    // deleted, and it dead-letters them PERMANENTLY. So a batch read that
    // silently returns fewer rows than it was asked for is not a perf
    // regression, it is irrecoverable data loss — and the hydrate chunks
    // internally at 200 ids, which is the seam where that could first appear.
    assert.equal(loaded.length, HYDRATE_CHUNK_BOUNDARY_SESSIONS);
    assert.deepEqual(
      [...loaded.map((entry) => entry.externalSessionId)].sort(),
      [...ids].sort()
    );
  });
});
