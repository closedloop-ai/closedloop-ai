import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";
import { openMigrationDatabase } from "../src/main/database/migration/migration-executor.js";
import { runDesktopMigrations } from "../src/main/database/migration/migration-runner.js";
import { MIGRATIONS } from "../src/main/database/migration/migrations-manifest.js";

/**
 * ISS-7229: migration `0074`'s UPGRADE BACKFILL.
 *
 * ISS-7352 shipped `claude_code_cost_event` before this column existed, so an
 * upgrading install can already hold captured cost for sessions that will never
 * be rolled up otherwise: the two runtime seams fire on a new OTel export and on
 * a transcript import, and a quiet completed run gets neither (whitlockk, #6385
 * review). Without the backfill their evidence sits in the local database while
 * the column stays NULL indefinitely.
 *
 * Driven through the REAL manifest and the REAL runner, sliced at 0074, so this
 * exercises the migration that actually ships rather than a copy of its SQL. The
 * store is stepped to the version BEFORE the column exists, seeded the way an
 * ISS-7352 install would be, and then upgraded.
 */

const MIGRATION_NAME = "0074_iss7229_session_authoritative_cost_usd";
const REQUEUE_MIGRATION_NAME = "0077_iss7229_authoritative_cost_resync_seen";
/** Everything up to and including the requeue step that follows the backfill. */
const THROUGH_REQUEUE = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((m) => m.name === REQUEUE_MIGRATION_NAME) + 1
);
const BEFORE = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((m) => m.name === MIGRATION_NAME)
);
const THROUGH = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((m) => m.name === MIGRATION_NAME) + 1
);

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function freshDb() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7229-backfill-"));
  dirs.push(dir);
  const { db } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  // The libSQL handle structurally satisfies MigrationDb (exec/query/transaction).
  return db;
}

