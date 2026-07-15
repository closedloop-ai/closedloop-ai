/**
 * @file attribution-claude-token-dedup.test.ts
 * @description Claude parser token dedup (FEA-1459 Fix 1).
 * Split out of the former fea1459-attribution-accuracy.test.ts (FEA-2235 D2).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { InvalidTokenCountError } from "../src/main/token-counts.js";
import { writeClaudeTranscript } from "./normalized-session-test-utils.js";

// ═══════════════════════════════════════════════════════════════════════════
// AREA 1: Claude parser token dedup (Fix 1)
// ═══════════════════════════════════════════════════════════════════════════

test("Claude dedup: one API turn spanning N lines counts usage ONCE", async () => {
  // 3 lines sharing the same message.id + requestId with identical usage.
  // Only content blocks differ (thinking, text, tool_use).
  const filePath = writeClaudeTranscript("dedup-single-turn", [
    {
      type: "user",
      timestamp: "2026-06-07T10:00:00.000Z",
      cwd: "/test",
      message: { content: [{ type: "text", text: "hello" }] },
    },
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:05.000Z",
      uuid: "line-uuid-1",
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
      uuid: "line-uuid-2",
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
        content: [{ type: "text", text: "response text" }],
      },
    },
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:07.000Z",
      uuid: "line-uuid-3",
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
        content: [
          {
            type: "tool_use",
            name: "Read",
            id: "toolu_01",
            input: { file_path: "x" },
          },
        ],
      },
    },
  ]);

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  // tokensByModel counts usage ONCE (not 3x).
  assert.deepEqual(parsed.tokensByModel["claude-opus-4-5"], {
    input: 200,
    output: 100,
    cacheRead: 50,
    cacheWrite: 25,
  });

  // tokenSeries has ONE record with the FIRST line's timestamp.
  assert.equal(parsed.tokenSeries.length, 1);
  assert.equal(parsed.tokenSeries[0].timestamp, "2026-06-07T10:00:05.000Z");

  // messageTimestamps has one entry per turn.
  assert.equal(parsed.messageTimestamps.length, 1);

  // assistantMessages == number of turns (1, not 3).
  assert.equal(parsed.assistantMessages, 1);
});

test("Claude parser rejects unsafe token counters instead of rounding them", async () => {
  const filePath = writeClaudeTranscript("unsafe-token-count", [
    {
      type: "user",
      timestamp: "2026-06-07T10:00:00.000Z",
      cwd: "/test",
    },
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:05.000Z",
      uuid: "unsafe-token-line",
      requestId: "req_unsafe",
      message: {
        id: "msg_unsafe",
        model: "claude-opus-4-5",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: Number.MAX_SAFE_INTEGER + 1,
          cache_creation_input_tokens: 0,
        },
        content: [{ type: "text", text: "response text" }],
      },
    },
  ]);

  await assert.rejects(() => parseClaudeFile(filePath), InvalidTokenCountError);
});

test("Claude dedup: progressive-snapshot — last-occurrence-wins", async () => {
  // Same key but usage values GROW across lines.
  const filePath = writeClaudeTranscript("dedup-progressive", [
    {
      type: "user",
      timestamp: "2026-06-07T10:00:00.000Z",
      cwd: "/test",
    },
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:05.000Z",
      uuid: "u1",
      requestId: "req_002",
      message: {
        id: "msg_002",
        model: "claude-opus-4-5",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
        content: [{ type: "text", text: "partial" }],
      },
    },
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:08.000Z",
      uuid: "u2",
      requestId: "req_002",
      message: {
        id: "msg_002",
        model: "claude-opus-4-5",
        usage: {
          input_tokens: 200,
          output_tokens: 150,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 15,
        },
        content: [{ type: "text", text: "full response" }],
      },
    },
  ]);

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  // Last-occurrence-wins: final values (200/150/30/15), not first or sum.
  assert.deepEqual(parsed.tokensByModel["claude-opus-4-5"], {
    input: 200,
    output: 150,
    cacheRead: 30,
    cacheWrite: 15,
  });

  // tokenSeries uses firstTs (the first line's timestamp).
  assert.equal(parsed.tokenSeries[0].timestamp, "2026-06-07T10:00:05.000Z");
  // But carries the last-wins values.
  assert.equal(parsed.tokenSeries[0].output, 150);
});

test("Claude dedup: lines with no message.id use uuid fallback, never collapse together", async () => {
  // Two distinct id-less usage lines must NOT collapse together.
  const filePath = writeClaudeTranscript("dedup-no-msgid", [
    {
      type: "user",
      timestamp: "2026-06-07T10:00:00.000Z",
      cwd: "/test",
    },
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:05.000Z",
      uuid: "uuid-aaa",
      message: {
        model: "claude-opus-4-5",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        content: [{ type: "text", text: "first" }],
      },
    },
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:10.000Z",
      uuid: "uuid-bbb",
      message: {
        model: "claude-opus-4-5",
        usage: {
          input_tokens: 300,
          output_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        content: [{ type: "text", text: "second" }],
      },
    },
  ]);

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  // Two separate turns -> both counted.
  assert.deepEqual(parsed.tokensByModel["claude-opus-4-5"], {
    input: 400,
    output: 250,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(parsed.tokenSeries.length, 2);
  assert.equal(parsed.assistantMessages, 2);
});

test("Claude dedup: <synthetic> model lines are ignored", async () => {
  const filePath = writeClaudeTranscript("dedup-synthetic", [
    {
      type: "user",
      timestamp: "2026-06-07T10:00:00.000Z",
      cwd: "/test",
    },
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:05.000Z",
      uuid: "u1",
      message: {
        model: "<synthetic>",
        usage: {
          input_tokens: 999,
          output_tokens: 999,
          cache_read_input_tokens: 999,
          cache_creation_input_tokens: 999,
        },
        content: [{ type: "text", text: "synthetic" }],
      },
    },
  ]);

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  // No tokens attributed.
  assert.deepEqual(parsed.tokensByModel, {});
  assert.equal(parsed.tokenSeries.length, 0);
});

test("Claude dedup: two turns with different requestIds counted separately", async () => {
  const filePath = writeClaudeTranscript("dedup-two-turns", [
    {
      type: "user",
      timestamp: "2026-06-07T10:00:00.000Z",
      cwd: "/test",
    },
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:05.000Z",
      uuid: "u1",
      requestId: "req_A",
      message: {
        id: "msg_A",
        model: "claude-opus-4-5",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        content: [{ type: "text", text: "turn1" }],
      },
    },
    {
      type: "user",
      timestamp: "2026-06-07T10:01:00.000Z",
    },
    {
      type: "assistant",
      timestamp: "2026-06-07T10:01:05.000Z",
      uuid: "u2",
      requestId: "req_B",
      message: {
        id: "msg_B",
        model: "claude-opus-4-5",
        usage: {
          input_tokens: 300,
          output_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        content: [{ type: "text", text: "turn2" }],
      },
    },
  ]);

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  assert.deepEqual(parsed.tokensByModel["claude-opus-4-5"], {
    input: 400,
    output: 250,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(parsed.tokenSeries.length, 2);
  assert.equal(parsed.assistantMessages, 2);
  assert.equal(parsed.messageTimestamps.length, 2);
});
