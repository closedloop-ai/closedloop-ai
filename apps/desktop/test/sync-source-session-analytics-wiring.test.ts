/**
 * ISS-7813 / ISS-7818: the nullable whole-session cost resolution, asserted at
 * the real SQLite -> payload boundary.
 *
 * `sync-source-session-analytics.test.ts` covers the mapper, which takes the cost
 * as a parameter — so it can prove what the mapper does with a value and nothing
 * about where that value came from. The call site
 * (`sync-source.ts`, `mapSyncedSessionAnalytics(sessionAnalyticsRow, ...)`) was
 * the entire subject of this ticket and had no coverage at all: swapping it
 * between `session_analytics.est_cost` and `sessions.cost_usd_estimated` left
 * every desktop suite green in both directions.
 *
 * ISS-7818 deliberately turns unknown into an explicit `null` after the nullable
 * cloud contract shipped with ISS-7813. The fixtures keep the candidates
 * distinguishable so the valid-analytics preference, fully-priced fallback,
 * partial-window refusal, explicit-null ownership, and real-zero behavior are
 * all observable rather than passing accidentally.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

/** `session_analytics.est_cost` — the current nullable analytics rollup. */
const ROLLUP_EST_COST = 4.44;
/** `sessions.cost_usd_estimated` — nullable, the authoritative figure. */
const AUTHORITATIVE_COST = 9.99;
/**
 * The same column after the UNGUARDED `updateSessionCostRollup` that
 * `persistImportedTokenCosts` runs: `Σ(priced) + web` over a window that is only
 * partly priced, so a real number that is simply low.
 */
const PARTIAL_AUTHORITATIVE_COST = 4.2;
/** A `REAL` column has no CHECK behind it; the wire contract is `nonnegative()`. */
const CORRUPT_NEGATIVE_COST = -1;

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
  costUsdEstimated: number | null,
  estCost: number | null
) {
  await db.run(
    `INSERT INTO sessions (id, status, started_at, updated_at, ended_at, cost_usd_estimated)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    "inactive",
    "2026-08-20T00:00:00.000Z",
    "2026-08-20T06:00:00.000Z",
    "2026-08-20T05:00:00.000Z",
    costUsdEstimated
  );
  await db.run(
    `INSERT INTO session_analytics
       (session_id, started_at, started_day, status, harness, is_human,
        human_turns, agent_turns, event_count, tool_invocations, error_events,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        est_cost, runtime_ms, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    "2026-08-20T00:00:00.000Z",
    "2026-08-20",
    "inactive",
    "claude",
    0,
    2,
    3,
    5,
    1,
    0,
    100,
    200,
    0,
    0,
    estCost,
    1000,
    "2026-08-20T06:00:00.000Z"
  );
}

/**
 * ISS-7820 review (whitlockk): one `token_usage` row per entry, priced when `costUsd`
 * is a number. A NULL is the unpriced row `COUNT(cost_usd_estimated)` skips, and
 * a session carrying one is exactly the window whose stored totals cannot be
 * trusted.
 */
async function seedTokenUsage(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  id: string,
  rows: { model: string; costUsd: number | null }[]
) {
  for (const row of rows) {
    await db.run(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, created_at, cost_usd_estimated)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      row.model,
      100,
      200,
      "2026-08-20T01:00:00.000Z",
      row.costUsd
    );
  }
}

