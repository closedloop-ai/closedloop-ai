import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { upsertSessionAnalyticsRollup } from "../src/main/database/session-analytics-rollup.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  createSqliteSessionSyncSource,
  getArtifactSessionUsage,
} from "../src/main/database/sync-source.js";
import { repriceUnpricedTokenUsage } from "../src/main/database/token-cost-maintenance.js";
import { createSessionAttributionResolverCache } from "../src/main/session/shared-agent-sessions-api.js";
import { estimateTokenCost } from "../src/shared/token-cost.js";
import { ROLLUP_OPTS } from "./rollup-options-test-utils.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-06-21T12:00:00.000Z";

// claude-opus-4-5 @ 1000 input tokens prices to exactly $0.005 (see
// token-cost.test.ts). A compacted row whose EFFECTIVE input is
// current(1000) + baseline(1000) = 2000 must price to $0.010 — twice the
// current-only value the FEA-2879 bug would (silently) charge.
const CURRENT_INPUT = 1000;
const BASELINE_INPUT = 1000;
const EFFECTIVE_COST = 0.01;
const CURRENT_ONLY_COST = 0.005;

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-usage-compaction-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  return { db, dir };
}

async function insertSession(db: SqliteDb, id: string): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, harness, started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)`,
    id,
    "completed",
    "claude_code",
    "2026-06-20T08:00:00.000Z",
    NOW
  );
}

// A metered (real per-token API) session: `billing_mode='api'` so the
// reconciliation reader's shared billing-mode rule includes it.
async function insertMeteredSession(db: SqliteDb, id: string): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, harness, started_at, updated_at, billing_mode)
     VALUES ($1, $2, $3, $4, $5, 'api')`,
    id,
    "completed",
    "claude_code",
    "2026-06-20T08:00:00.000Z",
    NOW
  );
}

