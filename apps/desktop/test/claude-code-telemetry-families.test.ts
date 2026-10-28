/**
 * ISS-11322 — the six `claude_code_*` families ISS-10717 cut, folded in.
 *
 * Two defects are under test here and they are different. One is SELECTION: a
 * session whose only rows are in a previously-omitted table was never a
 * candidate, so its telemetry never left the machine, and a later write into one
 * of those tables could not make an already-delivered session owed again. The
 * other is the FOLD: three of the six carry a value rather than a count, and a
 * count of any of them is a different number wearing the same name.
 */

import assert from "node:assert/strict";
import {
  DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_ACTIVE_TIME_ROWS,
  DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_LINES_OF_CODE_ROWS,
} from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import { test } from "vitest";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import { createClaudeCodeTelemetrySyncStore } from "../src/main/database/claude-code-telemetry-sync-store.js";
import { CLAUDE_CODE_SIGNAL_SOURCES } from "../src/main/otel/claude-code-telemetry-candidates.js";
import {
  openTestDatabase,
  SESSION_ID,
  seedSession,
} from "./helpers/claude-code-otel-fixtures.js";

const SOURCE_KEY = "claude_code_telemetry:target-1";
const OLD_AT = "2026-06-18T19:00:00.000Z";
const NEWER_AT = "2026-06-18T19:10:00.000Z";

/**
 * The lane's INFRASTRUCTURE tables, which are deliberately not signal operands.
 * Named as literals rather than derived, so adding a third one cannot silently
 * shrink the expected signal count below.
 */
const LANE_INFRASTRUCTURE_TABLES = [
  "claude_code_signal_drop",
  "claude_code_telemetry_sync_cursor",
];

type Db = Awaited<ReturnType<typeof openTestDatabase>>["db"];

async function seedOtherSession(db: Db, id: string): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
     VALUES ($1, 'completed', $2, $2, 'claude', 'metered_api')`,
    id,
    "2026-06-18T18:00:00.000Z"
  );
}

/**
 * Every `claude_code_*` table that EXISTS IN THE DATABASE the query will run
 * against, read from SQLite's own catalog.
 *
 * The catalog rather than the module under test, because deriving the expected
 * list from the same constant the assertion checks would make the test pass for
 * any list at all — which is precisely the ISS-11322 defect: a list SHORTER than
 * the set of signal tables, with nothing failing when it was. The catalog is also
 * a better oracle than the schema file: it is the set of tables the union's
 * operands are actually resolved against at run time.
 */
async function claudeCodeTablesInDatabase(db: Db): Promise<string[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'claude_code_%'
      ORDER BY name ASC`
  );
  return rows.map((row) => row.name);
}

test("ISS-11322: every claude_code_* signal table is a candidate-union operand", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    const declared = await claudeCodeTablesInDatabase(db);
    const expected = declared
      .filter((name) => !LANE_INFRASTRUCTURE_TABLES.includes(name))
      .sort();
    const operands = CLAUDE_CODE_SIGNAL_SOURCES.map(([table]) => table).sort();

    // Fourteen is pinned as a NON-CIRCULAR LITERAL beside the derivation: if a
    // future schema change adds a family, this line fails and names the count,
    // rather than the two derived lists agreeing with each other about a number
    // that silently moved.
    assert.equal(expected.length, 14);
    assert.deepEqual(operands, expected);
    // Infrastructure is not a signal, and must not have been swept in to make
    // the count work out.
    for (const table of LANE_INFRASTRUCTURE_TABLES) {
      assert.ok(!operands.includes(table), `${table} must not be an operand`);
    }
  } finally {
    await cleanup();
  }
});

test("ISS-11322: a session whose ONLY rows are in a previously-omitted table is selected", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    // `claude_code_auth_event` was NOT an operand before ISS-11322, so this
    // session was invisible to the lane and its telemetry never left the
    // machine. Nothing else is seeded: if the union does not include this table,
    // there is no candidate at all.
    await db.run(
      `INSERT INTO claude_code_auth_event
         (id, session_id, observed_at, action, occurrence_key, data_revision)
       VALUES ('auth-1', $1, $2, 'login', '', 1)`,
      SESSION_ID,
      OLD_AT
    );

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    const pending = await store.loadPendingSessions(SOURCE_KEY, 10);

    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.sessionId, SESSION_ID);
    // And the rollup it builds must actually CARRY the family. A candidate that
    // builds a rollup of nothing is dropped by the has-any-rows gate and would
    // be re-selected every tick forever, delivered never.
    assert.equal(pending[0]?.session.authEventCount, 1);
  } finally {
    await cleanup();
  }
});

