/**
 * ISS-6050: a LIST read drops the two SYNC-ONLY `token_events` columns
 * (`cost_summary`, `source_identity`) in SQL, instead of omitting the stream —
 * which is what PR #4850 measured at 444MB -> 139MB and then reverted (1925c666a).
 * ISS-6050 selected them as `NULL AS`; ISS-6227 omits them from the projection.
 *
 * The revert was right: the stream feeds three consumers, and an outright
 * omission moves TWO values the Sessions list renders — the activity extent
 * behind `span`, and the autonomy score (`AutonomyChip`). Both derive
 * from the events' `created_at`, so every mapped column is kept and those stay
 * bit-identical, while the two sync-only columns — the dominant memory term,
 * and read only by the cloud sync payload builder — stop being SELECTed.
 *
 * These tests drive the real SQLite -> loadSyncedSessions boundary and assert
 * the parity by loading the SAME rows twice, once each way. The `ended_at IS
 * NULL` (running) cohort is asserted separately because it is the cohort the
 * ticket names as the risk: a session with no `endedAt` resolves its end anchor
 * from the activity timestamps rather than from a stored column.
 *
 * ISS-6212: the fixture seeds BOTH sync-only columns non-null. Seeding only
 * `cost_summary` made `sourceIdentity` trivially equal across the two reads, so
 * a projection widened to keep `source_identity` stayed green here.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenSourceIdentityAvailability,
} from "@repo/api/src/types/token-cost-provenance";
import { test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { selectTokenEventRows } from "../src/main/database/token-event-columns.js";

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

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
      // EVERY projected column is seeded, non-null and off its DDL default: a
      // column left at its default reads the same nulled as unnulled, which is
      // the ISS-6212 shape wearing a different column's name.
      `INSERT INTO token_events
         (session_id, transport_id, model, created_at, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
          cost_usd_estimated, input_cost_usd_estimated, output_cost_usd_estimated,
          cache_read_cost_usd_estimated, cache_creation_cost_usd_estimated,
          cost_summary, source_identity, agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      `${id}-transport-${index}`,
      `model-${index}`,
      createdAt,
      100 + index,
      200 + index,
      300 + index,
      400 + 2 * index,
      250 + index,
      150 + index,
      0.25,
      0.11,
      0.12,
      0.13,
      0.14,
      STORED_COST_SUMMARY,
      STORED_SOURCE_IDENTITY,
      `agent-${index}`
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

test("ISS-6212: the narrowed list read diverges from the full read in costSummary and sourceIdentity and nothing else", async () => {
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

    const fullEvents = full.tokenEvents ?? [];
    const narrowEvents = narrow.tokenEvents ?? [];
    assert.equal(fullEvents.length, 3, "the seeded token events all hydrated");
    assert.equal(narrowEvents.length, 3, "the narrowed read kept every event");

    // The positive half of the omission assertions below: "absent in the
    // narrowed read" is otherwise satisfied by a column the fixture never set.
    for (const event of fullEvents) {
      assert.deepEqual(
        event.costSummary,
        COST_SUMMARY,
        "the full read carries the seeded cost summary"
      );
      assert.deepEqual(
        event.sourceIdentity,
        SOURCE_IDENTITY,
        "the full read carries the seeded source identity"
      );
    }
    for (const event of narrowEvents) {
      assert.equal(
        "costSummary" in event,
        false,
        "the narrowed read OMITS costSummary — absent, never a fabricated value"
      );
      assert.equal(
        "sourceIdentity" in event,
        false,
        "the narrowed read OMITS sourceIdentity — absent, never a fabricated value"
      );
    }

    // Everything else must match exactly, including the token counts (which is
    // why the count columns are deliberately NOT nulled — see sync-source.ts).
    assert.deepEqual(
      { ...narrow, tokenEvents: stripSyncOnlyFields(narrow) },
      { ...full, tokenEvents: stripSyncOnlyFields(full) },
      "outside the two sync-only fields the narrowed hydration is identical"
    );
  });
});

test("ISS-6212/6227: the narrowed projection OMITS both sync-only columns and drops nothing else", async () => {
  await withSeededDb(async (db) => {
    // The hydration boundary above can only see a column it seeds and maps; this
    // reads the projection's own rows, so a third column added to the omitted
    // set — or a mapped column dropped from the SELECT — fails without a fixture
    // change. Issued through the reader pool, the way hydration issues it.
    const [fullRow] = await db.prisma.read((reader) =>
      selectTokenEventRows(reader, ["ended"])
    );
    const narrowRows = await db.prisma.read((reader) =>
      selectTokenEventRows(reader, ["ended"], {
        omitTokenEventCostColumns: true,
      })
    );
    const fullRows = await db.prisma.read((reader) =>
      selectTokenEventRows(reader, ["ended"])
    );
    const [narrowRow] = narrowRows;
    assert.ok(fullRow && narrowRow, "both projections returned rows");
    assert.equal(
      narrowRows.length,
      fullRows.length,
      "narrowing changes the projection, never the row set"
    );

    assert.deepEqual(
      Object.keys(fullRow).sort(),
      PROJECTED_TOKEN_EVENT_COLUMNS,
      "the full projection selects exactly the pinned columns"
    );
    // ISS-6227: the two sync-only columns leave the result set ENTIRELY rather
    // than arriving as `NULL AS` cells. Derived from the two pinned literals, so
    // a third column joining the omitted set still fails here.
    assert.deepEqual(
      Object.keys(narrowRow).sort(),
      PROJECTED_TOKEN_EVENT_COLUMNS.filter(
        (column) => !SYNC_ONLY_COLUMNS.includes(column)
      ),
      "the narrowing omits exactly the two sync-only columns"
    );

    assert.equal(fullRow.source_identity, STORED_SOURCE_IDENTITY);
    assert.equal(fullRow.cost_summary, STORED_COST_SUMMARY);

    // Positional, not a spot-check of the two names we already know: walking the
    // pinned list is what makes a THIRD column joining the omitted set fail here.
    // The non-null leg on the full read doubles as the fixture's own guard — an
    // unseeded column cannot reach the comparison below claiming to be intact.
    const fullValues: Record<string, unknown> = { ...fullRow };
    const narrowValues: Record<string, unknown> = { ...narrowRow };
    for (const column of PROJECTED_TOKEN_EVENT_COLUMNS) {
      assert.notEqual(
        fullValues[column],
        null,
        `${column} is seeded non-null, so its absence is distinguishable`
      );
      if (SYNC_ONLY_COLUMNS.includes(column)) {
        // `hasOwn`, not a falsy check: an absent property and a NULL cell are
        // different result sets, and which one this is IS the change under test.
        assert.equal(
          Object.hasOwn(narrowRow, column),
          false,
          `${column} is absent from a narrowed row, not present-and-null`
        );
        continue;
      }
      assert.deepEqual(
        narrowValues[column],
        fullValues[column],
        `${column} survives the narrowing unchanged`
      );
    }
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

/** The fields a narrowed read omits; they are compared separately, above. */
function stripSyncOnlyFields(session: { tokenEvents?: readonly unknown[] }) {
  // Filtered rather than assigned `undefined`: `deepStrictEqual` distinguishes
  // an absent key from a present-but-undefined one, and absent is the shape
  // under test.
  return (session.tokenEvents ?? []).map((event) =>
    Object.fromEntries(
      Object.entries(event as Record<string, unknown>).filter(
        ([key]) => key !== "costSummary" && key !== "sourceIdentity"
      )
    )
  );
}

