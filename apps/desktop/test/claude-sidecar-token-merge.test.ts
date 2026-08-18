/**
 * @file claude-sidecar-token-merge.test.ts
 * @description Subagent transcript merge (FEA-1459 Fix 2).
 * Split out of the former fea1459-attribution-accuracy.test.ts (FEA-2235 D2).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { writeClaudeTranscript } from "./normalized-session-test-utils.js";

// ═══════════════════════════════════════════════════════════════════════════
// AREA 2: Subagent transcript merge (Fix 2)
// ═══════════════════════════════════════════════════════════════════════════

test("Claude parser merges subagent transcript tokens into parent session", async () => {
  const filePath = writeClaudeTranscript(
    "sess-with-subagents",
    [
      {
        type: "user",
        timestamp: "2026-06-07T10:00:00.000Z",
        cwd: "/test",
      },
      {
        type: "assistant",
        timestamp: "2026-06-07T10:00:05.000Z",
        uuid: "u1",
        requestId: "req_main",
        message: {
          id: "msg_main",
          model: "claude-opus-4-5",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
            cache_creation: {
              ephemeral_5m_input_tokens: 3,
              ephemeral_1h_input_tokens: 2,
            },
          },
          content: [{ type: "text", text: "main response" }],
        },
      },
    ],
    {
      subagents: {
        x: [
          {
            type: "assistant",
            timestamp: "2026-06-07T10:01:00.000Z",
            uuid: "sub-u1",
            requestId: "req_sub",
            message: {
              id: "msg_sub",
              model: "claude-opus-4-5",
              usage: {
                input_tokens: 50,
                output_tokens: 30,
                cache_read_input_tokens: 5,
                cache_creation_input_tokens: 3,
                cache_creation: {
                  ephemeral_5m_input_tokens: 1,
                  ephemeral_1h_input_tokens: 2,
                },
              },
              content: [{ type: "text", text: "subagent response" }],
            },
          },
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  // Main (100/50/10/5) + subagent (50/30/5/3) merged per model.
  // FEA-3419: the sidecar's TTL subdivision (1/2) rides mergeFoldedUsage into
  // the parent's per-model typed split — main (3/2) + subagent (1/2) => 4/4.
  // The 5m+1h sum (8) equals cacheWrite, proving the subdivision covers the
  // folded canonical total without under-reporting or double-counting.
  assert.deepEqual(parsed.tokensByModel["claude-opus-4-5"], {
    input: 150,
    output: 80,
    cacheRead: 15,
    cacheWrite: 8,
    cacheWriteTtl: { fiveM: 4, oneH: 4 },
  });

  // tokenSeries includes subagent records, each with its own per-event split.
  assert.equal(parsed.tokenSeries.length, 2);
  assert.deepEqual(
    parsed.tokenSeries.map((r) => r.cacheWriteTtl),
    [
      { fiveM: 3, oneH: 2 },
      { fiveM: 1, oneH: 2 },
    ]
  );

  // No events/messages derived from subagent files.
  assert.equal(parsed.assistantMessages, 1);

  // FEA-3419: the session-level blob is gone — typed fields are the single
  // source of truth for the split.
  assert.equal(
    (parsed.usageExtras as Record<string, unknown>).cache_creation,
    undefined
  );
});

test("Claude parser drops an unsafe subagent token snapshot and keeps the parent tokens", async () => {
  // The subagent's lone usage snapshot carries a JS-unsafe `cache_read` counter
  // (`InvalidTokenCountError`). Before FEA-2717's graceful degradation this
  // aborted the whole merged session; now that subagent event's usage is dropped
  // and the parent session still renders with its own (valid) token totals.
  const filePath = writeClaudeTranscript(
    "sess-unsafe-subagent",
    [
      {
        type: "user",
        timestamp: "2026-06-07T10:00:00.000Z",
        cwd: "/test",
      },
      {
        type: "assistant",
        timestamp: "2026-06-07T10:00:05.000Z",
        uuid: "u1",
        requestId: "req_main",
        message: {
          id: "msg_main",
          model: "claude-opus-4-5",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
          },
          content: [{ type: "text", text: "main response" }],
        },
      },
    ],
    {
      subagents: {
        x: [
          {
            type: "assistant",
            timestamp: "2026-06-07T10:01:00.000Z",
            uuid: "sub-u1",
            requestId: "req_sub",
            message: {
              id: "msg_sub",
              model: "claude-opus-4-5",
              usage: {
                input_tokens: 50,
                output_tokens: 30,
                cache_read_input_tokens: Number.MAX_SAFE_INTEGER + 1,
                cache_creation_input_tokens: 3,
              },
              content: [{ type: "text", text: "subagent response" }],
            },
          },
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  // Parent tokens are intact; the bad subagent snapshot contributes nothing
  // (dropped, not aborted).
  assert.deepEqual(parsed.tokensByModel["claude-opus-4-5"], {
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 5,
  });
  // Only the parent's usage record survives (subagent's was dropped).
  assert.equal(parsed.tokenSeries.length, 1);
});

test("Claude parser: missing subagent dir is fail-silent", async () => {
  const filePath = writeClaudeTranscript("sess-no-subagents", [
    {
      type: "user",
      timestamp: "2026-06-07T10:00:00.000Z",
      cwd: "/test",
    },
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:05.000Z",
      uuid: "u1",
      requestId: "req_1",
      message: {
        id: "msg_1",
        model: "claude-opus-4-5",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        content: [{ type: "text", text: "response" }],
      },
    },
  ]);

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  assert.deepEqual(parsed.tokensByModel["claude-opus-4-5"], {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("Claude parser: corrupt subagent file is fail-silent", async () => {
  const projDir = mkdtempSync(path.join(os.tmpdir(), "claude-corrupt-sub-"));
  const sessionId = "sess-corrupt-sub";
  const filePath = path.join(projDir, `${sessionId}.jsonl`);
  writeFileSync(
    filePath,
    [
      JSON.stringify({
        type: "user",
        timestamp: "2026-06-07T10:00:00.000Z",
        cwd: "/test",
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-07T10:00:05.000Z",
        uuid: "u1",
        requestId: "req_1",
        message: {
          id: "msg_1",
          model: "claude-opus-4-5",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [{ type: "text", text: "ok" }],
        },
      }),
    ].join("\n"),
    "utf8"
  );

  // Create corrupt subagent file.
  const subDir = path.join(projDir, sessionId, "subagents");
  mkdirSync(subDir, { recursive: true });
  writeFileSync(
    path.join(subDir, "agent-corrupt.jsonl"),
    "NOT VALID JSON\n",
    "utf8"
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);
  // Main tokens are still present.
  assert.equal(parsed.tokensByModel["claude-opus-4-5"]?.input, 100);
});

test("Claude parser: subagent with different model merges per-model", async () => {
  const filePath = writeClaudeTranscript(
    "sess-multi-model-sub",
    [
      {
        type: "user",
        timestamp: "2026-06-07T10:00:00.000Z",
        cwd: "/test",
      },
      {
        type: "assistant",
        timestamp: "2026-06-07T10:00:05.000Z",
        uuid: "u1",
        requestId: "req_1",
        message: {
          id: "msg_1",
          model: "claude-opus-4-5",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [{ type: "text", text: "main" }],
        },
      },
    ],
    {
      subagents: {
        y: [
          {
            type: "assistant",
            timestamp: "2026-06-07T10:01:00.000Z",
            uuid: "su1",
            requestId: "req_sub_y",
            message: {
              id: "msg_sub_y",
              model: "claude-sonnet-4-5",
              usage: {
                input_tokens: 200,
                output_tokens: 100,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
              content: [{ type: "text", text: "subagent" }],
            },
          },
        ],
      },
    }
  );

  const parsed = await parseClaudeFile(filePath);
  assert.ok(parsed);

  assert.deepEqual(parsed.tokensByModel["claude-opus-4-5"], {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.deepEqual(parsed.tokensByModel["claude-sonnet-4-5"], {
    input: 200,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
  });
});
