/**
 * @file attribution-codex-parser.test.ts
 * @description Codex parser fixes (FEA-1459 Fixes 3, 4, 9).
 * Split out of the former fea1459-attribution-accuracy.test.ts (FEA-2235 D2).
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseRolloutFile } from "../src/main/collectors/codex/codex-parser.js";
import { InvalidTokenCountError } from "../src/main/token-counts.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  CODEX_UUID,
  emptyAttributionCache,
  LARGE_CACHE_READ_TOKENS,
  writeRollout,
} from "./attribution-test-helpers.js";

// ═══════════════════════════════════════════════════════════════════════════
// AREA 3: Codex parser (Fixes 3, 4, 9)
// ═══════════════════════════════════════════════════════════════════════════

test("Codex: input excludes cached tokens (Fix 3)", async () => {
  const filePath = writeRollout(
    `rollout-2026-05-18T10-00-00-${CODEX_UUID}.jsonl`,
    [
      {
        timestamp: "2026-05-18T10:00:00.000Z",
        type: "session_meta",
        payload: { id: CODEX_UUID, cwd: "/test", cli_version: "0.40.0" },
      },
      {
        timestamp: "2026-05-18T10:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.5" },
      },
      {
        timestamp: "2026-05-18T10:00:02.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "hello" },
      },
      {
        timestamp: "2026-05-18T10:00:05.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi" }],
        },
      },
      {
        timestamp: "2026-05-18T10:00:06.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1200,
              cached_input_tokens: 400,
              output_tokens: 300,
              reasoning_output_tokens: 50,
            },
          },
          turn_context: { model: "gpt-5.5" },
        },
      },
    ]
  );

  const parsed = await parseRolloutFile(filePath);
  assert.ok(parsed);

  // input = 1200 - 400 = 800 (non-cached)
  assert.deepEqual(parsed.tokensByModel["gpt-5.5"], {
    input: 800,
    output: 350,
    cacheRead: 400,
    cacheWrite: 0,
  });
});

test("Codex parser rejects unsafe token counters instead of rounding them", async () => {
  const filePath = writeRollout(
    `rollout-2026-05-18T10-02-00-${CODEX_UUID}.jsonl`,
    [
      {
        timestamp: "2026-05-18T10:02:00.000Z",
        type: "session_meta",
        payload: { id: CODEX_UUID, cwd: "/test" },
      },
      {
        timestamp: "2026-05-18T10:02:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "hello" },
      },
      {
        timestamp: "2026-05-18T10:02:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: Number.MAX_SAFE_INTEGER + 1,
              cached_input_tokens: 0,
              output_tokens: 1,
              reasoning_output_tokens: 0,
            },
          },
          turn_context: { model: "gpt-5.5" },
        },
      },
    ]
  );

  await assert.rejects(() => parseRolloutFile(filePath));
});

test("Codex parser keeps canonical zero values ahead of unsafe legacy aliases", async () => {
  const filePath = writeRollout(
    `rollout-2026-05-18T10-02-30-${CODEX_UUID}.jsonl`,
    [
      {
        timestamp: "2026-05-18T10:02:30.000Z",
        type: "session_meta",
        payload: { id: CODEX_UUID, cwd: "/test" },
      },
      {
        timestamp: "2026-05-18T10:02:31.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.5" },
      },
      {
        timestamp: "2026-05-18T10:02:32.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "hello" },
      },
      {
        timestamp: "2026-05-18T10:02:33.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 0,
              inputTokens: Number.MAX_SAFE_INTEGER + 1,
              cached_input_tokens: 0,
              cachedInputTokens: Number.MAX_SAFE_INTEGER + 1,
              output_tokens: 1,
              outputTokens: Number.MAX_SAFE_INTEGER + 1,
              reasoning_output_tokens: 0,
              reasoningOutputTokens: Number.MAX_SAFE_INTEGER + 1,
              cache_write_tokens: 0,
              cacheWriteTokens: Number.MAX_SAFE_INTEGER + 1,
              cache_creation_input_tokens: Number.MAX_SAFE_INTEGER + 1,
            },
          },
          turn_context: { model: "gpt-5.5" },
        },
      },
    ]
  );

  const parsed = await parseRolloutFile(filePath);
  assert.ok(parsed);
  assert.deepEqual(parsed.tokensByModel["gpt-5.5"], {
    input: 0,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("Codex parser rejects derived token sums above the safe IPC contract", async () => {
  const filePath = writeRollout(
    `rollout-2026-05-18T10-02-45-${CODEX_UUID}.jsonl`,
    [
      {
        timestamp: "2026-05-18T10:02:45.000Z",
        type: "session_meta",
        payload: { id: CODEX_UUID, cwd: "/test" },
      },
      {
        timestamp: "2026-05-18T10:02:46.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.5" },
      },
      {
        timestamp: "2026-05-18T10:02:47.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: Number.MAX_SAFE_INTEGER,
              reasoning_output_tokens: 1,
            },
          },
          turn_context: { model: "gpt-5.5" },
        },
      },
    ]
  );

  await assert.rejects(
    () => parseRolloutFile(filePath),
    InvalidTokenCountError
  );
});

test("Codex parser rejects unsafe counters from workflow journals", async () => {
  const filePath = writeRollout(
    `rollout-2026-05-18T10-03-00-${CODEX_UUID}.jsonl`,
    [
      {
        timestamp: "2026-05-18T10:03:00.000Z",
        type: "session_meta",
        payload: { id: CODEX_UUID, cwd: "/test" },
      },
      {
        timestamp: "2026-05-18T10:03:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "run workflow" },
      },
    ]
  );
  writeFileSync(
    path.join(path.dirname(filePath), "workflow-unsafe.jsonl"),
    `${JSON.stringify({
      type: "usage",
      model: "gpt-5-codex",
      tokens_input: 1,
      tokens_output: 1,
      tokens_cache_read: Number.MAX_SAFE_INTEGER + 1,
      tokens_cache_creation: 0,
    })}\n`,
    "utf8"
  );

  await assert.rejects(
    () => parseRolloutFile(filePath),
    InvalidTokenCountError
  );
});

test("Codex workflow journal large token counts import and sync-read exactly", async () => {
  const workflowSessionId = "33333333-3333-4333-8333-333333333333";
  const filePath = writeRollout(
    `rollout-2026-05-18T10-04-00-${workflowSessionId}.jsonl`,
    [
      {
        timestamp: "2026-05-18T10:04:00.000Z",
        type: "session_meta",
        payload: { id: workflowSessionId, cwd: "/test" },
      },
      {
        timestamp: "2026-05-18T10:04:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "run workflow" },
      },
    ]
  );
  writeFileSync(
    path.join(path.dirname(filePath), "workflow-large.jsonl"),
    `${JSON.stringify({
      type: "usage",
      model: "gpt-5-codex",
      tokens_input: 10_000,
      tokens_output: 5000,
      tokens_cache_read: LARGE_CACHE_READ_TOKENS,
      tokens_cache_creation: 50,
      session_id: "workflow-inner-session",
    })}\n`,
    "utf8"
  );

  const parsed = await parseRolloutFile(filePath);
  assert.ok(parsed);
  assert.equal(
    parsed.tokensByModel["workflow-agent"]?.cacheRead,
    LARGE_CACHE_READ_TOKENS
  );

  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2027-workflow-sqlite-"));
  const db = await openTestDb(dir);

  try {
    const result = await db.importer.importSession(parsed, "codex");
    assert.equal(result.failed, undefined);

    const usage = await db.tokenUsage.getBySession(workflowSessionId);
    const workflowUsage = usage.find((row) => row.model === "workflow-agent");
    assert.equal(workflowUsage?.cacheReadTokens, LARGE_CACHE_READ_TOKENS);

    const [detail] = await db.syncSource.loadSyncedSessions(
      [workflowSessionId],
      emptyAttributionCache()
    );
    const workflowSyncUsage = detail?.tokenUsageByModel.find(
      (row) => row.model === "workflow-agent"
    );
    assert.equal(workflowSyncUsage?.cacheReadTokens, LARGE_CACHE_READ_TOKENS);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex: delta math across multiple token_count events", async () => {
  const filePath = writeRollout(
    `rollout-2026-05-18T10-05-00-${CODEX_UUID}.jsonl`,
    [
      {
        timestamp: "2026-05-18T10:05:00.000Z",
        type: "session_meta",
        payload: { id: CODEX_UUID, cwd: "/test" },
      },
      {
        timestamp: "2026-05-18T10:05:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.5" },
      },
      {
        timestamp: "2026-05-18T10:05:02.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "q1" },
      },
      {
        timestamp: "2026-05-18T10:05:05.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "a1" }],
        },
      },
      {
        timestamp: "2026-05-18T10:05:06.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 200,
              output_tokens: 100,
              reasoning_output_tokens: 0,
            },
          },
          turn_context: { model: "gpt-5.5" },
        },
      },
      // Second turn: cumulative totals grow.
      {
        timestamp: "2026-05-18T10:06:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "q2" },
      },
      {
        timestamp: "2026-05-18T10:06:05.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "a2" }],
        },
      },
      {
        timestamp: "2026-05-18T10:06:06.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 2500,
              cached_input_tokens: 800,
              output_tokens: 300,
              reasoning_output_tokens: 20,
            },
          },
          turn_context: { model: "gpt-5.5" },
        },
      },
    ]
  );

  const parsed = await parseRolloutFile(filePath);
  assert.ok(parsed);

  // tokenSeries should have 2 delta records.
  assert.equal(parsed.tokenSeries.length, 2);

  // First record: nonCached = 1000-200=800 (delta from 0)
  assert.equal(parsed.tokenSeries[0].input, 800);
  assert.equal(parsed.tokenSeries[0].output, 100);
  assert.equal(parsed.tokenSeries[0].cacheRead, 200);

  // Second record: nonCached = (2500-800)-(1000-200) = 1700-800 = 900
  assert.equal(parsed.tokenSeries[1].input, 900);
  assert.equal(parsed.tokenSeries[1].output, 220); // (300+20)-(100+0)
  assert.equal(parsed.tokenSeries[1].cacheRead, 600); // 800-200

  // tokensByModel = sum of tokenSeries deltas (FEA-2343).
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.input, 1700); // 800+900
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.output, 320); // 100+220
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.cacheRead, 800); // 200+600
});

test("Codex: reset case (totals DROP mid-session) clamped at 0, no negatives", async () => {
  const filePath = writeRollout(
    `rollout-2026-05-18T10-10-00-${CODEX_UUID}.jsonl`,
    [
      {
        timestamp: "2026-05-18T10:10:00.000Z",
        type: "session_meta",
        payload: { id: CODEX_UUID, cwd: "/test" },
      },
      {
        timestamp: "2026-05-18T10:10:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.5" },
      },
      {
        timestamp: "2026-05-18T10:10:02.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "q1" },
      },
      {
        timestamp: "2026-05-18T10:10:05.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "a1" }],
        },
      },
      {
        timestamp: "2026-05-18T10:10:06.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 200,
              output_tokens: 500,
              reasoning_output_tokens: 0,
            },
          },
          turn_context: { model: "gpt-5.5" },
        },
      },
      // Reset: totals drop below previous.
      {
        timestamp: "2026-05-18T10:11:06.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 50,
              output_tokens: 10,
              reasoning_output_tokens: 0,
            },
          },
          turn_context: { model: "gpt-5.5" },
        },
      },
    ]
  );

  const parsed = await parseRolloutFile(filePath);
  assert.ok(parsed);

  // The first token_count produces a valid delta. The reset event clamps
  // deltas to 0 (all zero deltas are not pushed to tokenSeries).
  // Verify no negative values exist in any tokenSeries record.
  for (const rec of parsed.tokenSeries) {
    assert.ok(rec.input >= 0, "input delta must not be negative");
    assert.ok(rec.output >= 0, "output delta must not be negative");
    assert.ok(rec.cacheRead >= 0, "cacheRead delta must not be negative");
    assert.ok(rec.cacheWrite >= 0, "cacheWrite delta must not be negative");
  }

  // FEA-2343: tokensByModel now uses summed deltas, not cumulative snapshot.
  // Pre-reset tokens are counted (the delta from the first event is real work).
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.input, 800); // 1000-200 (first delta)
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.output, 500); // first delta output
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.cacheRead, 200); // first delta cacheRead
});

test("Codex: untimestamped leading token_count folded into first timestamped entry (FEA-2343)", async () => {
  const filePath = writeRollout(
    `rollout-2026-05-18T10-15-00-${CODEX_UUID}.jsonl`,
    [
      // Untimestamped token_count FIRST — before any timestamped record.
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 200,
              output_tokens: 100,
              reasoning_output_tokens: 0,
            },
          },
          turn_context: { model: "gpt-5.5" },
        },
      },
      // Session meta provides the first timestamp.
      {
        timestamp: "2026-05-18T10:15:00.000Z",
        type: "session_meta",
        payload: { id: CODEX_UUID, cwd: "/test" },
      },
      // Later timestamped token_count.
      {
        timestamp: "2026-05-18T10:15:10.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1500,
              cached_input_tokens: 300,
              output_tokens: 150,
              reasoning_output_tokens: 0,
            },
          },
          turn_context: { model: "gpt-5.5" },
        },
      },
    ]
  );

  const parsed = await parseRolloutFile(filePath);
  assert.ok(parsed);

  // The untimestamped delta (nonCached=800, output=100, cache=200) is deferred,
  // then folded into the first timestamped token entry.
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.input, 1200); // 800 + 400
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.output, 150); // 100 + 50
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.cacheRead, 300); // 200 + 100
});

test("Codex: untimestamped-only token_count flushed at end of parse (FEA-2343)", async () => {
  const filePath = writeRollout(
    `rollout-2026-05-18T10-16-00-${CODEX_UUID}.jsonl`,
    [
      // Session meta provides a timestamp, but no timestamped token_count follows.
      {
        timestamp: "2026-05-18T10:16:00.000Z",
        type: "session_meta",
        payload: { id: CODEX_UUID, cwd: "/test" },
      },
      {
        timestamp: "2026-05-18T10:16:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.5" },
      },
      {
        timestamp: "2026-05-18T10:16:02.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "hello" },
      },
      // Untimestamped token_count — no timestamped token_count follows.
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 500,
              cached_input_tokens: 100,
              output_tokens: 50,
              reasoning_output_tokens: 0,
            },
          },
          turn_context: { model: "gpt-5.5" },
        },
      },
    ]
  );

  const parsed = await parseRolloutFile(filePath);
  assert.ok(parsed);

  // The deferred delta is flushed at end-of-parse using acc.lastTs.
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.input, 400); // 500-100
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.output, 50);
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.cacheRead, 100);
});

test("Codex: burst skip — >=20 records within <5s span returns null", async () => {
  const lines: unknown[] = [
    {
      timestamp: "2026-05-22T15:18:00.000Z",
      type: "session_meta",
      payload: { id: CODEX_UUID, cwd: "/test" },
    },
  ];
  for (let i = 0; i < 24; i++) {
    const ts = `2026-05-22T15:18:00.${String(i * 40).padStart(3, "0")}Z`;
    lines.push({
      timestamp: ts,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `line ${i}` }],
      },
    });
  }

  const filePath = writeRollout(
    `rollout-2026-05-22T15-18-00-${CODEX_UUID}.jsonl`,
    lines
  );

  const parsed = await parseRolloutFile(filePath);
  // Should be skipped (null) due to burst detection.
  assert.equal(parsed, null);
});

test("Codex: 19 records sub-second — NOT skipped", async () => {
  const lines: unknown[] = [
    {
      timestamp: "2026-05-22T15:18:00.000Z",
      type: "session_meta",
      payload: { id: CODEX_UUID, cwd: "/test" },
    },
  ];
  // 18 response items -> 18 assistant messages in recordCount.
  for (let i = 0; i < 18; i++) {
    lines.push({
      timestamp: `2026-05-22T15:18:00.${String(i * 50).padStart(3, "0")}Z`,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `line ${i}` }],
      },
    });
  }

  const filePath = writeRollout(
    `rollout-2026-05-22T15-18-01-${CODEX_UUID}.jsonl`,
    lines
  );

  const parsed = await parseRolloutFile(filePath);
  // Should NOT be skipped — recordCount < 20.
  assert.ok(parsed);
});

test("Codex: 20+ records spanning >5s — NOT skipped (genuine session)", async () => {
  const lines: unknown[] = [
    {
      timestamp: "2026-05-22T15:18:00.000Z",
      type: "session_meta",
      payload: { id: CODEX_UUID, cwd: "/test" },
    },
  ];
  // 24 records spread over 30 seconds.
  for (let i = 0; i < 24; i++) {
    const seconds = String(i + 1).padStart(2, "0");
    lines.push({
      timestamp: `2026-05-22T15:18:${seconds}.000Z`,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `line ${i}` }],
      },
    });
  }

  const filePath = writeRollout(
    `rollout-2026-05-22T15-18-02-${CODEX_UUID}.jsonl`,
    lines
  );

  const parsed = await parseRolloutFile(filePath);
  assert.ok(parsed);
  assert.ok(parsed.assistantMessages >= 20);
});

test("Codex: codex-auto-review never becomes session model (Fix 9)", async () => {
  const filePath = writeRollout(
    `rollout-2026-05-18T10-20-00-${CODEX_UUID}.jsonl`,
    [
      {
        timestamp: "2026-05-18T10:20:00.000Z",
        type: "session_meta",
        payload: { id: CODEX_UUID, cwd: "/test" },
      },
      {
        timestamp: "2026-05-18T10:20:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.5" },
      },
      {
        timestamp: "2026-05-18T10:20:02.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "q" },
      },
      {
        timestamp: "2026-05-18T10:20:05.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "a" }],
        },
      },
      {
        timestamp: "2026-05-18T10:20:06.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 500,
              cached_input_tokens: 100,
              output_tokens: 100,
              reasoning_output_tokens: 0,
            },
          },
          turn_context: { model: "gpt-5.5" },
        },
      },
      // A codex-auto-review turn_context should not become session model.
      {
        timestamp: "2026-05-18T10:20:10.000Z",
        type: "turn_context",
        payload: { model: "codex-auto-review" },
      },
      {
        timestamp: "2026-05-18T10:20:15.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 800,
              cached_input_tokens: 200,
              output_tokens: 200,
              reasoning_output_tokens: 0,
            },
          },
          turn_context: { model: "codex-auto-review" },
        },
      },
    ]
  );

  const parsed = await parseRolloutFile(filePath);
  assert.ok(parsed);

  // Session model is gpt-5.5, NOT codex-auto-review.
  assert.equal(parsed.model, "gpt-5.5");

  // But the token rows keep the codex-auto-review label in tokenSeries.
  const autoReviewRecords = parsed.tokenSeries.filter(
    (r) => r.model === "codex-auto-review"
  );
  assert.ok(
    autoReviewRecords.length > 0,
    "codex-auto-review token records preserved"
  );
});