test("ISS-11322: a write into a previously-omitted table invalidates an existing cursor", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    await db.run(
      `INSERT INTO claude_code_cost_event
         (id, session_id, model, cost_usd, observed_at, attribution_key,
          attribution_source, data_revision)
       VALUES ('cost-1', $1, 'claude-sonnet-4-5', 1.25, $2, '', 'otel', 1)`,
      SESSION_ID,
      OLD_AT
    );
    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    const [first] = await store.loadPendingSessions(SOURCE_KEY, 10);
    assert.ok(first);
    await store.recordDelivered(SOURCE_KEY, SESSION_ID, first.observedTo);
    assert.deepEqual(await store.loadPendingSessions(SOURCE_KEY, 10), []);

    // A NEWER row in a previously-omitted table. Before ISS-11322 the watermark
    // comparison could not see this table, so the session stayed delivered and
    // this telemetry was stranded with nothing red anywhere.
    await db.run(
      `INSERT INTO claude_code_plugin_event
         (id, session_id, lifecycle, observed_at, plugin_key, data_revision)
       VALUES ('plugin-1', $1, 'installed', $2, 'k', 1)`,
      SESSION_ID,
      NEWER_AT
    );

    const owed = await store.loadPendingSessions(SOURCE_KEY, 10);
    assert.equal(owed.length, 1);
    // The watermark advances to the NEW row, not back to the cost event: a
    // narrower watermark would leave the session owed forever.
    assert.equal(owed[0]?.observedTo, NEWER_AT);
    assert.equal(owed[0]?.session.pluginEventCount, 1);
  } finally {
    await cleanup();
  }
});

test("ISS-11322: active_time reaches the wire as summed SECONDS per activity type, never a row count", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    // THREE rows across TWO activity types, and the seconds are chosen so no
    // count can impersonate a sum: user is 2 rows summing to 90, cli is 1 row of
    // 5.5. A row count would say 2 and 1; a blended total would say 95.5 under a
    // name that fits neither measurement.
    await db.run(
      `INSERT INTO claude_code_active_time
         (id, session_id, observed_at, activity_type, seconds, data_revision)
       VALUES ('at-1', $1, $2, 'user', 60, 1),
              ('at-2', $1, $3, 'user', 30, 1),
              ('at-3', $1, $2, 'cli', 5.5, 1)`,
      SESSION_ID,
      OLD_AT,
      NEWER_AT
    );

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    const [pending] = await store.loadPendingSessions(SOURCE_KEY, 10);

    // PER-FAMILY assertions, not a total: a fold that dropped one activity type
    // and got lucky on the other's arithmetic would pass a single-total check.
    const byType = new Map(
      (pending?.session.activeTime ?? []).map((row) => [
        row.activityType,
        row.seconds,
      ])
    );
    assert.equal(byType.get("user"), "90");
    assert.equal(byType.get("cli"), "5.5");
    assert.equal(byType.size, 2);
    // The ticket is explicit that a count field for this family is a failure of
    // the ticket rather than a partial pass, so the ABSENCE of one is pinned.
    assert.ok(
      !Object.hasOwn(pending?.session ?? {}, "activeTimeCount"),
      "active_time must never be carried as a row count"
    );
    assert.equal(pending?.session.activeTimeTruncated, undefined);
  } finally {
    await cleanup();
  }
});

test("ISS-11322: session_start reaches the wire as SUMMED session_count, never a row count", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    // TWO rows whose values sum to SEVEN, and neither value is 1. The table is a
    // delta counter: signal-reduction folds each `claude_code.session.count`
    // point into one row per `(observed_at, start_type)` and adds the point's
    // value into `session_count`. A row count answers 2 here, and a fold that
    // counted a single point of value 3 would answer 1 — both are a different
    // measurement wearing this family's name.
    await db.run(
      `INSERT INTO claude_code_session_start
         (id, session_id, observed_at, start_type, session_count, data_revision)
       VALUES ('ss-1', $1, $2, 'startup', 3, 1),
              ('ss-2', $1, $3, 'clear', 4, 1)`,
      SESSION_ID,
      OLD_AT,
      NEWER_AT
    );

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    const [pending] = await store.loadPendingSessions(SOURCE_KEY, 10);

    assert.equal(pending?.session.sessionStartCount, 7);
  } finally {
    await cleanup();
  }
});

