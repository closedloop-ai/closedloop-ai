/**
 * ISS-5631: the dashboard plan read's PAGE WINDOW.
 *
 * `dashboard.getPlans` used to return every plan's full markdown `content` in one
 * array, so `desktop:db:get-plans` — and the `getCoreFeatures` bundle that folds
 * it — could ship the entire plan corpus across the IPC boundary on a single
 * call, even though the `desktop:db:get-plans-list` sibling (`listPlans`) had
 * always paged. This pins the window that closed it: the page size is a CEILING
 * rather than a mere default, and untrusted bounds floor instead of inverting the
 * slice.
 *
 * Split out of `dashboard-queries-contract.test.ts` rather than appended to it —
 * that file sits just under the 1,000 logical-line ceiling and adding this suite
 * pushed it over.
 *
 * Like the sibling contract tests this runs through `openSqliteAgentDatabase`
 * (the runtime + electron load), so it is a CI guard.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_DASHBOARD_PLAN_PAGE_LIMIT } from "../src/main/database/db-constants.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

const NOW = "2026-06-22T00:00:00.000Z";
const T1 = "2026-06-20T10:00:00.000Z";

test("getPlans caps the page at MAX_DASHBOARD_PLAN_PAGE_LIMIT and honors limit/offset", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-plan-window-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    // One session carrying more plans than the ceiling. Plan `i` is stamped one
    // minute later than plan `i - 1`, so the `compareIsoDesc` fold orders them
    // newest-first and the expected page at any offset is known exactly.
    const planCount = MAX_DASHBOARD_PLAN_PAGE_LIMIT + 20;
    const planAt = (i: number) =>
      new Date(Date.parse(T1) + i * 60_000).toISOString();
    const seeded = Array.from({ length: planCount }, (_, i) => ({
      content: `Plan ${i}`,
      timestamp: planAt(i),
    }));
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness, metadata)
       VALUES ($1, $1, 'inactive', $2, $2, 'claude', $3)`,
      "s-many-plans",
      T1,
      JSON.stringify({ plans: seeded })
    );
    // Newest-first: plan `planCount - 1` leads, descending by one each step.
    const expectedTitleAt = (rank: number) => `Plan ${planCount - 1 - rank}`;

    // Default window: bounded by the ceiling, NOT the full corpus.
    const defaulted = await db.dashboard.getPlans();
    assert.equal(defaulted.length, MAX_DASHBOARD_PLAN_PAGE_LIMIT);
    assert.equal(defaulted[0]?.title, expectedTitleAt(0));

    // An over-large limit is CLAMPED to the ceiling — this is what stops the
    // whole corpus from crossing IPC on one call.
    const greedy = await db.dashboard.getPlans({ limit: planCount * 10 });
    assert.equal(greedy.length, MAX_DASHBOARD_PLAN_PAGE_LIMIT);

    // A window is the slice of that same order, so page 2 continues page 1.
    const firstPage = await db.dashboard.getPlans({ limit: 5 });
    const secondPage = await db.dashboard.getPlans({ limit: 5, offset: 5 });
    assert.deepEqual(
      firstPage.map((p) => p.title),
      [0, 1, 2, 3, 4].map(expectedTitleAt)
    );
    assert.deepEqual(
      secondPage.map((p) => p.title),
      [5, 6, 7, 8, 9].map(expectedTitleAt)
    );
    // Full plan text still rides the page — the cap bounds the row count, and
    // narrowing `content` is not part of this contract.
    assert.equal(firstPage[0]?.content, expectedTitleAt(0));

    // Untrusted bounds floor instead of inverting the slice: a negative limit
    // must not read from the end, and a negative offset must not shift the page.
    const floored = await db.dashboard.getPlans({ limit: -1, offset: -5 });
    assert.deepEqual(
      floored.map((p) => p.title),
      [expectedTitleAt(0)]
    );

    // An offset past the corpus is an empty page, never a wrapped one.
    const beyond = await db.dashboard.getPlans({ offset: planCount });
    assert.deepEqual(beyond, []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