test("0074 backfills sessions whose cost events predate the column", async () => {
  // Guard the slice, not the subject: an empty or full `BEFORE` would make every
  // assertion below meaningless, and a rename of the migration directory is
  // exactly how that would happen silently.
  assert.ok(
    BEFORE.length > 0 && THROUGH.length === BEFORE.length + 1,
    `expected ${MIGRATION_NAME} in the shipped manifest`
  );

  const db = await freshDb();
  await runDesktopMigrations(db, {
    migrations: BEFORE,
    baselineStatements: [],
    baselineMigrations: [],
    legacySentinelTable: "sessions",
  });

  // The column must not exist yet, or the upgrade under test is not an upgrade.
  const beforeColumns = await db.query<{ name: string }>(
    "SELECT name FROM pragma_table_info($1) WHERE name = $2",
    ["sessions", "authoritative_cost_usd"]
  );
  assert.equal(beforeColumns.rows.length, 0);

  // An ISS-7352 install: cost events captured for one session, none for another.
  for (const [id, name] of [
    ["captured-session", "captured"],
    ["quiet-session", "quiet"],
  ]) {
    await db.query(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, last_activity_at, harness)
       VALUES ($1, $2, 'inactive', $3, $3, $3, 'claude_code')`,
      [id, name, "2026-08-01T00:00:00.000Z"]
    );
  }
  for (const [suffix, cost] of [
    ["a", "1.25"],
    ["b", "2.50"],
  ]) {
    await db.query(
      `INSERT INTO claude_code_cost_event
         (id, session_id, model, cost_usd, observed_at, attribution_key)
       VALUES ($1, 'captured-session', 'claude-opus-4-8', $2, $3, '')`,
      [
        `evt-${suffix}`,
        cost,
        `2026-08-01T00:0${suffix === "a" ? 1 : 2}:00.000Z`,
      ]
    );
  }

  const outcome = await runDesktopMigrations(db, {
    migrations: THROUGH,
    baselineStatements: [],
    baselineMigrations: [],
    legacySentinelTable: "sessions",
  });
  assert.deepEqual(outcome.applied, [MIGRATION_NAME]);

  const rows = await db.query<{
    id: string;
    authoritative_cost_usd: number | null;
  }>("SELECT id, authoritative_cost_usd FROM sessions ORDER BY id", []);
  assert.deepEqual(
    rows.rows.map((r) => [
      r.id,
      r.authoritative_cost_usd === null
        ? null
        : Number(r.authoritative_cost_usd),
    ]),
    [
      // Summed across both of its events…
      ["captured-session", 3.75],
      // …and the session with no events stays NULL rather than becoming a
      // fabricated 0. This is the same bare-`SUM` property the runtime rollup
      // depends on, and the backfill is where a `COALESCE` would do the most
      // damage: it would stamp "Claude reported $0.00" on every pre-existing
      // session in one pass.
      ["quiet-session", null],
    ]
  );
});

// ISS-7229. 0074 recovered the figures but did not advance
// `sessions.updated_at`, and cloud delivery selects on that cursor — so every
// row it filled was invisible to sync and the recovered cost never left the
// machine. Editing 0074 would have reached nobody who had already upgraded, so
// the correction is a forward step.
//
// THAT STEP IS NOT AN `UPDATE`, and this test pins the difference. The resync
// step (`REQUEUE_MIGRATION_NAME`) was first written as the obvious one-liner —
// stamp `updated_at` wherever the cost is non-null — and marisolashgrove caught
// what a blanket bump costs on #6406: one identical instant across the whole
// affected population collapses it onto a single top watermark, which the sync
// cursor then carries as uncapped `id NOT IN (…)` placeholders on every
// incremental tick (FEA-3485). So it creates only the marker table, and the
// re-queue is `authoritative-cost-resync-heal.ts`, a bounded boot pass that
// gives each chunk its own watermark. That pass's own suite asserts the
// re-queue; what belongs here is the migration's half — that it touches no
// cursor at all.
//
// NAMED THROUGH THE CONSTANT, never by a bare four-digit prefix: this step has
// already been renumbered once (see the ordering note below), and a prefix
// written into prose does not move with it — it silently starts pointing at
// whatever unrelated migration later takes that number.
test("the resync step adds the marker table and moves no session cursor", async () => {
  // ORDERING, not adjacency. This was `=== THROUGH.length + 1`, which required
  // the resync step to be the very next migration after the column one — a
  // property no open PR can hold, because unrelated migrations land on `main`
  // continuously and get renumbered ahead of it (this one moved 0075 -> 0077
  // when 0075 and 0076 landed while the PR waited). Adjacency also has no
  // bearing on either thing this case then verifies. Both halves are still
  // pinned: the step must be FOUND, and it must come after the column.
  assert.ok(
    MIGRATIONS.some((m) => m.name === REQUEUE_MIGRATION_NAME),
    `${REQUEUE_MIGRATION_NAME} is not in the manifest — renamed or renumbered?`
  );
  assert.ok(
    THROUGH_REQUEUE.length > THROUGH.length,
    `expected ${REQUEUE_MIGRATION_NAME} to come after ${MIGRATION_NAME}`
  );

  const db = await freshDb();
  await runDesktopMigrations(db, {
    migrations: BEFORE,
    baselineStatements: [],
    baselineMigrations: [],
    legacySentinelTable: "sessions",
  });

  const SEEDED_AT = "2026-08-01T00:00:00.000Z";
  for (const [id, name] of [
    ["captured-session", "captured"],
    ["quiet-session", "quiet"],
  ]) {
    await db.query(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, last_activity_at, harness)
       VALUES ($1, $2, 'inactive', $3, $3, $3, 'claude_code')`,
      [id, name, SEEDED_AT]
    );
  }
  await db.query(
    `INSERT INTO claude_code_cost_event
       (id, session_id, model, cost_usd, observed_at, attribution_key)
     VALUES ('evt-requeue', 'captured-session', 'claude-opus-4-8', '3.75', $1, '')`,
    [SEEDED_AT]
  );

  await runDesktopMigrations(db, {
    migrations: THROUGH_REQUEUE,
    baselineStatements: [],
    baselineMigrations: [],
    legacySentinelTable: "sessions",
  });

  // The table the heal pass needs exists and starts empty — a marker means "this
  // device asked for a re-send", so the migration must never pre-populate it.
  const markers = await db.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM authoritative_cost_resync_seen",
    []
  );
  assert.equal(Number(markers.rows[0]?.n), 0);

  const rows = await db.query<{ id: string; updated_at: string }>(
    "SELECT id, updated_at FROM sessions ORDER BY id",
    []
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r.updated_at]));

  // BOTH rows keep their cursor — including the one 0074 filled. Upgrading
  // re-queues nothing; that is the boot pass's job, one bounded chunk at a time.
  assert.equal(byId.get("captured-session"), SEEDED_AT);
  assert.equal(byId.get("quiet-session"), SEEDED_AT);
});