test("ISS-11322: lines_of_code reaches the wire per (model, change type), never one blended sum", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    // Two models, and ADDED against REMOVED. A single scalar would be 130 — the
    // sum of two opposite-signed magnitudes published as one positive number.
    await db.run(
      `INSERT INTO claude_code_lines_of_code
         (id, session_id, model, observed_at, change_type, line_count, data_revision)
       VALUES ('loc-1', $1, 'claude-sonnet-4-5', $2, 'added', 100, 1),
              ('loc-2', $1, 'claude-sonnet-4-5', $3, 'removed', 25, 1),
              ('loc-3', $1, 'claude-opus-4-1', $2, 'added', 5, 1)`,
      SESSION_ID,
      OLD_AT,
      NEWER_AT
    );

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    const [pending] = await store.loadPendingSessions(SOURCE_KEY, 10);

    const byKey = new Map(
      (pending?.session.linesOfCode ?? []).map((row) => [
        `${row.model}/${row.changeType}`,
        row.lineCount,
      ])
    );
    assert.equal(byKey.get("claude-sonnet-4-5/added"), "100");
    assert.equal(byKey.get("claude-sonnet-4-5/removed"), "25");
    assert.equal(byKey.get("claude-opus-4-1/added"), "5");
    assert.equal(byKey.size, 3);
    assert.ok(
      !Object.hasOwn(pending?.session ?? {}, "linesOfCodeCount"),
      "lines_of_code must never be carried as a row count"
    );
  } finally {
    await cleanup();
  }
});

test("ISS-11322: session_identity reaches the wire as DIMENSIONS, never a count of 1", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    await db.run(
      `INSERT INTO claude_code_session_identity
         (session_id, observed_at, organization_id, user_account_uuid,
          identity_source, terminal_type, app_version, app_entrypoint,
          data_revision)
       VALUES ($1, $2, 'org-7', 'user-uuid-should-not-travel', 'otel',
               'iTerm.app', '2.1.3', 'cli', 1)`,
      SESSION_ID,
      OLD_AT
    );

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    const [pending] = await store.loadPendingSessions(SOURCE_KEY, 10);

    assert.deepEqual(pending?.session.identity, {
      organizationId: "org-7",
      identitySource: "otel",
      terminalType: "iTerm.app",
      appVersion: "2.1.3",
      appEntrypoint: "cli",
    });
    // The account identifier is a PERSON, not a description of the run, and the
    // wire deliberately does not carry it. Asserted on the serialized payload so
    // a field added later cannot smuggle it across without failing here.
    assert.ok(
      !JSON.stringify(pending?.session).includes("user-uuid-should-not-travel"),
      "the user account identifier must not cross this boundary"
    );
  } finally {
    await cleanup();
  }
});

test("ISS-11322: a never-recorded value-bearing family is OMITTED, a recorded-but-empty one is an empty array", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const other = "claude-otel-second-session";
    await seedOtherSession(db, other);
    // This MACHINE records active time (the first session has it) and has never
    // recorded lines of code at all. The second session has neither, so it is the
    // one that can tell the two claims apart.
    await db.run(
      `INSERT INTO claude_code_active_time
         (id, session_id, observed_at, activity_type, seconds, data_revision)
       VALUES ('at-1', $1, $2, 'user', 12, 1)`,
      SESSION_ID,
      OLD_AT
    );
    await db.run(
      `INSERT INTO claude_code_auth_event
         (id, session_id, observed_at, action, occurrence_key, data_revision)
       VALUES ('auth-2', $1, $2, 'login', '', 1)`,
      other,
      OLD_AT
    );

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    const bySession = new Map(
      (await store.loadPendingSessions(SOURCE_KEY, 10)).map((entry) => [
        entry.sessionId,
        entry.session,
      ])
    );

    // Recorded on the machine, none for THIS session: a measured empty set.
    assert.deepEqual(bySession.get(other)?.activeTime, []);
    // Never recorded on the machine: OMITTED. An empty array here would assert
    // "we measure lines of code and this session changed none", which is false.
    assert.equal(bySession.get(other)?.linesOfCode, undefined);
    assert.equal(bySession.get(SESSION_ID)?.linesOfCode, undefined);
    assert.equal(bySession.get(other)?.identity, undefined);
  } finally {
    await cleanup();
  }
});

test("ISS-11322: a cursor stamped with the previous effectiveDataRevision() reads as absent", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    await db.run(
      `INSERT INTO claude_code_active_time
         (id, session_id, observed_at, activity_type, seconds, data_revision)
       VALUES ('at-1', $1, $2, 'user', 12, 1)`,
      SESSION_ID,
      OLD_AT
    );
    // A cursor that already acknowledges the session's whole corpus, written
    // under the revision BEFORE this change. Without the revision arm this
    // session keeps a cloud rollup missing all six families behind a watermark
    // the corpus will never move past — invariant 7.
    await db.run(
      `INSERT INTO claude_code_telemetry_sync_cursor
         (source_key, session_id, synced_observed_to, rejected_attempts,
          deferred_attempts, data_revision, updated_at)
       VALUES ($1, $2, $3, 0, 0, $4, $3)`,
      SOURCE_KEY,
      SESSION_ID,
      OLD_AT,
      effectiveDataRevision() - 1
    );

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    const owed = await store.loadPendingSessions(SOURCE_KEY, 10);

    assert.equal(owed.length, 1, "a stale-revision cursor must read as absent");
    assert.equal(owed[0]?.observedTo, OLD_AT);
  } finally {
    await cleanup();
  }
});

