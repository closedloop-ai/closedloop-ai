/**
 * ISS-6050: a LIST read nulls the two SYNC-ONLY `token_events` columns
 * (`cost_summary`, `source_identity`) in SQL, instead of omitting the stream —
 * which is what PR #4850 measured at 444MB -> 139MB and then reverted (1925c666a).
 *
 * The revert was right: the stream feeds three consumers, and an outright
 * omission moves TWO values the Sessions list renders — the activity extent
 * behind `span`, and the autonomy score (`SessionAutonomyChip`). Both derive
 * from the events' `created_at`, so every mapped column is kept and those stay
 * bit-identical, while the per-event `cost_summary` blob — the dominant memory
 * term, and read only by the cloud sync payload builder — stops being SELECTed.
 *
 * These tests drive the real SQLite -> loadSyncedSessions boundary and assert
 * the parity by loading the SAME rows twice, once each way. The `ended_at IS
 * NULL` (running) cohort is asserted separately because it is the cohort the
 * ticket names as the risk: a session with no `endedAt` resolves its end anchor
 * from the activity timestamps rather than from a stored column.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

const COST_SUMMARY = JSON.stringify({
  note: "a per-event blob that the list must never materialize",
  padding: "x".repeat(512),
});

async function seedSession(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  id: string,
  endedAt: string | null
) {
  await db.run(
    `INSERT INTO sessions (id, status, started_at, updated_at, ended_at)
     VALUES (?, ?, ?, ?, ?)`,
    id,
    endedAt === null ? "active" : "inactive",
    "2026-07-10T00:00:00.000Z",
    "2026-07-10T06:00:00.000Z",
    endedAt
  );
  // Token events deliberately extend PAST the last timeline row, so they are
  // load-bearing for the extent: if the narrowed read lost them, `span` and the
  // resolved end anchor would both move.
  for (const [index, createdAt] of [
    "2026-07-10T00:30:00.000Z",
    "2026-07-10T02:00:00.000Z",
    "2026-07-10T05:30:00.000Z",
  ].entries()) {
    await db.run(
      `INSERT INTO token_events
         (session_id, model, created_at, input_tokens, output_tokens, cost_usd_estimated, cost_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      `model-${index}`,
      createdAt,
      100 + index,
      200 + index,
      0.25,
      COST_SUMMARY
    );
  }
  await db.run(
    `INSERT INTO events (id, session_id, event_type, created_at)
     VALUES (?, ?, ?, ?)`,
    `${id}-evt-1`,
    id,
    "UserPromptSubmit",
    "2026-07-10T00:10:00.000Z"
  );
  await db.run(
    `INSERT INTO events (id, session_id, event_type, created_at)
     VALUES (?, ?, ?, ?)`,
    `${id}-evt-2`,
    id,
    "PostToolUse",
    "2026-07-10T01:00:00.000Z"
  );
}

async function withSeededDb<T>(
  run: (db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6050-projection-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T06:00:00.000Z",
    });
    try {
      // "ended" carries a stored end anchor; "running" has ended_at NULL and so
      // must resolve its end from the activity timestamps — the risk cohort.
      await seedSession(db, "ended", "2026-07-10T05:00:00.000Z");
      await seedSession(db, "running", null);
      return await run(db);
    } finally {
      await db.close?.();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ISS-6050: the narrowed list read diverges from the full read in costSummary and nothing else", async () => {
  await withSeededDb(async (db) => {
    const [full] = await db.syncSource.loadSyncedSessions(
      ["ended"],
      emptyAttributionCache()
    );
    const [narrow] = await db.syncSource.loadSyncedSessions(
      ["ended"],
      emptyAttributionCache(),
      { omitTokenEventCostColumns: true }
    );
    assert.ok(full && narrow, "both reads hydrated the session");

    // The divergence is exactly ONE field, and it is pinned here rather than
    // left implicit: a narrowed event omits `costSummary` (derived from the
    // `cost_summary` column by `parseStoredTokenCostSummary`). No Sessions-list
    // surface reads it — the consumers are the cloud sync payload builder and
    // the detail projection, neither of which takes this option. Pinning it
    // means a future change that widens the divergence fails here.
    assert.ok(
      (full.tokenEvents ?? []).every((event) => "costSummary" in event),
      "the full read carries costSummary on every token event"
    );
    assert.ok(
      (narrow.tokenEvents ?? []).every((event) => !("costSummary" in event)),
      "the narrowed read OMITS costSummary — absent, never a fabricated value"
    );

    // Everything else must match exactly, including the token counts (which is
    // why the count columns are deliberately NOT nulled — see sync-source.ts).
    assert.deepEqual(
      { ...narrow, tokenEvents: stripCostSummary(narrow) },
      { ...full, tokenEvents: stripCostSummary(full) },
      "outside costSummary the narrowed hydration is identical"
    );
  });
});

test("ISS-6050: span and autonomy are identical narrow vs full, for a RUNNING session", async () => {
  await withSeededDb(async (db) => {
    const [full] = await db.syncSource.loadSyncedSessions(
      ["running"],
      emptyAttributionCache()
    );
    const [narrow] = await db.syncSource.loadSyncedSessions(
      ["running"],
      emptyAttributionCache(),
      { omitTokenEventCostColumns: true }
    );
    assert.ok(full && narrow, "both reads hydrated the running session");
    assert.equal(
      full.endedAt ?? null,
      null,
      "the cohort under test is running"
    );

    assert.deepEqual(
      narrow.span,
      full.span,
      "span is unchanged — the extent survives the narrowing"
    );
    assert.equal(
      narrow.autonomy,
      full.autonomy,
      "the autonomy score the list renders is unchanged"
    );
    assert.equal(
      narrow.wallClock,
      full.wallClock,
      "the wall-clock duration the ticket names is unchanged"
    );
    assert.equal(
      narrow.activeAgent,
      full.activeAgent,
      "the active-agent duration is unchanged"
    );
    assert.equal(
      narrow.waitingUser,
      full.waitingUser,
      "the waiting-user duration is unchanged"
    );
  });
});

test("ISS-6050: span and autonomy are identical narrow vs full, for an ENDED session", async () => {
  await withSeededDb(async (db) => {
    const [full] = await db.syncSource.loadSyncedSessions(
      ["ended"],
      emptyAttributionCache()
    );
    const [narrow] = await db.syncSource.loadSyncedSessions(
      ["ended"],
      emptyAttributionCache(),
      { omitTokenEventCostColumns: true }
    );
    assert.ok(full && narrow, "both reads hydrated the session");

    assert.deepEqual(narrow.span, full.span, "span is unchanged");
    assert.equal(narrow.autonomy, full.autonomy, "autonomy is unchanged");
    assert.equal(
      narrow.wallClock,
      full.wallClock,
      "the wall-clock duration the ticket names is unchanged"
    );
    assert.equal(
      narrow.activeAgent,
      full.activeAgent,
      "the active-agent duration is unchanged"
    );
    assert.equal(
      narrow.waitingUser,
      full.waitingUser,
      "the waiting-user duration is unchanged"
    );
  });
});

test("ISS-6050: omitEventData alone does NOT opt a caller into the narrowing", async () => {
  await withSeededDb(async (db) => {
    // The cloud sync payload builder (`token-event-sync.ts`) is the one consumer
    // of `cost_summary`/`source_identity`, and it hydrates with `omitEventData`.
    // The two options must stay independent, or the sync payload would silently
    // start shipping sessions with no per-event cost summary.
    const [lightHydrate] = await db.syncSource.loadSyncedSessions(
      ["ended"],
      emptyAttributionCache(),
      { omitEventData: true }
    );
    const [full] = await db.syncSource.loadSyncedSessions(
      ["ended"],
      emptyAttributionCache()
    );
    assert.ok(lightHydrate && full, "both reads hydrated");
    assert.deepEqual(
      lightHydrate.tokenEvents ?? [],
      full.tokenEvents ?? [],
      "omitEventData leaves the token-event stream untouched"
    );
  });
});

/** The one field a narrowed read omits; it is compared separately, above. */
function stripCostSummary(session: { tokenEvents?: readonly unknown[] }) {
  // Filtered rather than assigned `undefined`: `deepStrictEqual` distinguishes
  // an absent key from a present-but-undefined one, and absent is the shape
  // under test.
  return (session.tokenEvents ?? []).map((event) =>
    Object.fromEntries(
      Object.entries(event as Record<string, unknown>).filter(
        ([key]) => key !== "costSummary"
      )
    )
  );
}