const COST_SUMMARY = {
  completeness: TokenCostCompleteness.Complete,
  subtotalUsd: 0.25,
  lanes: [{ basis: TokenCostBasis.ApiEstimated, subtotalUsd: 0.25 }],
};

const SOURCE_IDENTITY = {
  availability: TokenSourceIdentityAvailability.Available,
  scheme: "iss-6212-provider-neutral-v1",
  sourceRecordIds: ["record-1", "record-2"],
};

const STORED_COST_SUMMARY = JSON.stringify(COST_SUMMARY);
const STORED_SOURCE_IDENTITY = JSON.stringify(SOURCE_IDENTITY);

/** The columns the narrowing OMITS; every other projected column survives it. */
const SYNC_ONLY_COLUMNS = ["cost_summary", "source_identity"];

/**
 * Every `token_events` column a hydration SELECTs, spelled out here instead of
 * read from the projection: a list derived from what it polices cannot fail
 * when a column leaves it.
 */
const PROJECTED_TOKEN_EVENT_COLUMNS = [
  "agent_id",
  "cache_creation_cost_usd_estimated",
  "cache_read_cost_usd_estimated",
  "cache_read_tokens",
  "cache_write_1h_tokens",
  "cache_write_5m_tokens",
  "cache_write_tokens",
  "cost_summary",
  "cost_usd_estimated",
  "created_at",
  "input_cost_usd_estimated",
  "input_tokens",
  "model",
  "output_cost_usd_estimated",
  "output_tokens",
  "session_id",
  "source_identity",
  "transport_id",
];