async function withSeededDb<T>(
  costUsdEstimated: number | null,
  run: (db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>) => Promise<T>,
  // ISS-7820 made this column nullable, so the fixture has to be able to seed
  // the unknown it can now hold. Defaulted, so the ISS-7813 cases below read
  // exactly as they did.
  estCost: number | null = ROLLUP_EST_COST,
  // ISS-7820 review: the session's `token_usage` window. Empty by default, which
  // is FULLY PRICED by the same edge `fullyPricedTokenUsageSql` takes — a session
  // with no token spend is not half-priced — so the cases above read unchanged.
  tokenUsage: { model: string; costUsd: number | null }[] = []
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7813-wiring-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-20T06:00:00.000Z",
    });
    try {
      await seedSession(db, "sess-1", costUsdEstimated, estCost);
      await seedTokenUsage(db, "sess-1", tokenUsage);
      return await run(db);
    } finally {
      await db.close?.();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function loadedSession(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
) {
  const [session] = await db.syncSource.loadSyncedSessions(
    ["sess-1"],
    emptyAttributionCache()
  );
  if (!session) {
    throw new Error("the session did not hydrate");
  }
  return session;
}

async function syncedCostUsd(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
): Promise<number | null | undefined> {
  return (await loadedSession(db)).sessionAnalytics?.estimatedCostUsd;
}

test("a valid analytics cost wins before the pricing-window guard", async () => {
  // The candidates disagree and the token window is partial on purpose. A
  // resolver that consulted the guard or authoritative fallback first would
  // yield null or 9.99 instead of the valid current analytics total.
  await withSeededDb(
    AUTHORITATIVE_COST,
    async (db) => {
      assert.equal(await syncedCostUsd(db), ROLLUP_EST_COST);
    },
    ROLLUP_EST_COST,
    [
      { costUsd: 1.5, model: "claude-sonnet-4-5" },
      { costUsd: null, model: "some-unpriced-model" },
    ]
  );
});

test("a valid analytics cost still syncs when the authoritative cost is null", async () => {
  await withSeededDb(null, async (db) => {
    const session = await loadedSession(db);
    assert.equal(session.sessionAnalytics?.estimatedCostUsd, ROLLUP_EST_COST);
  });
});

test("an UNKNOWN est_cost falls back to the authoritative total, not to zero", async () => {
  // ISS-7820: `est_cost` is nullable now, and NULL means "this window could not
  // be priced". The `?? 0` that used to be dead code is therefore reachable, and
  // folding straight to it would swap one false-completeness for another at the
  // same seam — a fresh, confident $0.00 for a session we know cost $9.99.
  //
  // The authoritative column is the right second reach WHEN the window is fully
  // priced (here it has no `token_usage` rows at all): the guard that nulls
  // est_cost (`requireFullyPricedTokenUsage`) DECLINES the authoritative write
  // rather than clearing it, so in that state that column still holds the last
  // figure this store could stand behind and is safe as the second candidate.
  await withSeededDb(
    AUTHORITATIVE_COST,
    async (db) => {
      const session = await loadedSession(db);
      assert.equal(
        session.sessionAnalytics?.estimatedCostUsd,
        AUTHORITATIVE_COST
      );
      assert.notEqual(session.sessionAnalytics?.estimatedCostUsd, 0);
    },
    null
  );
});

test("both totals unknown syncs an explicit null", async () => {
  await withSeededDb(
    null,
    async (db) => {
      const session = await loadedSession(db);
      assert.equal(session.sessionAnalytics?.estimatedCostUsd, null);
      assert.equal(
        Object.hasOwn(session.sessionAnalytics ?? {}, "estimatedCostUsd"),
        true,
        "unknown is a value, not an omitted field"
      );
    },
    null
  );
});

/**
 * ISS-7820 review (whitlockk): the second link is NOT unconditionally "the last
 * known total". `persistImportedTokenCosts` ends every import with the
 * UNGUARDED `updateSessionCostRollup`, which writes `Σ(priced) + web` even when
 * part of the window is unpriced — so a mixed import leaves a PARTIAL number in
 * `sessions.cost_usd_estimated` at the same moment `est_cost` goes NULL. Reaching
 * for it there would send a confident, low figure: the very defect this ticket
 * removes, relocated one column over.
 */
test("a partial authoritative total is not reached for when the window is unpriced", async () => {
  await withSeededDb(
    PARTIAL_AUTHORITATIVE_COST,
    async (db) => {
      const cost = await syncedCostUsd(db);
      assert.notEqual(
        cost,
        PARTIAL_AUTHORITATIVE_COST,
        "the partial sum must not reach the wire"
      );
      assert.equal(cost, null);
    },
    null,
    [
      { costUsd: 1.5, model: "claude-sonnet-4-5" },
      { costUsd: null, model: "some-unpriced-model" },
    ]
  );
});

/**
 * The other half of the same guard, so it is a COMPLETENESS test and not a
 * blanket "always 0": with every `token_usage` row priced, the authoritative
 * column IS a total the store can stand behind, and a stale `est_cost` NULL
 * still falls through to it.
 */
test("a fully priced window still falls back to the authoritative total", async () => {
  await withSeededDb(
    AUTHORITATIVE_COST,
    async (db) => {
      assert.equal(await syncedCostUsd(db), AUTHORITATIVE_COST);
    },
    null,
    [{ costUsd: 1.5, model: "claude-sonnet-4-5" }]
  );
});

test("no analytics row omits the analytics section", async () => {
  await withSeededDb(AUTHORITATIVE_COST, async (db) => {
    await db.run(
      "DELETE FROM session_analytics WHERE session_id = ?",
      "sess-1"
    );
    const session = await loadedSession(db);
    assert.equal(session.sessionAnalytics, undefined);
  });
});

test("a real zero remains zero and is not confused with unknown", async () => {
  await withSeededDb(
    0,
    async (db) => {
      const session = await loadedSession(db);
      assert.equal(session.sessionAnalytics?.estimatedCostUsd, 0);
      assert.equal(
        Object.hasOwn(session.sessionAnalytics ?? {}, "estimatedCostUsd"),
        true
      );
    },
    null
  );
});

/**
 * ISS-7820 review (davetho): `est_cost` is a SQLite `REAL` with no CHECK
 * behind it, and the receiving contract is
 * `z.number().finite().nonnegative().nullable().optional()` — whose own comment
 * in `desktop-agent-sessions-schema.ts` states the blast radius: a bad value
 * would "fail THIS field, fail its session, and fail
 * `parseDesktopAgentSessionsPayload` for the WHOLE batch", on every retry. A
 * corrupt candidate is therefore skipped, not forwarded.
 */
test("a negative stored est_cost is skipped for the next valid candidate", async () => {
  await withSeededDb(
    AUTHORITATIVE_COST,
    async (db) => {
      assert.equal(await syncedCostUsd(db), AUTHORITATIVE_COST);
    },
    CORRUPT_NEGATIVE_COST
  );
});

test("a non-finite stored est_cost never reaches the wire", async () => {
  await withSeededDb(
    null,
    async (db) => {
      // SQLite stores the overflowing literal as +Inf; binding a JS Infinity is
      // not how a corrupt row would arrive, so the fixture writes it as SQL.
      await db.run(
        "UPDATE session_analytics SET est_cost = 9e999 WHERE session_id = ?",
        "sess-1"
      );
      const cost = await syncedCostUsd(db);
      assert.equal(cost, null);
    },
    null
  );
});

/**
 * ISS-7818 review (whitlockk): `REAL` is an AFFINITY, not a constraint — SQLite
 * stores a non-numeric TEXT value in the column verbatim. `Number("")` is 0, so
 * a blank cell reaches the wire as a confident $0.00 unless the resolver
 * requires a number before it range-checks. Asserted here, at the real store,
 * because the affinity is the thing under test and a hand-built row cannot
 * exhibit it.
 */
test("a blank stored cost syncs as unknown, not as a measured zero", async () => {
  await withSeededDb(
    null,
    async (db) => {
      // Written as SQL for the same reason the +Inf case above is: binding a JS
      // "" is not how a corrupt row arrives.
      await db.run(
        "UPDATE session_analytics SET est_cost = '' WHERE session_id = ?",
        "sess-1"
      );
      await db.run(
        "UPDATE sessions SET cost_usd_estimated = '' WHERE id = ?",
        "sess-1"
      );
      const cost = await syncedCostUsd(db);
      assert.equal(cost, null);
      assert.notEqual(cost, 0);
    },
    null
  );
});

/**
 * ISS-7818 review (whitlockk): the ingress schema is
 * `z.number().finite().nonnegative()` with no upper bound, so a corrupt figure
 * past `Decimal(14, 6)` validates and then fails the WRITE — taking every other
 * session in the batch down with it, on every retry.
 */
test("a stored cost past the destination column's range syncs as unknown", async () => {
  await withSeededDb(
    null,
    async (db) => {
      await db.run(
        "UPDATE session_analytics SET est_cost = 100000000 WHERE session_id = ?",
        "sess-1"
      );
      // A resolver without the ceiling forwards 100000000 here.
      assert.equal(await syncedCostUsd(db), null);
    },
    null
  );
});
