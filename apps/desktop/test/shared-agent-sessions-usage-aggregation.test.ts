import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentSessionSyncSource,
  AgentSessionUsageAggregateFilters,
} from "../src/main/agent-session-sync-service.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { getSharedAgentSessionUsage } from "../src/main/shared-agent-sessions-api.js";
import type {
  SharedAgentSessionsListRequest,
  SharedAgentSessionsQuery,
  SharedAgentSessionUsageSummary,
} from "../src/shared/shared-agent-sessions-contract.js";

// FEA-1834 / PLN-941 §4: the SQL `aggregateUsage` path must reproduce the
// hydrate-then-`buildUsageSummary` path byte-for-byte (costs to within float
// epsilon — genai-prices is linear so summing tokens then costing equals summing
// per-row costs, but the two FP fold orders differ by ~1 ULP, well below the
// displayed cent). Both paths run against the SAME seeded SQLite corpus; the
// reference path is the same source with `aggregateUsage` stripped, which falls
// back to `loadUsageSessions` → `buildUsageSummary`.

const COST_EPSILON = 1e-9;

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

type SeedSession = {
  id: string;
  // `null` exercises the NULL-harness → "unknown" bucket merge; a literal
  // "unknown" string must fold into the same bucket (FEA-1834 §5 parity).
  harness: string | null;
  billingMode: string;
  status: string;
  // `null`/""/malformed exercise the epoch-coercion path that mirrors
  // `parseSessionDate`'s NaN→epoch fallback (FEA-1834 §6 parity).
  startedAt: string | null;
  awaitingInputSince?: string;
  endedAt?: string | null;
  userId?: string | null;
};