test("ISS-11322: an active-time breakdown over the cap is flagged truncated, not returned as whole", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    // The corpus size is DERIVED FROM THE EXPORTED BOUND, so raising the cap
    // cannot quietly make this fixture stop exceeding it — which would turn the
    // assertion below into one that passes for a corpus that never crossed the
    // cap at all.
    const over = DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_ACTIVE_TIME_ROWS + 1;
    for (let i = 0; i < over; i += 1) {
      await db.run(
        `INSERT INTO claude_code_active_time
           (id, session_id, observed_at, activity_type, seconds, data_revision)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        `at-${i}`,
        SESSION_ID,
        OLD_AT,
        `activity-${i}`,
        i + 1
      );
    }

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    const [pending] = await store.loadPendingSessions(SOURCE_KEY, 10);

    // The flag is not cosmetic: without it the ingest runs its complement delete
    // and permanently removes the tail the producer could not carry, and the read
    // reports the session COMPLETE over what is left.
    assert.equal(pending?.session.activeTimeTruncated, true);
    assert.equal(
      pending?.session.activeTime?.length,
      DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_ACTIVE_TIME_ROWS
    );
  } finally {
    await cleanup();
  }
});

test("ISS-11322: a lines-of-code breakdown over the cap is flagged truncated", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const over = DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_LINES_OF_CODE_ROWS + 1;
    for (let i = 0; i < over; i += 1) {
      await db.run(
        `INSERT INTO claude_code_lines_of_code
           (id, session_id, model, observed_at, change_type, line_count, data_revision)
         VALUES ($1, $2, $3, $4, 'added', $5, 1)`,
        `loc-${i}`,
        SESSION_ID,
        `model-${i}`,
        OLD_AT,
        i + 1
      );
    }

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    const [pending] = await store.loadPendingSessions(SOURCE_KEY, 10);

    assert.equal(pending?.session.linesOfCodeTruncated, true);
    assert.equal(
      pending?.session.linesOfCode?.length,
      DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_LINES_OF_CODE_ROWS
    );
  } finally {
    await cleanup();
  }
});

test("ISS-11322: a row dropped as unrepresentable is a disclosed shortfall, not a silent shrink", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    // One representable activity type and one whose summed seconds is past the
    // `Decimal(14,3)` domain. The out-of-domain total is DROPPED rather than
    // clamped — no number could honestly stand for it — but a drop still shortens
    // the breakdown, so it must set the same flag the cap does. Without that, the
    // ingest's complement delete removes the cloud's row for that activity type
    // and the read presents the remainder as the session's whole active time.
    await db.run(
      `INSERT INTO claude_code_active_time
         (id, session_id, observed_at, activity_type, seconds, data_revision)
       VALUES ('at-ok', $1, $2, 'user', 30, 1),
              ('at-huge', $1, $2, 'cli', 999999999999, 1)`,
      SESSION_ID,
      OLD_AT
    );

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    const [pending] = await store.loadPendingSessions(SOURCE_KEY, 10);

    assert.deepEqual(pending?.session.activeTime, [
      { activityType: "user", seconds: "30" },
    ]);
    assert.equal(pending?.session.activeTimeTruncated, true);
  } finally {
    await cleanup();
  }
});

test("ISS-11322: a machine that never recorded identity omits the field rather than claiming the session has none", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const other = "claude-otel-identity-peer";
    await seedOtherSession(db, other);
    // This MACHINE records identity — the peer session has a row — so the field
    // must be PRESENT for both, as `{}` for the session without one. That `{}` is
    // the measured claim "captured here, no dimension known"; an omission would be
    // a claim about the machine, and publishing it per session is the collapse.
    await db.run(
      `INSERT INTO claude_code_session_identity
         (session_id, observed_at, organization_id, data_revision)
       VALUES ($1, $2, 'org-9', 1)`,
      other,
      OLD_AT
    );
    await db.run(
      `INSERT INTO claude_code_auth_event
         (id, session_id, observed_at, action, occurrence_key, data_revision)
       VALUES ('auth-9', $1, $2, 'login', '', 1)`,
      SESSION_ID,
      OLD_AT
    );

    const store = createClaudeCodeTelemetrySyncStore(db.prisma);
    const bySession = new Map(
      (await store.loadPendingSessions(SOURCE_KEY, 10)).map((entry) => [
        entry.sessionId,
        entry.session,
      ])
    );

    assert.deepEqual(bySession.get(SESSION_ID)?.identity, {});
    assert.equal(bySession.get(other)?.identity?.organizationId, "org-9");
  } finally {
    await cleanup();
  }
});
