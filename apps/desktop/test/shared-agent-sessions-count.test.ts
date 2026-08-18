import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import type { SharedAgentSessionsListRequest } from "../src/shared/shared-agent-sessions-contract.js";

// FEA-4142: the count-only badge read must answer with a single SQL `COUNT(*)`
// (`source.countSessions`) that reproduces the hydrated `matchesQuery` total the
// old full-corpus fallback produced — byte-for-byte, across the status /
// completion-bound / ownership dimensions the badge and the Sessions filter use.
// The reference path is the SAME source with `countSessions` stripped, which
// falls back to `listAllSessionCursorRows` + `loadSyncedSessions` +
// `matchesListQuery`.

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

type SeedSession = {
  id: string;
  status: string;
  startedAt: string;
  endedAt?: string | null;
  awaitingInputSince?: string | null;
  harness?: string | null;
  userId?: string | null;
};

// The user's "last opened Agents" instant. The badge counts sessions completed
// (terminal `ended_at`) at or after this.
const VISIT = "2026-03-12T00:00:00.000Z";

async function insertSession(db: SqliteDb, seed: SeedSession): Promise<void> {
  await db.run(
    `INSERT INTO sessions
       (id, status, started_at, updated_at, ended_at, harness, billing_mode, awaiting_input_since, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    seed.id,
    seed.status,
    seed.startedAt,
    "2026-06-01T00:00:00.000Z",
    seed.endedAt ?? null,
    seed.harness ?? "claude",
    "api",
    seed.awaitingInputSince ?? null,
    seed.userId ?? null
  );
}

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "agent-dashboard-sqlite-count-")
  );
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => "2026-06-07T12:00:00.000Z",
  });
  return { db, dir };
}

/*
 * ISS-4654: a row still carrying a RETIRED spelling, seeded on purpose.
 *
 * The rest of the corpus is canonical, which is correct — migration 0042 runs at
 * boot, so a real local store has none of these. But canonicalizing the whole
 * corpus is exactly what let a parity break through review: the SQL count
 * predicate (`buildUsageStatusPredicate`) and the hydrated matcher
 * (`matchesStatusFilter`) are twins, and dropping the legacy expansion from ONE
 * of them returns a total the list cannot produce. With no straggler in the
 * fixture there was no input that could tell the two apart.
 *
 * This row is that input. It is NOT an assertion that stragglers exist — it is
 * the probe that keeps the two predicates honest about agreeing, whatever they
 * agree ON. If a future change re-expands one side, the parity loop below fails.
 */
async function seedRetiredSpellingStraggler(db: SqliteDb): Promise<void> {
  await insertSession(db, {
    id: "straggler-retired-spelling",
    status: "completed",
    startedAt: "2026-03-10T10:00:00.000Z",
    endedAt: "2026-03-13T10:30:00.000Z",
  });
}

async function seedCorpus(db: SqliteDb): Promise<void> {
  // completed, ended AT/AFTER the visit → counted by the badge.
  await insertSession(db, {
    id: "c-after-1",
    status: "inactive",
    startedAt: "2026-03-10T10:00:00.000Z",
    endedAt: "2026-03-13T10:00:00.000Z",
  });
  await insertSession(db, {
    id: "c-after-2",
    status: "inactive",
    startedAt: "2026-03-11T10:00:00.000Z",
    endedAt: "2026-03-12T10:00:00.000Z",
  });
  // completed, ended BEFORE the visit → not counted.
  await insertSession(db, {
    id: "c-before",
    status: "inactive",
    startedAt: "2026-03-01T10:00:00.000Z",
    endedAt: "2026-03-05T10:00:00.000Z",
  });
  // completed status but no terminal timestamp → excluded by the `ended_at >=`
  // bound (mirrors matchesDateBounds excluding NULL endedAt).
  await insertSession(db, {
    id: "c-null-end",
    status: "inactive",
    startedAt: "2026-03-11T10:00:00.000Z",
    endedAt: null,
  });
  // offset-form terminal timestamp: 2026-03-11T20:00-05:00 == 2026-03-12T01:00Z,
  // which is AFTER the visit as an INSTANT but sorts BEFORE it as wall-clock
  // text. A lexical `ended_at >= ?` would wrongly EXCLUDE it; the instant-aware
  // `julianday` comparison counts it, matching the hydrated `new Date(endedAt)`
  // path. `isoTs` persists such strings unchanged (harnesses can emit offsets).
  await insertSession(db, {
    id: "c-offset-after",
    status: "inactive",
    startedAt: "2026-03-11T10:00:00.000Z",
    endedAt: "2026-03-11T20:00:00.000-05:00",
  });
  // malformed terminal timestamp: `new Date` → epoch (excluded by the bound),
  // but the garbage text sorts AFTER the bound, so a lexical `ended_at >= ?`
  // would wrongly COUNT it. `julianday` returns NULL → excluded, matching the
  // hydrated path. Still a completed row, so the no-bound total counts it.
  await insertSession(db, {
    id: "c-malformed-end",
    status: "inactive",
    startedAt: "2026-03-11T10:00:00.000Z",
    endedAt: "not-a-timestamp",
  });
  // error(→failed) ended after the visit → not "completed".
  await insertSession(db, {
    id: "e-after",
    status: "error",
    startedAt: "2026-03-10T10:00:00.000Z",
    endedAt: "2026-03-13T11:00:00.000Z",
  });
  // abandoned ended after the visit.
  await insertSession(db, {
    id: "a-after",
    status: "inactive",
    startedAt: "2026-03-10T10:00:00.000Z",
    endedAt: "2026-03-13T09:00:00.000Z",
  });
  // active (running) — non-terminal, exercises buildUsageStatusPredicate's
  // active branch.
  await insertSession(db, {
    id: "active-1",
    status: "active",
    startedAt: "2026-03-12T10:00:00.000Z",
    endedAt: null,
  });
  // waiting — running + an awaiting-input timestamp, not ended.
  await insertSession(db, {
    id: "waiting-1",
    status: "running",
    startedAt: "2026-03-12T10:00:00.000Z",
    awaitingInputSince: "2026-03-12T12:00:00.000Z",
    endedAt: null,
  });
}

test("FEA-4142: count-only reads match the hydrated total and hydrate no rows", async () => {
  const { db, dir } = await openTempDb();
  try {
    await seedCorpus(db);
    await seedRetiredSpellingStraggler(db);
    const withCount = db.syncSource as AgentSessionSyncSource;
    assert.ok(
      typeof withCount.countSessions === "function",
      "the SQLite sync source must expose countSessions"
    );
    // Reference: the same source minus countSessions → the hydrated
    // matchesListQuery fold over the same corpus.
    const reference: AgentSessionSyncSource = {
      ...withCount,
      countSessions: undefined,
    };

    const filters: SharedAgentSessionsListRequest[] = [
      // The badge's exact shape.
      { statuses: [SESSION_STATUS.INACTIVE], completedAfter: VISIT, limit: 1 },
      // Single-value back-compat status.
      { status: SESSION_STATUS.INACTIVE, completedAfter: VISIT },
      // No completion bound — every terminal-not-failed row.
      { statuses: [SESSION_STATUS.INACTIVE] },
      // Alias canonicalization (error -> failed) both ways.
      { statuses: ["failed"] },
      { status: SESSION_STATUS.ERROR },
      // Non-terminal status branches.
      { statuses: ["active"] },
      { statuses: ["waiting"] },
      // Multi-status + completion bound.
      { statuses: [SESSION_STATUS.INACTIVE, "failed"], completedAfter: VISIT },
      // Completion bound with no status filter.
      { completedAfter: VISIT },
      // No filter at all.
      {},
    ];

    for (const filter of filters) {
      const viaCount = await getSharedAgentSessions(withCount, {
        ...filter,
        countOnly: true,
      });
      const viaHydrate = await getSharedAgentSessions(reference, filter);
      assert.equal(
        viaCount.total,
        viaHydrate.total,
        `count/hydrate total mismatch for ${JSON.stringify(filter)}`
      );
      // A count-only read never materializes rows.
      assert.deepEqual(
        viaCount.items,
        [],
        `count-only read hydrated rows for ${JSON.stringify(filter)}`
      );
      assert.equal(viaCount.idleCount, 0);
      assert.equal(viaCount.viewerScope, "self");
    }

    // Anchor a few absolute values so parity can't pass by both paths being
    // wrong the same way.
    const badge = await getSharedAgentSessions(withCount, {
      statuses: [SESSION_STATUS.INACTIVE],
      completedAfter: VISIT,
      limit: 1,
      countOnly: true,
    });
    assert.equal(
      badge.total,
      4,
      // ISS-4654: was three. The row seeded as `abandoned` is `inactive` now and
      // ended after the visit, so it joins the badge — the collapse of the two
      // retired spellings into one status is exactly what this anchor shows.
      "four inactive sessions since the visit (incl. the offset-form row and the once-abandoned row, excl. the malformed row)"
    );

    // The Inactive facet reaches every terminal-not-failed row but NEVER the
    // error/active/waiting rows. Anchors the count so parity can't pass by both
    // the SQL and hydrated paths being wrong the same way.
    const allInactive = await getSharedAgentSessions(withCount, {
      statuses: [SESSION_STATUS.INACTIVE],
      countOnly: true,
    });
    assert.equal(
      allInactive.total,
      7,
      "seven terminal-not-failed rows regardless of ended_at"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-4142: a non-count-expressible query falls back to the hydrated read", async () => {
  const { db, dir } = await openTempDb();
  try {
    await seedCorpus(db);
    const base = db.syncSource as AgentSessionSyncSource;
    let countCalls = 0;
    // Spy on countSessions so we can prove the fallback never invokes it.
    const source: AgentSessionSyncSource = {
      ...base,
      countSessions: (filters) => {
        countCalls += 1;
        return base.countSessions?.(filters) ?? 0;
      },
    };

    // A count-expressible read uses the COUNT path.
    countCalls = 0;
    const counted = await getSharedAgentSessions(source, {
      statuses: [SESSION_STATUS.INACTIVE],
      completedAfter: VISIT,
      countOnly: true,
    });
    assert.equal(countCalls, 1, "count-expressible read uses countSessions");
    assert.equal(counted.total, 4);

    // The substantive quality gate is not SQL-expressible, so it must fall back
    // to the hydrated path — countSessions is never called.
    countCalls = 0;
    const gated = await getSharedAgentSessions(source, {
      statuses: [SESSION_STATUS.INACTIVE],
      completedAfter: VISIT,
      quality: "substantive",
      countOnly: true,
    });
    assert.equal(
      countCalls,
      0,
      "substantive gate falls back off the count path"
    );
    assert.equal(gated.viewerScope, "self");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
