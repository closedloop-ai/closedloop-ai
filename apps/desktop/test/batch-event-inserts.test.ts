// perf/desktop-batch-event-inserts: the import path now writes per-event rows
// and token_events rows via chunked multi-row INSERTs instead of one INSERT per
// row. These tests pin the behavior-preserving contract: importing a session
// with MANY events writes ALL of them correctly, the chunking is exercised
// (event count far exceeds one chunk), and a re-import is idempotent (no
// duplicate rows) thanks to the preserved ON CONFLICT (id) DO NOTHING semantics
// and the token_events delete+reinsert.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

const ISO_BASE = Date.parse("2026-06-07T10:00:00.000Z");

/** Distinct ISO timestamp `offsetSeconds` after the base — keeps every event
 * row's deterministic id unique so none collapse under dedup. */
function ts(offsetSeconds: number): string {
  return new Date(ISO_BASE + offsetSeconds * 1000).toISOString();
}

/**
 * Build a session whose import emits `perCategory` events in EACH of the
 * batched categories (messageTimestamps, toolUses, turnDurations, apiErrors,
 * toolResultErrors, compactions) plus `perCategory` token_events. With
 * perCategory = 1000 this is 6000+ event rows and 1000 token_events rows — far
 * more than a single chunk (chunk cap is ~112 event rows / ~128 token rows),
 * so the chunk-boundary path is exercised.
 */
function makeLargeSession(perCategory: number): NormalizedSession {
  let t = 0;
  const next = () => ts(t++);

  const messageTimestamps = Array.from({ length: perCategory }, () => next());
  const toolUses = Array.from({ length: perCategory }, (_, i) => ({
    name: "Bash",
    timestamp: next(),
    input: { command: `echo ${i}` },
    // distinct id so same-tool events never collapse in the dedup key
    id: `toolu_${i}`,
  }));
  const turnDurations = Array.from({ length: perCategory }, (_, i) => ({
    timestamp: next(),
    durationMs: 100 + i,
  }));
  const apiErrors = Array.from({ length: perCategory }, (_, i) => ({
    timestamp: next(),
    message: `api error ${i}`,
    type: "overloaded",
  }));
  const toolResultErrors = Array.from({ length: perCategory }, (_, i) => ({
    timestamp: next(),
    content: `tool result error ${i}`,
  }));
  const compactions = Array.from({ length: perCategory }, (_, i) => ({
    uuid: `compaction-${i}`,
    timestamp: next(),
  }));
  const tokenSeries = Array.from({ length: perCategory }, (_, i) => ({
    timestamp: next(),
    model: "claude-sonnet-4-5",
    input: 10 + i,
    output: 5 + i,
    cacheRead: i,
    cacheWrite: i,
  }));

  return {
    sessionId: "batch-insert-session",
    name: "Batch insert session",
    cwd: "/workspace/test",
    model: "claude-sonnet-4-5",
    version: "1.0.0",
    slug: null,
    gitBranch: "main",
    startedAt: ts(0),
    endedAt: ts(t + 10),
    teams: [],
    userMessages: 1,
    assistantMessages: 1,
    tokensByModel: {
      "claude-sonnet-4-5": {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
      },
    },
    messageTimestamps,
    toolUses: toolUses as NormalizedSession["toolUses"],
    compactions: compactions as NormalizedSession["compactions"],
    apiErrors: apiErrors as NormalizedSession["apiErrors"],
    fileModifiedAt: null,
    turnDurations: turnDurations as NormalizedSession["turnDurations"],
    entrypoint: "claude",
    permissionMode: null,
    thinkingBlockCount: 0,
    toolResultErrors: toolResultErrors as NormalizedSession["toolResultErrors"],
    usageExtras: { service_tiers: [], speeds: [], inference_geos: [] },
    messages: [],
    tokenSeries,
    diffStats: null,
    slashCommands: [],
    artifacts: { prs: [], issues: [], repo: null },
  };
}

test("batch inserts: large session writes ALL events and token_events, idempotently", async () => {
  const perCategory = 1000;
  const dir = await mkdtemp(path.join(os.tmpdir(), "batch-event-inserts-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const session = makeLargeSession(perCategory);
    const first = await db.importer.importSession(session, "claude");
    assert.equal(first.skipped, false, "first import should not be skipped");

    // Each of the 6 batched event categories contributes `perCategory` rows.
    const expectedEvents = perCategory * 6;
    const eventsRow = await db.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
      "SELECT COUNT(*) AS cnt FROM events WHERE session_id = $1",
      session.sessionId
    );
    assert.equal(
      Number(eventsRow[0].cnt),
      expectedEvents,
      `all ${expectedEvents} event rows written`
    );

    const tokenRow = await db.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
      "SELECT COUNT(*) AS cnt FROM token_events WHERE session_id = $1",
      session.sessionId
    );
    assert.equal(
      Number(tokenRow[0].cnt),
      perCategory,
      `all ${perCategory} token_events rows written`
    );

    // Per-category breakdown — proves columns/ordering preserved, not just total.
    const byType = await db.prisma.client.$queryRawUnsafe<
      { event_type: string; cnt: number }[]
    >(
      "SELECT event_type, COUNT(*) AS cnt FROM events WHERE session_id = $1 GROUP BY event_type",
      session.sessionId
    );
    const counts = new Map(byType.map((r) => [r.event_type, Number(r.cnt)]));
    assert.equal(counts.get("Stop"), perCategory, "Stop events");
    assert.equal(counts.get("PostToolUse"), perCategory, "PostToolUse events");
    assert.equal(
      counts.get("TurnDuration"),
      perCategory,
      "TurnDuration events"
    );
    assert.equal(counts.get("APIError"), perCategory, "APIError events");
    assert.equal(counts.get("ToolError"), perCategory, "ToolError events");
    assert.equal(counts.get("Compaction"), perCategory, "Compaction events");

    // Spot-check a token_events row carries the correct normalized columns.
    const firstToken = await db.prisma.client.$queryRawUnsafe<
      {
        input_tokens: number;
        output_tokens: number;
      }[]
    >(
      "SELECT input_tokens, output_tokens FROM token_events WHERE session_id = $1 ORDER BY created_at ASC LIMIT 1",
      session.sessionId
    );
    assert.equal(Number(firstToken[0].input_tokens), 10, "token input col");
    assert.equal(Number(firstToken[0].output_tokens), 5, "token output col");

    // Re-import the SAME session: ON CONFLICT (id) DO NOTHING on events +
    // delete/reinsert on token_events must keep the row counts identical.
    await db.importer.importSession(session, "claude");
    const eventsAfter = await db.prisma.client.$queryRawUnsafe<
      { cnt: number }[]
    >(
      "SELECT COUNT(*) AS cnt FROM events WHERE session_id = $1",
      session.sessionId
    );
    assert.equal(
      Number(eventsAfter[0].cnt),
      expectedEvents,
      "event count unchanged after re-import (idempotent)"
    );
    const tokensAfter = await db.prisma.client.$queryRawUnsafe<
      { cnt: number }[]
    >(
      "SELECT COUNT(*) AS cnt FROM token_events WHERE session_id = $1",
      session.sessionId
    );
    assert.equal(
      Number(tokensAfter[0].cnt),
      perCategory,
      "token_events count unchanged after re-import (idempotent)"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