// Insert a token_usage row whose pre-compaction totals were rolled into
// baseline_* by upsertTokenUsage's Gap 5 / compaction-resilience path.
async function insertCompactedToken(
  db: SqliteDb,
  sessionId: string,
  model: string,
  opts: {
    currentInput: number;
    baselineInput: number;
    cost: number | null;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO token_usage (
       session_id, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       baseline_input, baseline_output, baseline_cache_read, baseline_cache_write,
       created_at, cost_usd_estimated
     )
     VALUES ($1, $2, $3, 0, 0, 0, $4, 0, 0, 0, $5, $6)`,
    sessionId,
    model,
    opts.currentInput,
    opts.baselineInput,
    "2026-06-20T08:00:00.000Z",
    opts.cost
  );
}

// Link a session to a closedloop_artifact, mirroring the fixture in
// model-pricing-sqlite.test.ts (the artifacts / session_artifact_links rows
// carry several NOT NULL columns, so a bare id/slug insert would fail).
async function linkClosedloopArtifact(
  db: SqliteDb,
  sessionId: string,
  slug: string
): Promise<void> {
  const observedAt = "2026-06-20T12:00:00.000Z";
  const artifactId = `artifact-${slug}`;
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, slug, observed_at, created_at, last_seen_at)
     VALUES ($1, $2, 'closedloop_artifact', $3, $4, $4, $4)`,
    artifactId,
    `cldoc:${slug}`,
    slug,
    observedAt
  );
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, is_primary,
        status, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, 'referenced', 'test_fixture', '{}', FALSE, 'candidate', 1, $4, $4)`,
    `${sessionId}:${artifactId}:referenced`,
    sessionId,
    artifactId,
    observedAt
  );
}

async function tokenCost(
  db: SqliteDb,
  sessionId: string,
  model: string
): Promise<number | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { cost_usd_estimated: number | null }[]
  >(
    "SELECT cost_usd_estimated FROM token_usage WHERE session_id = $1 AND model = $2",
    sessionId,
    model
  );
  const value = rows[0]?.cost_usd_estimated;
  return value == null ? null : Number(value);
}

async function analytics(
  db: SqliteDb,
  sessionId: string
): Promise<{ estCost: number | null; inputTokens: number | null }> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { est_cost: number | null; input_tokens: number | null }[]
  >(
    "SELECT est_cost, input_tokens FROM session_analytics WHERE session_id = $1",
    sessionId
  );
  const row = rows[0];
  return {
    estCost: row?.est_cost == null ? null : Number(row.est_cost),
    inputTokens: row?.input_tokens == null ? null : Number(row.input_tokens),
  };
}

async function sessionCost(
  db: SqliteDb,
  sessionId: string
): Promise<number | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { cost_usd_estimated: number | null }[]
  >("SELECT cost_usd_estimated FROM sessions WHERE id = $1", sessionId);
  const value = rows[0]?.cost_usd_estimated;
  return value == null ? null : Number(value);
}

// FEA-2879: baseline_* preserves the pre-compaction totals on transcript
// compaction. The boot reprice must fold them into the effective total it
// prices, so a compacted session's healed cost reflects ALL incurred tokens.
test("boot re-pricing prices the effective total (current + baseline) of a compacted row", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-compacted");
    await insertCompactedToken(db, "sess-compacted", "claude-opus-4-5", {
      currentInput: CURRENT_INPUT,
      baselineInput: BASELINE_INPUT,
      cost: null,
    });

    // Materialize the rollup the way ingest does — est_cost starts at 0 (the
    // one row is unpriced).
    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, "sess-compacted", NOW, ROLLUP_OPTS)
      )
    );
    assert.equal((await analytics(db, "sess-compacted")).estCost, 0);

    await repriceUnpricedTokenUsage(db.prisma, () => undefined);

    // Priced on the effective total, NOT the post-compaction subset.
    assert.equal(
      await tokenCost(db, "sess-compacted", "claude-opus-4-5"),
      EFFECTIVE_COST
    );
    assert.notEqual(
      await tokenCost(db, "sess-compacted", "claude-opus-4-5"),
      CURRENT_ONLY_COST
    );

    // Both materialized cost snapshots agree on the effective cost.
    const rolled = await analytics(db, "sess-compacted");
    assert.equal(rolled.estCost, EFFECTIVE_COST);
    assert.equal(await sessionCost(db, "sess-compacted"), EFFECTIVE_COST);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-2879 (P2 repair): a row compacted BEFORE this patch already has
// baseline_* populated AND a non-null cost_usd_estimated computed by the old
// current-only pricing path (which ignored baseline_*). The boot reprice must
// repair those already-costed compacted rows to the effective total, and must
// converge — a second pass over a now-correct row is a no-op.
test("boot re-pricing repairs an already-costed compacted row and is convergent", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-precosted");
    // Simulate the pre-FEA-2879 state: baseline_* preserved by the compaction
    // path, but cost frozen at the current-only price ($0.005), undercounting.
    await insertCompactedToken(db, "sess-precosted", "claude-opus-4-5", {
      currentInput: CURRENT_INPUT,
      baselineInput: BASELINE_INPUT,
      cost: CURRENT_ONLY_COST,
    });

    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, "sess-precosted", NOW, ROLLUP_OPTS)
      )
    );
    // The rollup already sums est_cost from the (undercounted) per-row cost.
    assert.equal(
      (await analytics(db, "sess-precosted")).estCost,
      CURRENT_ONLY_COST
    );

    await repriceUnpricedTokenUsage(db.prisma, () => undefined);

    // Repriced to the effective total, not the frozen current-only value.
    assert.equal(
      await tokenCost(db, "sess-precosted", "claude-opus-4-5"),
      EFFECTIVE_COST
    );
    const rolled = await analytics(db, "sess-precosted");
    assert.equal(rolled.estCost, EFFECTIVE_COST);
    assert.equal(await sessionCost(db, "sess-precosted"), EFFECTIVE_COST);

    // Convergence / idempotency: a second pass leaves the (now-correct) row at
    // the effective total — no double-count, no drift.
    await repriceUnpricedTokenUsage(db.prisma, () => undefined);
    assert.equal(
      await tokenCost(db, "sess-precosted", "claude-opus-4-5"),
      EFFECTIVE_COST
    );
    assert.equal(
      (await analytics(db, "sess-precosted")).estCost,
      EFFECTIVE_COST
    );
    assert.equal(await sessionCost(db, "sess-precosted"), EFFECTIVE_COST);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-2879: a NON-compacted, already-correctly-priced row (no baseline_*) must
// not be touched by the reprice pass — guards against the broadened selection
// re-pricing healthy rows.
test("boot re-pricing leaves a correctly-priced non-compacted row untouched", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-healthy");
    await insertCompactedToken(db, "sess-healthy", "claude-opus-4-5", {
      currentInput: CURRENT_INPUT,
      baselineInput: 0,
      cost: CURRENT_ONLY_COST,
    });

    await repriceUnpricedTokenUsage(db.prisma, () => undefined);

    // current-only == effective total here (no baseline), so cost is unchanged.
    assert.equal(
      await tokenCost(db, "sess-healthy", "claude-opus-4-5"),
      CURRENT_ONLY_COST
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-2879: the materialized session_analytics token COUNTS must also include
// the pre-compaction baseline_*, not just the post-compaction current_* subset.
test("session_analytics rollup counts the effective (current + baseline) tokens", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-counts");
    await insertCompactedToken(db, "sess-counts", "claude-opus-4-5", {
      currentInput: CURRENT_INPUT,
      baselineInput: BASELINE_INPUT,
      cost: CURRENT_ONLY_COST,
    });

    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, "sess-counts", NOW, ROLLUP_OPTS)
      )
    );

    const rolled = await analytics(db, "sess-counts");
    assert.equal(rolled.inputTokens, CURRENT_INPUT + BASELINE_INPUT);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-2922: the per-model sync projection (tokenUsageByModel) must ship the
// EFFECTIVE (current + baseline) totals too, mirroring the session_analytics
// rollup. Otherwise a compacted session syncs raw post-compaction counts while
// its co-synced rollup carries effective totals — they disagree, and the raw
// counts contradict the effective-priced per-model cost.
test("tokenUsageByModel sync projection ships the effective (current + baseline) totals", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-sync");
    // Stored cost is the effective-priced value (what FEA-2879 materializes).
    await insertCompactedToken(db, "sess-sync", "claude-opus-4-5", {
      currentInput: CURRENT_INPUT,
      baselineInput: BASELINE_INPUT,
      cost: EFFECTIVE_COST,
    });

    const [session] = await loadUsageSessions(db, ["sess-sync"]);
    const perModel = session?.tokenUsageByModel?.[0];
    assert.ok(perModel, "expected a per-model token usage row");

    // Effective input total, NOT the post-compaction subset (the bug shipped
    // CURRENT_INPUT alone).
    assert.equal(perModel.inputTokens, CURRENT_INPUT + BASELINE_INPUT);
    assert.notEqual(perModel.inputTokens, CURRENT_INPUT);

    // Cost (effective-priced) and counts (now effective) agree — no
    // cost/count mismatch inside the synced per-model row.
    assert.equal(perModel.estimatedCostUsd, EFFECTIVE_COST);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-3317: the desktop insights usage aggregate (`aggregateUsage`) reprices an
// unpriced (pricing-miss) row on the fly via resolveTokenUsageCostUsd over its
// unpriced-token sums. For a compacted session, those sums must carry the
// EFFECTIVE total (current + baseline), matching the boot reprice and the sync
// projection — otherwise the on-the-fly cost undercounts the pre-compaction spend.
test("insights aggregateUsage reprices an unpriced compacted row on the effective (current + baseline) total", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-insights-unpriced");
    // A post-compaction pricing miss: cost NULL, but baseline_* preserves the
    // pre-compaction tokens. The aggregate must reprice on current + baseline.
    await insertCompactedToken(
      db,
      "sess-insights-unpriced",
      "claude-opus-4-5",
      {
        currentInput: CURRENT_INPUT,
        baselineInput: BASELINE_INPUT,
        cost: null,
      }
    );

    const aggregate = await aggregateUsage(db);
    const group = aggregate.tokenGroups.find(
      (g) => g.model === "claude-opus-4-5"
    );
    assert.ok(group, "expected a token group for the compacted model");

    // Repriced on the effective total, NOT the post-compaction subset (the bug
    // priced CURRENT_INPUT alone → CURRENT_ONLY_COST).
    assert.equal(group.estimatedCostUsd, EFFECTIVE_COST);
    assert.notEqual(group.estimatedCostUsd, CURRENT_ONLY_COST);
    // FEA-3317: the REPORTED tokens must also carry the effective total so the
    // baseline-priced cost is not shown against an undercounted token count —
    // SQL-vs-hydrate parity (the sync projection folds baseline unconditionally).
    assert.equal(group.inputTokens, CURRENT_INPUT + BASELINE_INPUT);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-3317: a NON-compacted unpriced row (default-0 baseline) must reprice to the
// current-only cost — the effective-total fold reduces to current when baseline=0.
test("insights aggregateUsage reprices a non-compacted unpriced row on the current-only total", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-insights-plain");
    await insertCompactedToken(db, "sess-insights-plain", "claude-opus-4-5", {
      currentInput: CURRENT_INPUT,
      baselineInput: 0,
      cost: null,
    });

    const aggregate = await aggregateUsage(db);
    const group = aggregate.tokenGroups.find(
      (g) => g.model === "claude-opus-4-5"
    );
    assert.ok(group, "expected a token group for the non-compacted model");
    assert.equal(group.estimatedCostUsd, CURRENT_ONLY_COST);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unpriced aggregate and artifact fallbacks include the one-hour cache-write premium", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-ttl-unpriced";
    const artifactSlug = "FEA-3419-unpriced";
    await insertSession(db, sessionId);
    await insertCompactedToken(db, sessionId, "claude-opus-4-5", {
      currentInput: 0,
      baselineInput: 0,
      cost: null,
    });
    await db.run(
      `UPDATE token_usage
       SET cache_write_tokens = 1000,
           cache_write_5m_tokens = 600,
           cache_write_1h_tokens = 400,
           cost_usd_estimated = NULL
       WHERE session_id = $1`,
      sessionId
    );
    await linkClosedloopArtifact(db, sessionId, artifactSlug);
    const expected = estimateTokenCost({
      model: "claude-opus-4-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1000,
      cacheWrite1hTokens: 400,
      observedAt: NOW,
    });
    assert.ok(expected);

    const aggregate = await aggregateUsage(db);
    const group = aggregate.tokenGroups.find(
      (entry) => entry.model === "claude-opus-4-5"
    );
    assert.equal(group?.estimatedCostUsd, expected.costUsd);

    const [artifactUsage] = await getArtifactSessionUsage(db.prisma, [
      artifactSlug,
    ]);
    assert.equal(artifactUsage?.estimatedCostUsd, expected.costUsd);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-3317: the analytics repository breakdown reports per-repo token totals
// from `aggregateSqliteAnalytics`'s per_session_tokens CTE. Those must carry the
// effective (current + baseline) total for a compacted row so the SQL analytics
// path matches the hydrate `buildAnalytics` repository fold (sumTokenUsage over the
// effective tokenUsageByModel). A current-only rollup would undercount tokens.
//
// FEA-4299: the session carries a stored `repo_full_name` but no live git remote
// (the deleted-worktree case). The analytics `byRepository` fold must fall back
// to that durable stored repo — matching the LIST/render path and the usage
// facet — instead of dropping the row's tokens. Without the fallback the repo
// the row still renders would contribute 0 to `byRepository` (the codex P1
// regression this test guards).
test("analytics byRepository reports the effective (current + baseline) tokens for a compacted row", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-analytics-compacted");
    await db.run(
      "UPDATE sessions SET repo_full_name = $1 WHERE id = $2",
      "acme/widgets",
      "sess-analytics-compacted"
    );
    await insertCompactedToken(
      db,
      "sess-analytics-compacted",
      "claude-opus-4-5",
      {
        currentInput: CURRENT_INPUT,
        baselineInput: BASELINE_INPUT,
        cost: null,
      }
    );

    const analyticsAggregate = await aggregateAnalytics(db);
    const repoInputTokens = analyticsAggregate.byRepository.reduce(
      (sum, group) => sum + group.inputTokens,
      0
    );
    assert.equal(repoInputTokens, CURRENT_INPUT + BASELINE_INPUT);
    // The stored repo is the group identity (no live remote resolved in tests).
    assert.ok(
      analyticsAggregate.byRepository.some(
        (group) => group.repositoryFullName === "acme/widgets"
      )
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-3317: getArtifactSessionUsage must also report the effective (current +
// baseline) tokens and reprice an unpriced compacted row on that total, matching
// the other sync-source aggregate sites. A current-only rollup would undercount
// both the reported tokens and the on-the-fly repriced cost.
test("getArtifactSessionUsage reports effective tokens and reprices on the effective total for a compacted row", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-artifact-compacted");
    await insertCompactedToken(
      db,
      "sess-artifact-compacted",
      "claude-opus-4-5",
      {
        currentInput: CURRENT_INPUT,
        baselineInput: BASELINE_INPUT,
        cost: null,
      }
    );
    const artifactSlug = "FEA-3317-compacted-artifact";
    await linkClosedloopArtifact(db, "sess-artifact-compacted", artifactSlug);

    const [usage] = await getArtifactSessionUsage(db.prisma, [artifactSlug]);
    assert.ok(usage, "expected artifact usage for the compacted session");
    assert.equal(usage.inputTokens, CURRENT_INPUT + BASELINE_INPUT);
    assert.equal(usage.estimatedCostUsd, EFFECTIVE_COST);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-2922: non-compacted sessions must still produce correct token counts —
// the effective-total rollup must reduce to the current-only counts when a row
// was never compacted. `baseline_*` is `NOT NULL DEFAULT 0` (see 0001_init /
// schema.prisma), so a real non-compacted row carries baseline_* = 0 (the
// column default), NOT NULL: omitting the columns exercises that exact state.
test("non-compacted sessions (default-0 baseline) produce correct token counts", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-non-compacted");
    // Insert a token_usage row that OMITS the baseline_* columns, so each takes
    // its schema DEFAULT of 0 — exactly the shape of a never-compacted row.
    await db.run(
      `INSERT INTO token_usage (
         session_id, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         created_at, cost_usd_estimated
       )
       VALUES ($1, $2, $3, 0, 0, 0, $4, $5)`,
      "sess-non-compacted",
      "claude-opus-4-5",
      CURRENT_INPUT,
      "2026-06-20T08:00:00.000Z",
      CURRENT_ONLY_COST
    );

    // Rollup must not produce NaN — effective input = current + baseline(0) = current.
    // Drive it through a Prisma transaction exactly as ingest does
    // (importPhaseDerivedRollups passes the phase `tx`), not by handing the
    // SqliteDb wrapper straight to a function typed for Prisma.TransactionClient.
    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, "sess-non-compacted", NOW, ROLLUP_OPTS)
      )
    );
    const snap = await analytics(db, "sess-non-compacted");
    assert.equal(snap.inputTokens, CURRENT_INPUT);
    assert.notEqual(snap.inputTokens, Number.NaN);

    // Sync projection must also produce correct counts.
    const [session] = await loadUsageSessions(db, ["sess-non-compacted"]);
    const perModel = session?.tokenUsageByModel?.[0];
    assert.ok(perModel, "expected a per-model token usage row");
    assert.equal(perModel.inputTokens, CURRENT_INPUT);
    assert.notEqual(perModel.inputTokens, Number.NaN);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-3390: the metered-billing reconciliation reader must fold baseline_* into
// the token totals it compares against the provider bill. A compacted session
// that ships only its post-compaction subset would understate the local
// estimate and falsely read as a provider overcharge.
test("metered reconciliation rows fold the effective (current + baseline) tokens", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertMeteredSession(db, "sess-metered");
    await insertCompactedToken(db, "sess-metered", "claude-opus-4-5", {
      currentInput: CURRENT_INPUT,
      baselineInput: BASELINE_INPUT,
      cost: EFFECTIVE_COST,
    });

    const rows = await db.loadMeteredUsageRows("2026-06-01T00:00:00.000Z");
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.sessionId, "sess-metered");
    // Effective input total, NOT the post-compaction subset.
    assert.equal(row.inputTokens, CURRENT_INPUT + BASELINE_INPUT);
    assert.notEqual(row.inputTokens, CURRENT_INPUT);
    // Non-input columns had no baseline here, so they are unchanged (0).
    assert.equal(row.outputTokens, 0);
    assert.equal(row.cacheReadTokens, 0);
    assert.equal(row.cacheWriteTokens, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-3390: a NON-compacted metered session (baseline_* = 0) must reconcile the
// unchanged current-only totals — the fold reduces to the raw counts.
test("metered reconciliation rows are unchanged for a non-compacted session", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertMeteredSession(db, "sess-metered-plain");
    await insertCompactedToken(db, "sess-metered-plain", "claude-opus-4-5", {
      currentInput: CURRENT_INPUT,
      baselineInput: 0,
      cost: CURRENT_ONLY_COST,
    });

    const rows = await db.loadMeteredUsageRows("2026-06-01T00:00:00.000Z");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].inputTokens, CURRENT_INPUT);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-3391: per-artifact session usage must fold baseline_* into the token
// totals it attributes to the artifact. A compacted session would otherwise
// attribute only its post-compaction subset.
test("artifact session usage folds the effective (current + baseline) tokens", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-artifact");
    await insertCompactedToken(db, "sess-artifact", "claude-opus-4-5", {
      currentInput: CURRENT_INPUT,
      baselineInput: BASELINE_INPUT,
      cost: EFFECTIVE_COST,
    });
    await linkClosedloopArtifact(db, "sess-artifact", "FEA-3391-artifact");

    const [usage] = await getArtifactSessionUsage(db.prisma, [
      "FEA-3391-artifact",
    ]);
    assert.ok(usage, "expected an artifact usage row");
    assert.equal(usage.sessionCount, 1);
    // Effective input total, NOT the post-compaction subset.
    assert.equal(usage.inputTokens, CURRENT_INPUT + BASELINE_INPUT);
    assert.notEqual(usage.inputTokens, CURRENT_INPUT);
    // Cost comes from the stored (effective-priced) per-row estimate.
    assert.equal(usage.estimatedCostUsd, EFFECTIVE_COST);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-3391: the unpriced-repricing path in getArtifactSessionUsage reprices
// from the folded totals. A compacted row with a NULL stored cost must be
// repriced on the EFFECTIVE (current + baseline) total, not the current-only
// subset — otherwise both the token total AND the derived cost undercount.
test("artifact session usage reprices unpriced rows from the effective total", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-artifact-unpriced");
    // NULL stored cost forces getArtifactSessionUsage's on-read repricing path.
    await insertCompactedToken(
      db,
      "sess-artifact-unpriced",
      "claude-opus-4-5",
      {
        currentInput: CURRENT_INPUT,
        baselineInput: BASELINE_INPUT,
        cost: null,
      }
    );
    await linkClosedloopArtifact(
      db,
      "sess-artifact-unpriced",
      "FEA-3391-unpriced"
    );

    const [usage] = await getArtifactSessionUsage(db.prisma, [
      "FEA-3391-unpriced",
    ]);
    assert.ok(usage, "expected an artifact usage row");
    // Tokens are the effective total.
    assert.equal(usage.inputTokens, CURRENT_INPUT + BASELINE_INPUT);
    // Cost is repriced on the effective total ($0.010), not current-only
    // ($0.005) and not zero.
    assert.equal(usage.estimatedCostUsd, EFFECTIVE_COST);
    assert.notEqual(usage.estimatedCostUsd, CURRENT_ONLY_COST);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-3391: a NON-compacted linked session (baseline_* = 0) must attribute the
// unchanged current-only totals and cost — the fold reduces to raw counts.
test("artifact session usage is unchanged for a non-compacted session", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-artifact-plain");
    await insertCompactedToken(db, "sess-artifact-plain", "claude-opus-4-5", {
      currentInput: CURRENT_INPUT,
      baselineInput: 0,
      cost: CURRENT_ONLY_COST,
    });
    await linkClosedloopArtifact(db, "sess-artifact-plain", "FEA-3391-plain");

    const [usage] = await getArtifactSessionUsage(db.prisma, [
      "FEA-3391-plain",
    ]);
    assert.ok(usage, "expected an artifact usage row");
    assert.equal(usage.inputTokens, CURRENT_INPUT);
    assert.equal(usage.estimatedCostUsd, CURRENT_ONLY_COST);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// `loadUsageSessions`, `aggregateUsage`, and `aggregateAnalytics` are OPTIONAL
// on the AgentSessionSyncSource contract (sources without them fall back to the
// full hydrate). The sqlite source implements all three, so a missing method is
// a real regression in the source — these helpers prove it is there before the
// assertions run instead of failing somewhere downstream.
async function loadUsageSessions(db: SqliteDb, ids: string[]) {
  const source = createSqliteSessionSyncSource(db.prisma);
  if (!source.loadUsageSessions) {
    throw new Error("sqlite sync source must implement loadUsageSessions");
  }
  return await source.loadUsageSessions(ids);
}

async function aggregateUsage(db: SqliteDb) {
  const source = createSqliteSessionSyncSource(db.prisma);
  if (!source.aggregateUsage) {
    throw new Error("sqlite sync source must implement aggregateUsage");
  }
  return await source.aggregateUsage({});
}

async function aggregateAnalytics(db: SqliteDb) {
  const source = createSqliteSessionSyncSource(db.prisma);
  if (!source.aggregateAnalytics) {
    throw new Error("sqlite sync source must implement aggregateAnalytics");
  }
  return await source.aggregateAnalytics(
    {},
    createSessionAttributionResolverCache()
  );
}
