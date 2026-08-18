/**
 * @file live-hook-cache-ttl.test.ts
 * @description FEA-3419: the live-hook path carries the cache-write TTL split
 * end-to-end through the REAL `createTranscriptCache` — no `TranscriptExtract`
 * mocks. The live extractor bypasses `foldDedupMap` (its own
 * `buildExtractFromDedupMap` re-folds the dedup map), so these tests are the
 * proof that the split survives the real extraction (cold read AND the
 * incremental-growth cached path), that the shared `recordUsageLine` validator
 * rejects an over-total split on the live path too, and that live-appended
 * token_events price 1-hour writes at the 2x rate in-flight.
 */
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { createTranscriptCache } from "../src/main/database/transcript.js";
import { estimateTokenCost } from "../src/shared/token-cost.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

function assistantLine(opts: {
  messageId: string;
  timestamp: string;
  cacheWrite: number;
  breakdown?: { fiveM: number; oneH: number };
}): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: opts.timestamp,
    requestId: `req-${opts.messageId}`,
    message: {
      id: opts.messageId,
      role: "assistant",
      model: "claude-opus-4-5",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: opts.cacheWrite,
        ...(opts.breakdown
          ? {
              cache_creation: {
                ephemeral_5m_input_tokens: opts.breakdown.fiveM,
                ephemeral_1h_input_tokens: opts.breakdown.oneH,
              },
            }
          : {}),
      },
    },
  })}\n`;
}

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "live-hook-ttl-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    // The REAL cached extractor — the surface under test.
    extractTranscript: createTranscriptCache(),
    now: () => "2026-06-07T12:00:00.000Z",
  });
  return { db, dir };
}

function selectEventRows(
  db: SqliteDb,
  sessionId: string
): Promise<
  {
    created_at: string;
    cache_write_tokens: number | bigint;
    cache_write_5m_tokens: number | bigint | null;
    cache_write_1h_tokens: number | bigint | null;
    cost_usd_estimated: number | null;
  }[]
> {
  return db.prisma.client.$queryRawUnsafe(
    `SELECT created_at, cache_write_tokens, cache_write_5m_tokens,
            cache_write_1h_tokens, cost_usd_estimated
       FROM token_events WHERE session_id = $1 ORDER BY created_at`,
    sessionId
  );
}

test("real transcript cache carries the TTL split into live token rows and prices 1h at 2x", async () => {
  const { db, dir } = await openTempDb();
  const transcriptPath = path.join(dir, "live-session.jsonl");
  try {
    // Cold read: one turn with a half-1h split, one legacy turn (no breakdown).
    writeFileSync(
      transcriptPath,
      assistantLine({
        messageId: "m1",
        timestamp: "2026-06-07T11:00:00.000Z",
        cacheWrite: 1000,
        breakdown: { fiveM: 600, oneH: 400 },
      }) +
        assistantLine({
          messageId: "m2",
          timestamp: "2026-06-07T11:01:00.000Z",
          cacheWrite: 500,
        })
    );
    await db.processEvent(
      "PostToolUse",
      {
        session_id: "live-ttl",
        session_name: "Live TTL session",
        cwd: "/workspace/live-ttl",
        model: "claude-opus-4-5",
        transcript_path: transcriptPath,
      },
      "claude"
    );

    const events = await selectEventRows(db, "live-ttl");
    assert.equal(events.length, 2);
    // Turn 1: reported split persisted per event.
    assert.equal(Number(events[0].cache_write_5m_tokens), 600);
    assert.equal(Number(events[0].cache_write_1h_tokens), 400);
    // Turn 2: absent provenance stays NULL (not 0/0).
    assert.equal(events[1].cache_write_5m_tokens, null);
    assert.equal(events[1].cache_write_1h_tokens, null);

    // The 1h event's cost includes the 2x premium — exactly what the engine
    // returns when the 1h count is supplied, strictly more than without it.
    const withTtl = estimateTokenCost({
      model: "claude-opus-4-5",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 1000,
      cacheWrite1hTokens: 400,
      observedAt: "2026-06-07T11:00:00.000Z",
    });
    const withoutTtl = estimateTokenCost({
      model: "claude-opus-4-5",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 1000,
      observedAt: "2026-06-07T11:00:00.000Z",
    });
    assert.ok(withTtl && withoutTtl);
    assert.ok((withTtl?.costUsd ?? 0) > (withoutTtl?.costUsd ?? 0));
    assert.equal(events[0].cost_usd_estimated, withTtl?.costUsd);

    // token_usage carries the per-model split (current-only columns).
    const usage = await db.prisma.client.$queryRawUnsafe<
      {
        cache_write_5m_tokens: number | bigint | null;
        cache_write_1h_tokens: number | bigint | null;
      }[]
    >(
      "SELECT cache_write_5m_tokens, cache_write_1h_tokens FROM token_usage WHERE session_id = $1",
      "live-ttl"
    );
    assert.equal(Number(usage[0].cache_write_5m_tokens), 600);
    assert.equal(Number(usage[0].cache_write_1h_tokens), 400);

    // Incremental growth: append a new 1h turn — the cached extractor takes the
    // grew-in-place path (same mtime semantics differ per FS; the extractor
    // falls back to full re-read when unsure, both must carry the split).
    appendFileSync(
      transcriptPath,
      assistantLine({
        messageId: "m3",
        timestamp: "2026-06-07T11:02:00.000Z",
        cacheWrite: 200,
        breakdown: { fiveM: 0, oneH: 200 },
      })
    );
    await db.processEvent(
      "PostToolUse",
      {
        session_id: "live-ttl",
        session_name: "Live TTL session",
        cwd: "/workspace/live-ttl",
        model: "claude-opus-4-5",
        transcript_path: transcriptPath,
      },
      "claude"
    );
    const grown = await selectEventRows(db, "live-ttl");
    assert.equal(grown.length, 3);
    assert.equal(Number(grown[2].cache_write_5m_tokens), 0);
    assert.equal(Number(grown[2].cache_write_1h_tokens), 200);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("real cache rejects an over-total split on the live path (shared validator)", async () => {
  const { db, dir } = await openTempDb();
  const transcriptPath = path.join(dir, "over-total.jsonl");
  try {
    // fiveM + oneH (800 + 300) exceeds cache_creation_input_tokens (1000) →
    // the shared recordUsageLine validator rejects the ENTIRE split to absent,
    // on the live path exactly as on the historical parser path.
    writeFileSync(
      transcriptPath,
      assistantLine({
        messageId: "m-over",
        timestamp: "2026-06-07T11:00:00.000Z",
        cacheWrite: 1000,
        breakdown: { fiveM: 800, oneH: 300 },
      })
    );
    await db.processEvent(
      "PostToolUse",
      {
        session_id: "live-over",
        session_name: "Live over-total",
        cwd: "/workspace/live-over",
        model: "claude-opus-4-5",
        transcript_path: transcriptPath,
      },
      "claude"
    );
    const events = await selectEventRows(db, "live-over");
    assert.equal(events.length, 1);
    assert.equal(events[0].cache_write_5m_tokens, null);
    assert.equal(events[0].cache_write_1h_tokens, null);
    // The canonical total is untouched and priced at the default rate.
    assert.equal(Number(events[0].cache_write_tokens), 1000);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