type SeedToken = {
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

async function insertSession(db: SqliteDb, seed: SeedSession): Promise<void> {
  // `updated_at` is kept independently valid (the usage path never reads it) so a
  // null/empty/malformed `started_at` can be seeded without an unrelated cast.
  await db.run(
    `INSERT INTO sessions
       (id, status, started_at, updated_at, ended_at, harness, billing_mode, awaiting_input_since, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    seed.id,
    seed.status,
    seed.startedAt,
    "2026-06-01T00:00:00.000Z",
    seed.endedAt ?? null,
    seed.harness,
    seed.billingMode,
    seed.awaitingInputSince ?? null,
    seed.userId ?? null
  );
}

async function insertToken(
  db: SqliteDb,
  token: SeedToken,
  at: string
): Promise<void> {
  await db.run(
    `INSERT INTO token_usage (
       session_id, model, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, raw_input, raw_output,
       raw_cache_read, raw_cache_write, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $3, $4, $5, $6, $7, $7)`,
    token.sessionId,
    token.model,
    token.inputTokens,
    token.outputTokens,
    token.cacheReadTokens,
    token.cacheWriteTokens,
    at
  );
}

function sortBy<T>(rows: readonly T[], select: (row: T) => string): T[] {
  return [...rows].sort((left, right) =>
    select(left).localeCompare(select(right))
  );
}

// Round to 9 decimals: kills the ~1e-15 difference between the two cost fold
// orders (sum-of-per-session-costs vs cost-of-summed-tokens) while preserving
// far more precision than the displayed cent.
function roundCost(value: number): number {
  return Math.round(value / COST_EPSILON) * COST_EPSILON;
}

/**
 * Normalize a usage summary into an order- and float-noise-independent shape so
 * the two code paths can be compared with a single `deepEqual` (breakdown order
 * differs — the SQL path orders by name, the hydrate path by first appearance —
 * and that order carries no meaning).
 */
function normalizeUsage(summary: SharedAgentSessionUsageSummary) {
  return {
    ...summary,
    totalEstimatedCost: roundCost(summary.totalEstimatedCost),
    subscriptionEstimatedCost: roundCost(summary.subscriptionEstimatedCost),
    apiEstimatedCost: roundCost(summary.apiEstimatedCost),
    byModel: sortBy(summary.byModel, (row) => row.model).map((row) => ({
      ...row,
      estimatedCost: roundCost(row.estimatedCost),
    })),
    byHarness: sortBy(summary.byHarness, (row) => row.harness).map((row) => ({
      ...row,
      estimatedCost: roundCost(row.estimatedCost),
    })),
  };
}

test("SQLite aggregateUsage matches the hydrate/buildUsageSummary path across filters (FEA-1834 §4)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    // metered (api), completed claude.
    await insertSession(db, {
      id: "s-claude-api",
      harness: "claude",
      billingMode: "api",
      status: "completed",
      startedAt: "2026-03-10T10:00:00.000Z",
    });
    // Second metered claude session in the SAME (billing, harness, model) group
    // as s-claude-api. The aggregation sums both sessions' tokens into one group
    // and costs once, so this exercises the linearity property against the
    // hydrate path (which costs each session, then sums).
    await insertSession(db, {
      id: "s-claude-api-2",
      harness: "claude",
      billingMode: "api",
      status: "completed",
      startedAt: "2026-03-09T10:00:00.000Z",
    });
    // subscription-covered claude — lands in the subscription ledger.
    await insertSession(db, {
      id: "s-claude-sub",
      harness: "claude",
      billingMode: "subscription_unknown",
      status: "completed",
      startedAt: "2026-03-11T10:00:00.000Z",
    });
    // active codex (no awaiting-input timestamp).
    await insertSession(db, {
      id: "s-codex-active",
      harness: "codex",
      billingMode: "api",
      status: "active",
      startedAt: "2026-03-12T10:00:00.000Z",
    });
    // waiting codex — non-terminal status + an awaiting-input timestamp.
    await insertSession(db, {
      id: "s-codex-waiting",
      harness: "codex",
      billingMode: "api",
      status: "running",
      startedAt: "2026-03-13T10:00:00.000Z",
      awaitingInputSince: "2026-03-13T12:00:00.000Z",
    });
    // ZERO-token claude session — must still count toward totalSessions and the
    // claude harness's sessionCount (the token join can't see it).
    await insertSession(db, {
      id: "s-claude-zero",
      harness: "claude",
      billingMode: "api",
      status: "completed",
      startedAt: "2026-03-14T10:00:00.000Z",
    });
    // error→failed canonicalization; opencode→unknown ledger; out-of-range date.
    await insertSession(db, {
      id: "s-error",
      harness: "opencode",
      billingMode: "opencode",
      status: "error",
      startedAt: "2026-01-05T10:00:00.000Z",
    });

    await insertToken(
      db,
      {
        sessionId: "s-claude-api",
        model: "claude-opus-4-5",
        inputTokens: 1500,
        outputTokens: 300,
        cacheReadTokens: 75,
        cacheWriteTokens: 15,
      },
      "2026-03-10T10:05:00.000Z"
    );
    await insertToken(
      db,
      {
        sessionId: "s-claude-api-2",
        model: "claude-opus-4-5",
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      },
      "2026-03-09T10:06:00.000Z"
    );
    await insertToken(
      db,
      {
        sessionId: "s-claude-sub",
        model: "claude-opus-4-5",
        inputTokens: 800,
        outputTokens: 160,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      "2026-03-11T10:05:00.000Z"
    );
    await insertToken(
      db,
      {
        sessionId: "s-codex-active",
        model: "gpt-5",
        inputTokens: 500,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      "2026-03-12T10:05:00.000Z"
    );
    await insertToken(
      db,
      {
        sessionId: "s-codex-waiting",
        model: "gpt-5",
        inputTokens: 200,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      "2026-03-13T10:05:00.000Z"
    );
    await insertToken(
      db,
      {
        sessionId: "s-error",
        model: "model-without-a-price",
        inputTokens: 90,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      "2026-01-05T10:05:00.000Z"
    );

    const withAggregate = db.syncSource as AgentSessionSyncSource;
    assert.ok(
      typeof withAggregate.aggregateUsage === "function",
      "the SQLite sync source must expose aggregateUsage"
    );
    // Reference path: identical source minus aggregateUsage → loadUsageSessions
    // → buildUsageSummary over the same corpus.
    const reference: AgentSessionSyncSource = {
      ...withAggregate,
      aggregateUsage: undefined,
    };

    const filters: SharedAgentSessionsQuery[] = [
      {},
      { harness: "claude" },
      { harness: "codex" },
      { harness: "nonexistent" },
      { status: "completed" },
      { status: "active" },
      // The shared UI still sends "error" for failed rows; the SQL aggregate
      // path must canonicalize requested aliases the same way rows are
      // canonicalized (`error` -> `failed`, `running` -> `active`).
      { status: "error" },
      { status: "running" },
      { status: "waiting" },
      { status: "failed" },
      { statuses: ["completed", "failed"] },
      { statuses: ["active", "waiting"] },
      { status: "completed", statuses: ["active"] },
      { startDate: "2026-03-01T00:00:00.000Z" },
      { endDate: "2026-03-11T23:59:59.000Z" },
      // Multi-condition WHERE: exercises `conditions.join(" AND ")` and
      // `placeholder()` numbering across simultaneous dimensions, including the
      // status branches that themselves contain an internal AND (FEA-1834 §2).
      { harness: "claude", status: "completed" },
      { harness: "codex", status: "active" },
      { harness: "codex", status: "waiting" },
      { harness: "claude", startDate: "2026-03-10T00:00:00.000Z" },
      {
        status: "completed",
        startDate: "2026-03-09T00:00:00.000Z",
        endDate: "2026-03-11T23:59:59.000Z",
      },
    ];

    for (const filter of filters) {
      const viaAggregate = await getSharedAgentSessionUsage(
        withAggregate,
        filter
      );
      const viaHydrate = await getSharedAgentSessionUsage(reference, filter);
      assert.deepEqual(
        normalizeUsage(viaAggregate),
        normalizeUsage(viaHydrate),
        `usage mismatch for filter ${JSON.stringify(filter)}`
      );
    }

    // Anchor a few absolute values so the parity helper can't pass by both paths
    // being wrong in the same way.
    const all = await getSharedAgentSessionUsage(withAggregate, {});
    assert.equal(all.totalSessions, 7, "unfiltered totalSessions");
    // Earliest/latest session start span the seeded corpus (s-error in January
    // through s-claude-zero in March), independent of token rows.
    assert.equal(
      all.earliestSessionAt,
      "2026-01-05T10:00:00.000Z",
      "unfiltered earliestSessionAt"
    );
    assert.equal(
      all.latestSessionAt,
      "2026-03-14T10:00:00.000Z",
      "unfiltered latestSessionAt"
    );
    assert.equal(all.totalInputTokens, 1500 + 1000 + 800 + 500 + 200 + 90);
    const claudeHarness = all.byHarness.find((row) => row.harness === "claude");
    assert.equal(
      claudeHarness?.sessionCount,
      4,
      "claude harness counts the zero-token session"
    );
    assert.ok(
      all.totalEstimatedCost > 0,
      "aggregate fallback prices legacy null-cost rows"
    );
    assert.ok(
      (claudeHarness?.estimatedCost ?? 0) > 0,
      "claude harness carries fallback cost"
    );

    const waiting = await getSharedAgentSessionUsage(withAggregate, {
      status: "waiting",
    });
    assert.equal(waiting.totalSessions, 1, "exactly one waiting session");

    const multiStatus = await getSharedAgentSessionUsage(withAggregate, {
      statuses: ["completed", "failed"],
    });
    assert.equal(
      multiStatus.totalSessions,
      5,
      "multi-status aggregate includes completed plus failed sessions"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3149: the Waiting usage facet excludes ended-but-non-terminal awaiting-input sessions (cloud parity)", async () => {
  const { db, dir } = await openTempDb();

  try {
    // Live waiting session: non-terminal status + awaiting-input timestamp, not
    // ended → Waiting on both cloud and desktop.
    await insertSession(db, {
      id: "s-waiting-live",
      harness: "codex",
      billingMode: "api",
      status: "running",
      startedAt: "2026-03-13T10:00:00.000Z",
      awaitingInputSince: "2026-03-13T12:00:00.000Z",
      endedAt: null,
    });
    // Ended-but-non-terminal awaiting-input session: cloud's projection
    // (`toAgentSessionState`) reports PendingApproval only while `!sessionEndedAt`
    // and its facet guards `sessionEndedAt == null`, so this row must NOT count as
    // Waiting. Before the fix the desktop predicate lacked the `ended_at IS NULL`
    // guard and double-counted it.
    await insertSession(db, {
      id: "s-waiting-ended",
      harness: "codex",
      billingMode: "api",
      status: "running",
      startedAt: "2026-03-13T11:00:00.000Z",
      awaitingInputSince: "2026-03-13T12:30:00.000Z",
      endedAt: "2026-03-13T13:00:00.000Z",
    });

    const withAggregate = db.syncSource as AgentSessionSyncSource;
    // Exercise both the SQL aggregate path and the hydrate/buildUsageSummary
    // reference path so the guard is proven on the aggregate predicate AND the
    // in-memory `matchesStatusFilter` fallback.
    const reference: AgentSessionSyncSource = {
      ...withAggregate,
      aggregateUsage: undefined,
    };

    const aggregateWaiting = await getSharedAgentSessionUsage(withAggregate, {
      status: "waiting",
    });
    const hydrateWaiting = await getSharedAgentSessionUsage(reference, {
      status: "waiting",
    });

    assert.equal(
      aggregateWaiting.totalSessions,
      1,
      "SQL aggregate Waiting facet excludes the ended awaiting-input session"
    );
    assert.equal(
      hydrateWaiting.totalSessions,
      1,
      "hydrate Waiting facet excludes the ended awaiting-input session"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => "2026-06-07T12:00:00.000Z",
  });
  return { db, dir };
}

test("SQLite usage and analytics aggregates apply user ownership filters", async () => {
  const { db, dir } = await openTempDb();

  try {
    await insertSession(db, {
      id: "alex-one",
      harness: "claude",
      billingMode: "api",
      status: "completed",
      startedAt: "2026-03-10T10:00:00.000Z",
      userId: "user-alex",
    });
    await insertSession(db, {
      id: "alex-two",
      harness: "codex",
      billingMode: "api",
      status: "completed",
      startedAt: "2026-03-11T10:00:00.000Z",
      userId: "user-alex",
    });
    await insertSession(db, {
      id: "peter-one",
      harness: "claude",
      billingMode: "api",
      status: "completed",
      startedAt: "2026-03-12T10:00:00.000Z",
      userId: "user-peter",
    });
    await insertSession(db, {
      id: "legacy-null-owner",
      harness: "claude",
      billingMode: "api",
      status: "completed",
      startedAt: "2026-03-13T10:00:00.000Z",
    });

    for (const id of [
      "alex-one",
      "alex-two",
      "peter-one",
      "legacy-null-owner",
    ]) {
      await insertToken(
        db,
        {
          sessionId: id,
          model: "gpt-5",
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        "2026-03-10T10:05:00.000Z"
      );
      await db.run(
        `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        `${id}-tool`,
        id,
        "tool_use",
        "Bash",
        "2026-03-10T10:06:00.000Z"
      );
      await db.run(
        `INSERT INTO agents (id, session_id, type, status, started_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        `${id}-agent`,
        id,
        "main",
        "completed",
        "2026-03-10T10:00:00.000Z",
        "2026-03-10T10:10:00.000Z"
      );
    }

    const withAggregate = db.syncSource as AgentSessionSyncSource;
    const reference: AgentSessionSyncSource = {
      ...withAggregate,
      aggregateUsage: undefined,
      aggregateAnalytics: undefined,
    };

    for (const filter of [
      { userId: "user-alex" },
      { userIds: ["user-alex", "user-peter"] },
      { userId: "user-missing" },
      { userId: "user-missing", userIds: ["user-alex"] },
    ] satisfies SharedAgentSessionsQuery[]) {
      const viaAggregate = await getSharedAgentSessionUsage(
        withAggregate,
        filter
      );
      const viaHydrate = await getSharedAgentSessionUsage(reference, filter);
      assert.deepEqual(
        normalizeUsage(viaAggregate),
        normalizeUsage(viaHydrate),
        `usage mismatch for user filter ${JSON.stringify(filter)}`
      );
    }

    const alexUsage = await getSharedAgentSessionUsage(withAggregate, {
      userId: "user-alex",
    });
    assert.equal(alexUsage.totalSessions, 2);

    const multiUsage = await getSharedAgentSessionUsage(withAggregate, {
      userIds: ["user-alex", "user-peter"],
    });
    assert.equal(multiUsage.totalSessions, 3);

    const nullOwnerExplicit = await getSharedAgentSessionUsage(withAggregate, {
      userId: "legacy-null-owner",
    });
    assert.equal(
      nullOwnerExplicit.totalSessions,
      0,
      "explicit user filters exclude NULL sessions.user_id rows"
    );

    const unfiltered = await getSharedAgentSessionUsage(withAggregate, {});
    assert.equal(
      unfiltered.totalSessions,
      4,
      "unfiltered totals keep NULL sessions.user_id rows"
    );

    const analytics = await withAggregate.aggregateAnalytics?.(
      { userId: "user-alex" },
      {
        attributionByCwd: new Map(),
        launchMetadataRootByCwd: new Map(),
        repoFullNameByPath: new Map(),
      }
    );
    assert.deepEqual(
      analytics?.byTool.map((row) => [
        row.toolName,
        row.invocationCount,
        row.sessionCount,
      ]),
      [["Bash", 2, 2]]
    );
    assert.deepEqual(
      analytics?.byAgentType.map((row) => [row.agentType, row.count]),
      [["main", 2]]
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-1834 §5/§6: NULL/literal-"unknown" harness rows must fold into a single
// "unknown" bucket, and NULL/empty/malformed `started_at` must coerce to epoch
// (matching `parseSessionDate`) rather than dropping from an `endDate` bound or
// — for empty/malformed text — throwing the whole date-filtered query.
test("SQLite aggregateUsage matches hydrate for mixed harness and malformed started_at (FEA-1834 §5/§6)", async () => {
  const { db, dir } = await openTempDb();

  try {
    // NULL harness and a literal "unknown" harness — the hydrate path merges both
    // into one "unknown" bucket; the aggregate must too.
    await insertSession(db, {
      id: "u-null-harness",
      harness: null,
      billingMode: "api",
      status: "completed",
      startedAt: "2026-03-10T10:00:00.000Z",
    });
    await insertSession(db, {
      id: "u-literal-unknown",
      harness: "unknown",
      billingMode: "api",
      status: "completed",
      startedAt: "2026-03-11T10:00:00.000Z",
    });
    // NULL / empty / malformed started_at — each must coerce to epoch, not throw.
    await insertSession(db, {
      id: "d-null-date",
      harness: "claude",
      billingMode: "api",
      status: "completed",
      startedAt: null,
    });
    await insertSession(db, {
      id: "d-empty-date",
      harness: "claude",
      billingMode: "api",
      status: "completed",
      startedAt: "",
    });
    await insertSession(db, {
      id: "d-bad-date",
      harness: "claude",
      billingMode: "api",
      status: "completed",
      startedAt: "not-a-timestamp",
    });

    const tokens: SeedToken[] = [
      {
        sessionId: "u-null-harness",
        model: "m1",
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 1,
      },
      {
        sessionId: "u-literal-unknown",
        model: "m1",
        inputTokens: 50,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      {
        sessionId: "d-null-date",
        model: "m1",
        inputTokens: 200,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      {
        sessionId: "d-empty-date",
        model: "m1",
        inputTokens: 300,
        outputTokens: 30,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      {
        sessionId: "d-bad-date",
        model: "m1",
        inputTokens: 400,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ];
    for (const token of tokens) {
      await insertToken(db, token, "2026-03-10T10:05:00.000Z");
    }

    const withAggregate = db.syncSource as AgentSessionSyncSource;
    const reference: AgentSessionSyncSource = {
      ...withAggregate,
      aggregateUsage: undefined,
    };

    const filters: SharedAgentSessionsQuery[] = [
      {},
      // Without the epoch coercion, the aggregate path THROWS here on the empty
      // and malformed rows (''/'not-a-timestamp')::timestamptz.
      { startDate: "2026-03-01T00:00:00.000Z" },
      { endDate: "2026-12-31T23:59:59.000Z" },
      { endDate: "2026-03-10T23:59:59.000Z" },
    ];

    for (const filter of filters) {
      const viaAggregate = await getSharedAgentSessionUsage(
        withAggregate,
        filter
      );
      const viaHydrate = await getSharedAgentSessionUsage(reference, filter);
      assert.deepEqual(
        normalizeUsage(viaAggregate),
        normalizeUsage(viaHydrate),
        `usage mismatch for filter ${JSON.stringify(filter)}`
      );
    }

    // NULL and "unknown" harness collapse to exactly one bucket of two sessions.
    const all = await getSharedAgentSessionUsage(withAggregate, {});
    const unknownBuckets = all.byHarness.filter(
      (row) => row.harness === "unknown"
    );
    assert.equal(
      unknownBuckets.length,
      1,
      "single merged unknown harness bucket"
    );
    assert.equal(unknownBuckets[0]?.sessionCount, 2);

    // Bounds ignore the NULL/empty/malformed rows entirely: earliest/latest
    // reflect only the two real timestamps, never the epoch-1970 fallback the
    // filter clause uses (FEA-1834 §6 regression — desktop must agree with the
    // API's _min/_max, which never sees such rows).
    assert.equal(
      all.earliestSessionAt,
      "2026-03-10T10:00:00.000Z",
      "earliest skips malformed started_at"
    );
    assert.equal(
      all.latestSessionAt,
      "2026-03-11T10:00:00.000Z",
      "latest skips malformed started_at"
    );

    // epoch-coerced rows: excluded by a 2026 startDate, included by an endDate.
    const fromMarch = await getSharedAgentSessionUsage(withAggregate, {
      startDate: "2026-03-01T00:00:00.000Z",
    });
    assert.equal(
      fromMarch.totalSessions,
      2,
      "startDate excludes the epoch-coerced rows"
    );
    const throughYear = await getSharedAgentSessionUsage(withAggregate, {
      endDate: "2026-12-31T23:59:59.000Z",
    });
    assert.equal(
      throughYear.totalSessions,
      5,
      "endDate keeps the epoch-coerced rows (parity with hydrate)"
    );
    // …but even though the epoch rows are counted, they still never appear in
    // the bounds — the date span stays the two real timestamps, not 1970.
    assert.equal(throughYear.earliestSessionAt, "2026-03-10T10:00:00.000Z");
    assert.equal(throughYear.latestSessionAt, "2026-03-11T10:00:00.000Z");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-1834 §7: ids and free-text-search usage requests must NOT consult
// aggregateUsage: ids are not represented by the aggregate predicate contract,
// and search would ignore hydrated attribution fields. Guards the
// `!Object.hasOwn(request, "ids")` and `query.search === null` bypasses.
test("ids and search usage requests bypass aggregateUsage (FEA-1834 §7)", async () => {
  const { db, dir } = await openTempDb();

  try {
    await insertSession(db, {
      id: "keep",
      harness: "claude",
      billingMode: "api",
      status: "completed",
      startedAt: "2026-03-10T10:00:00.000Z",
    });
    await insertSession(db, {
      id: "other",
      harness: "codex",
      billingMode: "api",
      status: "completed",
      startedAt: "2026-03-11T10:00:00.000Z",
    });
    await insertToken(
      db,
      {
        sessionId: "keep",
        model: "m1",
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      "2026-03-10T10:05:00.000Z"
    );

    const realSource = db.syncSource as AgentSessionSyncSource;
    const realAggregate = realSource.aggregateUsage;
    assert.ok(
      typeof realAggregate === "function",
      "the SQLite sync source must expose aggregateUsage"
    );

    const aggregateCalls: AgentSessionUsageAggregateFilters[] = [];
    const spied: AgentSessionSyncSource = {
      ...realSource,
      aggregateUsage: (filters) => {
        aggregateCalls.push(filters);
        return realAggregate(filters);
      },
    };

    // ids request: must fall through to the hydrate path, untouched by aggregate.
    const idsRequest: SharedAgentSessionsListRequest = { ids: ["keep"] };
    const scoped = await getSharedAgentSessionUsage(spied, idsRequest);
    assert.equal(
      aggregateCalls.length,
      0,
      "ids request must bypass aggregateUsage"
    );
    assert.equal(scoped.totalSessions, 1, "ids request summarizes only 'keep'");

    // Free-text search must also bypass aggregateUsage: the SQL aggregation
    // cannot match the hydrated repositoryFullName/baseBranch fields, so a search
    // request falls through to the full-hydrate path (parity with list search).
    await getSharedAgentSessionUsage(spied, { search: "keep" });
    assert.equal(
      aggregateCalls.length,
      0,
      "search request must bypass aggregateUsage"
    );

    // Sanity: a plain (no-ids, no-search) request DOES consult aggregateUsage.
    await getSharedAgentSessionUsage(spied, {});
    assert.equal(aggregateCalls.length, 1, "plain request uses aggregateUsage");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
