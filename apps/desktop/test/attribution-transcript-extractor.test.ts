/**
 * @file attribution-transcript-extractor.test.ts
 * @description transcript.ts live-hook token extractor (FEA-1459 Fixes 1, 5).
 * Split out of the former fea1459-attribution-accuracy.test.ts (FEA-2235 D2).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { extractTranscriptTokens } from "../src/main/database/transcript.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  LARGE_CACHE_READ_TOKENS,
  writeTranscriptFile,
} from "./attribution-test-helpers.js";

// ═══════════════════════════════════════════════════════════════════════════
// AREA 6: transcript.ts live-hook extractor (Fixes 1, 5)
// ═══════════════════════════════════════════════════════════════════════════

test("extractTranscriptTokens: dedupes by (message.id, requestId)", () => {
  const filePath = writeTranscriptFile([
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:05.000Z",
      uuid: "line-1",
      requestId: "req_001",
      message: {
        id: "msg_001",
        model: "claude-opus-4-5",
        usage: {
          input_tokens: 200,
          output_tokens: 100,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 25,
        },
        content: [{ type: "thinking", thinking: "hmm" }],
      },
    },
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:06.000Z",
      uuid: "line-2",
      requestId: "req_001",
      message: {
        id: "msg_001",
        model: "claude-opus-4-5",
        usage: {
          input_tokens: 200,
          output_tokens: 100,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 25,
        },
        content: [{ type: "text", text: "response" }],
      },
    },
    {
      type: "assistant",
      timestamp: "2026-06-07T10:01:00.000Z",
      uuid: "line-3",
      requestId: "req_002",
      message: {
        id: "msg_002",
        model: "claude-opus-4-5",
        usage: {
          input_tokens: 300,
          output_tokens: 150,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        },
        content: [{ type: "text", text: "second turn" }],
      },
    },
  ]);

  const result = extractTranscriptTokens(filePath);
  assert.ok(result);

  // Totals should be deduped: turn 1 (200/100/50/25) + turn 2 (300/150/100/50).
  const counts = result.tokensByModel.get("claude-opus-4-5");
  assert.ok(counts);
  assert.equal(counts.input, 500);
  assert.equal(counts.output, 250);
  assert.equal(counts.cacheRead, 150);
  assert.equal(counts.cacheWrite, 75);

  // records: one per turn (dedup key), with timestamps.
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].timestamp, "2026-06-07T10:00:05.000Z");
  assert.equal(result.records[1].timestamp, "2026-06-07T10:01:00.000Z");
});

test("extractTranscriptTokens: missing file returns null", () => {
  assert.equal(extractTranscriptTokens("/nonexistent/path.jsonl"), null);
});

test("extractTranscriptTokens: <synthetic> model ignored", () => {
  const filePath = writeTranscriptFile([
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:05.000Z",
      uuid: "u1",
      message: {
        model: "<synthetic>",
        usage: { input_tokens: 999, output_tokens: 999 },
        content: [],
      },
    },
  ]);

  const result = extractTranscriptTokens(filePath);
  assert.ok(result);
  assert.equal(result.tokensByModel.size, 0);
  assert.equal(result.records.length, 0);
});

test("live hook imports a real transcript with large cache-read counters exactly", async () => {
  const transcriptPath = writeTranscriptFile([
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:30.000Z",
      uuid: "live-large-line",
      requestId: "req_live_large",
      message: {
        id: "msg_live_large",
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 10_000,
          output_tokens: 5000,
          cache_read_input_tokens: LARGE_CACHE_READ_TOKENS,
          cache_creation_input_tokens: 50,
        },
        content: [{ type: "text", text: "large live response" }],
      },
    },
  ]);
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2027-live-hook-"));
  const db = await openTestDb(dir);

  try {
    const processed = await db.processEvent(
      "PostToolUse",
      {
        session_id: "large-live-hook-session",
        session_name: "Large live hook session",
        cwd: "/workspace/large-live-hook-session",
        model: "claude-opus-4-8",
        transcript_path: transcriptPath,
      },
      "claude"
    );

    assert.equal(processed, true);
    const usage = await db.tokenUsage.getBySession("large-live-hook-session");
    assert.equal(usage.length, 1);
    assert.equal(usage[0].cacheReadTokens, LARGE_CACHE_READ_TOKENS);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live hook rejects unsafe transcript counters without writing token rows", async () => {
  const transcriptPath = writeTranscriptFile([
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:30.000Z",
      uuid: "live-unsafe-line",
      requestId: "req_live_unsafe",
      message: {
        id: "msg_live_unsafe",
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 10_000,
          output_tokens: 5000,
          cache_read_input_tokens: Number.MAX_SAFE_INTEGER + 1,
          cache_creation_input_tokens: 50,
        },
        content: [{ type: "text", text: "unsafe live response" }],
      },
    },
  ]);
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2027-live-unsafe-"));
  const db = await openTestDb(dir);

  try {
    const processed = await db.processEvent(
      "PostToolUse",
      {
        session_id: "unsafe-live-hook-session",
        session_name: "Unsafe live hook session",
        cwd: "/workspace/unsafe-live-hook-session",
        model: "claude-opus-4-8",
        transcript_path: transcriptPath,
      },
      "claude"
    );

    assert.equal(processed, false);
    assert.deepEqual(
      await db.tokenUsage.getBySession("unsafe-live-hook-session"),
      []
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
