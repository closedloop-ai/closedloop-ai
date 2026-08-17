import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  getSharedAgentSessions,
  getSharedAgentSessionUsage,
} from "../src/main/session/shared-agent-sessions-api.js";

// FEA-4303 (threads codex P1 + wongk): the Model facet must be sourced from the
// PRIMARY displayed model (`sessions.model`) on BOTH desktop usage paths — the
// hydrate `buildUsageSummary` fold AND the O(grouped) SQL `foldUsageAggregate` —
// and the list predicate must filter on that same primary model, NOT the
// per-token-usage `model` (which spans secondary/subagent models). This keeps
// the facet options, the predicate, and the Model column on one vocabulary.

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

async function insertSession(
  db: SqliteDb,
  id: string,
  primaryModel: string | null
): Promise<void> {
  await db.run(
    `INSERT INTO sessions
       (id, status, started_at, updated_at, ended_at, harness, billing_mode, model)
     VALUES ($1, 'completed', $2, $2, NULL, 'claude', 'api', $3)`,
    id,
    "2026-03-10T10:00:00.000Z",
    primaryModel
  );
}

async function insertToken(
  db: SqliteDb,
  sessionId: string,
  model: string
): Promise<void> {
  await db.run(
    `INSERT INTO token_usage (
       session_id, model, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, raw_input, raw_output,
       raw_cache_read, raw_cache_write, created_at, updated_at
     )
     VALUES ($1, $2, 100, 50, 0, 0, 100, 50, 0, 0, $3, $3)`,
    sessionId,
    model,
    "2026-03-10T10:05:00.000Z"
  );
}

// Seed a corpus where the PRIMARY model set and the token-usage model set
// deliberately diverge: session A's primary is claude-opus but it also spent a
// subagent model claude-haiku; session B's primary is claude-sonnet. So the
// primary vocabulary is {opus, sonnet} while byModel spans {opus, haiku, sonnet}.
async function seedDivergentCorpus(db: SqliteDb): Promise<void> {
  await insertSession(db, "s-a", "claude-opus");
  await insertSession(db, "s-b", "claude-sonnet");
  // Session with no primary model — its Model column is blank, so it must NOT
  // produce a facet option.
  await insertSession(db, "s-c", null);
  await insertToken(db, "s-a", "claude-opus");
  await insertToken(db, "s-a", "claude-haiku"); // subagent, primary is opus
  await insertToken(db, "s-b", "claude-sonnet");
  await insertToken(db, "s-c", "claude-opus");
}

function withoutAggregate(
  source: AgentSessionSyncSource
): AgentSessionSyncSource {
  // Strip aggregateUsage so getSharedAgentSessionUsage falls back to the
  // hydrate → buildUsageSummary path (mirrors the sibling parity test).
  return { ...source, aggregateUsage: undefined };
}

test("Model facet options come from the primary model, distinct from byModel — both usage paths (FEA-4303)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await seedDivergentCorpus(db);
    const source = db.syncSource as AgentSessionSyncSource;

    for (const [label, resolved] of [
      ["aggregate", source],
      ["hydrate", withoutAggregate(source)],
    ] as const) {
      const usage = await getSharedAgentSessionUsage(resolved, {});

      const facetModels = (usage.modelFilterOptions ?? [])
        .map((option) => option.model)
        .sort();
      assert.deepEqual(
        facetModels,
        ["claude-opus", "claude-sonnet"],
        `${label}: facet options are the two PRIMARY models, null dropped`
      );

      const byModelModels = usage.byModel.map((row) => row.model).sort();
      // byModel spans every token-usage model, INCLUDING the subagent-only one.
      assert.ok(
        byModelModels.includes("claude-haiku"),
        `${label}: byModel carries the subagent-only model`
      );
      // The load-bearing invariant: the subagent model is NEVER a facet option.
      assert.ok(
        !facetModels.includes("claude-haiku"),
        `${label}: subagent model must not be a selectable Model option`
      );
    }
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("List predicate filters on the primary model, not per-token-usage models (FEA-4303)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await seedDivergentCorpus(db);
    const source = db.syncSource as AgentSessionSyncSource;

    // Filtering by the subagent-only model returns NOTHING: it is no session's
    // primary model, even though session s-a's token usage includes it. Before
    // the fix this matched s-a via `tokenUsageByModel.some`.
    const haiku = await getSharedAgentSessions(source, {
      models: ["claude-haiku"],
    });
    assert.equal(
      haiku.total,
      0,
      "claude-haiku is only a subagent model → no primary-model match"
    );

    // Filtering by a real primary model returns exactly the session it paints.
    const opus = await getSharedAgentSessions(source, {
      models: ["claude-opus"],
    });
    assert.deepEqual(
      opus.items.map((item) => item.id).sort(),
      ["s-a"],
      "claude-opus matches only the session whose PRIMARY model is claude-opus"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
