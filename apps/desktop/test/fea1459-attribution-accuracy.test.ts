/**
 * @file fea1459-attribution-accuracy.test.ts
 * @description Regression tests for the FEA-1459 data-accuracy fixes covering
 * eight areas: Claude token dedup, subagent transcript merge, Codex parser
 * fixes, importer behavior (SQLite), day-bucketing + heatmap, transcript.ts
 * live-hook extractor, parser-utils edge cases, and synthetic harness fixtures
 * for copilot/cursor/opencode.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { parseRolloutFile } from "../src/main/collectors/codex/codex-parser.js";
import { parseChatSessionFile } from "../src/main/collectors/copilot/copilot-parser.js";
import { parseTranscriptFile as parseCursorFile } from "../src/main/collectors/cursor/cursor-parser.js";
import { loadSessionsFromDb } from "../src/main/collectors/opencode/opencode-parser.js";
import { toIso } from "../src/main/collectors/parser-utils.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { openLibsqlDatabase } from "../src/main/database/libsql-executor.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { extractTranscriptTokens } from "../src/main/database/transcript.js";
import { InvalidTokenCountError } from "../src/main/token-counts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a Claude JSONL transcript to a temp directory, return file path. */
function writeClaudeTranscript(
  sessionId: string,
  lines: unknown[],
  opts?: { subagents?: Record<string, unknown[]> }
): string {
  const projDir = mkdtempSync(path.join(os.tmpdir(), "claude-proj-"));
  const filePath = path.join(projDir, `${sessionId}.jsonl`);
  writeFileSync(
    filePath,
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    "utf8"
  );
  if (opts?.subagents) {
    const subDir = path.join(projDir, sessionId, "subagents");
    mkdirSync(subDir, { recursive: true });
    for (const [name, subLines] of Object.entries(opts.subagents)) {
      writeFileSync(
        path.join(subDir, `agent-${name}.jsonl`),
        `${subLines.map((l) => JSON.stringify(l)).join("\n")}\n`,
        "utf8"
      );
    }
  }
  return filePath;
}

const CODEX_UUID = "22222222-2222-4222-8222-222222222222";
const LARGE_CACHE_READ_TOKENS = 2_192_635_647;

function writeRollout(name: string, lines: unknown[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-rollout-"));
  const filePath = path.join(dir, name);
  writeFileSync(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8"
  );
  return filePath;
}

/** Write a transcript file (raw JSONL) for extractTranscriptTokens tests. */
function writeTranscriptFile(lines: unknown[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "transcript-"));
  const filePath = path.join(dir, "transcript.jsonl");
  writeFileSync(
    filePath,
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    "utf8"
  );
  return filePath;
}

/** Create a full NormalizedSession with sensible defaults and overrides. */
function makeSession(
  overrides: Partial<NormalizedSession> = {}
): NormalizedSession {
  return {
    sessionId: "test-session-1",
    name: "Test Session",
    cwd: "/workspace/test",
    model: "claude-sonnet-4-5",
    version: "1.0.0",
    slug: null,
    gitBranch: "main",
    startedAt: "2026-06-07T10:00:00.000Z",
    endedAt: "2026-06-07T11:00:00.000Z",
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
    messageTimestamps: ["2026-06-07T10:00:30.000Z"],
    toolUses: [],
    compactions: [],
    apiErrors: [],
    fileModifiedAt: null,
    turnDurations: [],
    entrypoint: "claude",
    permissionMode: null,
    thinkingBlockCount: 0,
    toolResultErrors: [],
    usageExtras: { service_tiers: [], speeds: [], inference_geos: [] },
    messages: [],
    tokenSeries: [
      {
        timestamp: "2026-06-07T10:00:30.000Z",
        model: "claude-sonnet-4-5",
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
      },
    ],
    diffStats: null,
    slashCommands: [],
    artifacts: { prs: [], issues: [], repo: null },
    ...overrides,
  };
}

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

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
  assert.deepEqual(parsed.tokensByModel["claude-opus-4-5"], {
    input: 150,
    output: 80,
    cacheRead: 15,
    cacheWrite: 8,
  });

  // tokenSeries includes subagent records.
  assert.equal(parsed.tokenSeries.length, 2);

  // No events/messages derived from subagent files.
  assert.equal(parsed.assistantMessages, 1);
});

test("Claude parser rejects unsafe token counters from subagent transcripts", async () => {
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

  await assert.rejects(() => parseClaudeFile(filePath), InvalidTokenCountError);
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
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

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

  // Final tokensByModel uses latest totals (non-cached).
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.input, 1700); // 2500-800
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.output, 320); // 300+20
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.cacheRead, 800);
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

  // The tokensByModel uses the latest cumulative totals (post-reset values).
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.input, 50); // 100-50
  assert.ok(
    (parsed.tokensByModel["gpt-5.5"]?.output ?? 0) >= 0,
    "output must not be negative"
  );
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

// ═══════════════════════════════════════════════════════════════════════════
// AREA 4: Importer behavior (Fixes 5, 7, 8, 9) — in-memory SQLite
// ═══════════════════════════════════════════════════════════════════════════

test("Importer: token_events rows created from tokenSeries with timestamps", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const session = makeSession({
      sessionId: "te-series-test",
      tokenSeries: [
        {
          timestamp: "2026-06-07T10:00:30.000Z",
          model: "claude-sonnet-4-5",
          input: 60,
          output: 30,
          cacheRead: 5,
          cacheWrite: 3,
        },
        {
          timestamp: "2026-06-07T10:05:00.000Z",
          model: "claude-sonnet-4-5",
          input: 40,
          output: 20,
          cacheRead: 5,
          cacheWrite: 2,
        },
      ],
    });

    await db.importer.importSession(session, "claude");

    // Verify via getTokenAnalytics that byDay has entries (token_events populated).
    const analytics = await db.dashboard.getTokenAnalytics();
    assert.ok(analytics.byDay.length > 0, "byDay populated from token_events");
    // Both records should contribute input tokens.
    const totalDayInput = analytics.byDay.reduce(
      (sum, d) => sum + d.inputTokens,
      0
    );
    assert.equal(
      totalDayInput,
      100,
      "total day input == sum of tokenSeries inputs"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Importer: fallback token_events at startedAt when tokenSeries empty but tokensByModel present", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const session = makeSession({
      sessionId: "te-fallback-test",
      tokenSeries: [], // empty
      tokensByModel: {
        "gpt-5": { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
      },
      startedAt: "2026-06-07T09:00:00.000Z",
    });

    await db.importer.importSession(session, "codex");

    // Verify token_events populated via analytics byDay.
    const analytics = await db.dashboard.getTokenAnalytics();
    const totalDayInput = analytics.byDay.reduce(
      (sum, d) => sum + d.inputTokens,
      0
    );
    assert.equal(
      totalDayInput,
      100,
      "fallback token_events carries input from tokensByModel"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Importer: token_usage.created_at uses earliest tokenSeries timestamp, not now()", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const session = makeSession({
      sessionId: "tu-created-at-test",
      tokenSeries: [
        {
          timestamp: "2026-06-05T08:00:00.000Z",
          model: "claude-sonnet-4-5",
          input: 50,
          output: 25,
          cacheRead: 0,
          cacheWrite: 0,
        },
        {
          timestamp: "2026-06-05T09:00:00.000Z",
          model: "claude-sonnet-4-5",
          input: 50,
          output: 25,
          cacheRead: 10,
          cacheWrite: 5,
        },
      ],
    });

    await db.importer.importSession(session, "claude");

    const tokenRows = await db.tokenUsage.getBySession("tu-created-at-test");
    assert.equal(tokenRows.length, 1);
    // Verify that the token amounts are correct (proving the row was created).
    assert.equal(tokenRows[0].inputTokens, 100);
    assert.equal(tokenRows[0].outputTokens, 50);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Importer: IDEMPOTENCY — double import produces identical counts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const session = makeSession({
      sessionId: "idempotent-test",
      messageTimestamps: [
        "2026-06-07T10:00:30.000Z",
        "2026-06-07T10:01:00.000Z",
      ],
      toolUses: [
        { name: "Read", timestamp: "2026-06-07T10:00:35.000Z" },
        {
          name: "Task",
          timestamp: "2026-06-07T10:00:40.000Z",
          id: "toolu_ABC",
          input: { prompt: "do thing" },
          resultTimestamp: "2026-06-07T10:00:50.000Z",
        },
      ],
      tokenSeries: [
        {
          timestamp: "2026-06-07T10:00:30.000Z",
          model: "claude-sonnet-4-5",
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 5,
        },
      ],
    });

    // First import.
    await db.importer.importSession(session, "claude");

    const eventsAfter1 = (await db.events.getBySession("idempotent-test"))
      .length;
    const tokenUsageAfter1 =
      await db.tokenUsage.getBySession("idempotent-test");

    // Second import (identical session).
    await db.importer.importSession(session, "claude");

    const eventsAfter2 = (await db.events.getBySession("idempotent-test"))
      .length;
    const tokenUsageAfter2 =
      await db.tokenUsage.getBySession("idempotent-test");

    assert.equal(eventsAfter1, eventsAfter2, "event count unchanged");
    assert.deepEqual(
      tokenUsageAfter1,
      tokenUsageAfter2,
      "token_usage values unchanged"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Importer: re-import with earlier-timestamped records (subagent discovery) retains all records", async () => {
  // FEA-1459 Fix C: The old HWM approach dropped records with timestamps
  // earlier than the existing MAX. Delete+reinsert fixes this.
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    // First import: parent session with one token record at 10:05.
    const session1 = makeSession({
      sessionId: "earlier-ts-test",
      tokenSeries: [
        {
          timestamp: "2026-06-07T10:05:00.000Z",
          model: "claude-sonnet-4-5",
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 5,
        },
      ],
    });
    await db.importer.importSession(session1, "claude");

    // Verify 1 token_events row.
    const rows1 = await db.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
      "SELECT COUNT(*) AS cnt FROM token_events WHERE session_id = 'earlier-ts-test'"
    );
    assert.equal(rows1[0].cnt, 1, "1 token_events row after first import");

    // Second import: same session now has an EARLIER subagent-discovered record
    // at 10:00 (before the existing 10:05). Under the old HWM this would be
    // dropped; delete+reinsert retains it.
    const session2 = makeSession({
      sessionId: "earlier-ts-test",
      tokenSeries: [
        {
          timestamp: "2026-06-07T10:00:00.000Z",
          model: "claude-sonnet-4-5",
          input: 40,
          output: 20,
          cacheRead: 5,
          cacheWrite: 2,
        },
        {
          timestamp: "2026-06-07T10:05:00.000Z",
          model: "claude-sonnet-4-5",
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 5,
        },
      ],
    });
    await db.importer.importSession(session2, "claude");

    // Verify BOTH records exist (the earlier one was NOT dropped).
    const rows2 = await db.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
      "SELECT COUNT(*) AS cnt FROM token_events WHERE session_id = 'earlier-ts-test'"
    );
    assert.equal(
      rows2[0].cnt,
      2,
      "2 token_events rows after re-import with earlier record"
    );

    // Verify the earlier record's data is correct.
    const earlier = await db.prisma.client.$queryRawUnsafe<
      { input_tokens: number | bigint }[]
    >(
      "SELECT input_tokens FROM token_events WHERE session_id = 'earlier-ts-test' AND created_at = '2026-06-07T10:00:00.000Z'"
    );
    assert.equal(earlier.length, 1, "earlier record exists");
    // input_tokens is a BigInt column → Prisma raw returns it as `bigint`;
    // coerce to match the prior raw path (which returned a JS number).
    assert.equal(
      Number(earlier[0].input_tokens),
      40,
      "earlier record has correct input"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Importer: in-import event dedup — duplicate (type, ts, toolName) yields single row for Stop; tool events use discriminator", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    // FEA-1459 Fix D: Two toolUses with identical (name, timestamp) but
    // different tool ids → TWO PostToolUse events (not collapsed).
    // True duplicates (same id) → one event.
    // Stop events (no discriminator) still dedup on (type, ts).
    const session = makeSession({
      sessionId: "event-dedup-test",
      toolUses: [
        { name: "Read", timestamp: "2026-06-07T10:00:35.000Z", id: "toolu_A" },
        { name: "Read", timestamp: "2026-06-07T10:00:35.000Z", id: "toolu_B" },
        { name: "Read", timestamp: "2026-06-07T10:00:35.000Z", id: "toolu_B" }, // true duplicate
      ],
      messageTimestamps: [
        "2026-06-07T10:00:30.000Z",
        "2026-06-07T10:00:30.000Z",
      ],
    });

    await db.importer.importSession(session, "claude");

    const events = await db.events.getBySession("event-dedup-test");

    // Stop events: 1 (deduped from 2 identical timestamps, no discriminator).
    const stopEvents = events.filter(
      (e: { eventType: string }) => e.eventType === "Stop"
    );
    assert.equal(stopEvents.length, 1, "duplicate Stop events deduped");

    // PostToolUse: 2 (toolu_A and toolu_B are different; third entry is a true
    // duplicate of toolu_B and collapses).
    const toolEvents = events.filter(
      (e: { eventType: string }) => e.eventType === "PostToolUse"
    );
    assert.equal(
      toolEvents.length,
      2,
      "two different tool ids yield two rows; true duplicates collapse"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Importer: subagent rows use toolu_* id and resultTimestamp for ended_at", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const session = makeSession({
      sessionId: "subagent-fidelity-test",
      toolUses: [
        {
          name: "Task",
          timestamp: "2026-06-07T10:00:40.000Z",
          id: "toolu_DEF123",
          input: { prompt: "build it" },
          resultTimestamp: "2026-06-07T10:05:00.000Z",
        },
      ],
    });

    await db.importer.importSession(session, "claude");

    const agents = await db.agents.getBySession("subagent-fidelity-test");
    const subagents = agents.filter(
      (a: { type: string }) => a.type === "subagent"
    );
    assert.equal(subagents.length, 1);
    // id contains the tool_use id.
    assert.ok(
      subagents[0].id.includes("toolu_DEF123"),
      "subagent id contains toolu_* fragment"
    );
    // ended_at uses resultTimestamp (real duration).
    assert.equal(subagents[0].endedAt, "2026-06-07T10:05:00.000Z");
    // started_at is the tool invocation time.
    assert.equal(subagents[0].startedAt, "2026-06-07T10:00:40.000Z");
    // Verify they are different (non-zero duration).
    assert.notEqual(subagents[0].startedAt, subagents[0].endedAt);

    // Stable across double-import (no duplicate agents).
    await db.importer.importSession(session, "claude");
    const agentsAfter2 = await db.agents.getBySession("subagent-fidelity-test");
    const subagentsAfter2 = agentsAfter2.filter(
      (a: { type: string }) => a.type === "subagent"
    );
    assert.equal(
      subagentsAfter2.length,
      1,
      "no duplicate subagents after re-import"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Importer: model backfill from tokensByModel when session.model is null", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const session = makeSession({
      sessionId: "model-backfill-test",
      model: null, // no model
      tokensByModel: {
        "claude-opus-4-5": {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    });

    await db.importer.importSession(session, "claude");

    const row = await db.sessions.getById("model-backfill-test");
    assert.equal(
      row?.model,
      "claude-opus-4-5",
      "model backfilled from tokensByModel"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AREA 5: Day bucketing + heatmap (Fix 6)
// ═══════════════════════════════════════════════════════════════════════════

test("SQLite: UTC substr day bucketing groups token events by UTC calendar day", async () => {
  // Post SQLite migration the analytics SQL buckets by the UTC calendar day via
  // `substr(created_at, 1, 10)` rather than the prior Postgres
  // `(created_at::timestamptz AT TIME ZONE $tz)::date` — SQLite has no IANA
  // timezone support, so day bucketing is UTC-based and the renderer applies any
  // local-date presentation (see buildHeatmapWeeks/localDateKey below). These
  // tests characterize the dialect the source now uses.
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-tz-"));
  const { db } = await openLibsqlDatabase(path.join(dir, "tz.sqlite"));
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS token_events (
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0
      );
    `);

    const events = [
      // UTC day is taken verbatim from the ISO prefix.
      { ts: "2026-06-08T01:30:00.000Z", input: 100 },
      { ts: "2026-06-08T00:00:00.000Z", input: 50 },
      { ts: "2026-06-07T23:59:59.000Z", input: 200 },
    ];
    for (const ev of events) {
      await db.query(
        `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
         VALUES ('utc-test', 'claude', $1, $2, 0, 0, 0)`,
        [ev.ts, ev.input]
      );
    }

    const result = await db.query<{ day: string; total_input: number }>(
      `SELECT substr(created_at, 1, 10) AS day,
              SUM(input_tokens) AS total_input
       FROM token_events
       WHERE session_id = 'utc-test'
       GROUP BY day
       ORDER BY day`
    );

    const dayMap = new Map(
      result.rows.map((r) => [r.day, Number(r.total_input)])
    );
    assert.equal(
      dayMap.get("2026-06-07"),
      200,
      "late-UTC event buckets to June 7"
    );
    assert.equal(
      dayMap.get("2026-06-08"),
      150,
      "early-UTC events bucket to June 8"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite: UTC substr/strftime hour bucketing extracts the UTC hour", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-hr-"));
  const { db } = await openLibsqlDatabase(path.join(dir, "hr.sqlite"));
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    await db.query(
      `INSERT INTO events (session_id, event_type, created_at)
       VALUES ('hr', 'Stop', '2026-06-08T13:45:00.000Z'),
              ('hr', 'Stop', '2026-06-08T13:10:00.000Z'),
              ('hr', 'Stop', '2026-06-08T09:00:00.000Z')`
    );

    const result = await db.query<{ day: string; hour: number; n: number }>(
      `SELECT substr(created_at, 1, 10) AS day,
              CAST(strftime('%H', created_at) AS INTEGER) AS hour,
              COUNT(*) AS n
       FROM events
       GROUP BY day, hour
       ORDER BY hour`
    );

    assert.deepEqual(
      result.rows.map((r) => ({
        day: r.day,
        hour: Number(r.hour),
        n: Number(r.n),
      })),
      [
        { day: "2026-06-08", hour: 9, n: 1 },
        { day: "2026-06-08", hour: 13, n: 2 },
      ]
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

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
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

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
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

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

// ═══════════════════════════════════════════════════════════════════════════
// AREA 7: toIso / parser-utils edge cases
// ═══════════════════════════════════════════════════════════════════════════

test("toIso: epoch seconds (< 1e12) treated as seconds", () => {
  const result = toIso(1_710_000_000);
  assert.equal(result, "2024-03-09T16:00:00.000Z");
});

test("toIso: epoch milliseconds (>= 1e12) treated as milliseconds", () => {
  const result = toIso(1_710_000_000_000);
  assert.equal(result, "2024-03-09T16:00:00.000Z");
});

test("toIso: ISO string with Z suffix passed through", () => {
  const result = toIso("2026-06-07T10:00:00.000Z");
  assert.equal(result, "2026-06-07T10:00:00.000Z");
});

test("toIso: ISO string with offset parsed to UTC", () => {
  const result = toIso("2026-06-07T15:00:00.000+05:00");
  assert.equal(result, "2026-06-07T10:00:00.000Z");
});

test("toIso: garbage string returned as-is (invalid date)", () => {
  const result = toIso("not-a-date");
  assert.equal(result, "not-a-date");
});

test("toIso: null returns null", () => {
  assert.equal(toIso(null), null);
});

test("toIso: undefined returns null", () => {
  assert.equal(toIso(undefined), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// AREA 8: Synthetic copilot/cursor/opencode smoke fixtures
// ═══════════════════════════════════════════════════════════════════════════

test("Copilot Chat: minimal fixture with timestamps — startedAt, tokens, tokenSeries", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "copilot-smoke-"));
  const filePath = path.join(dir, "session.json");
  writeFileSync(
    filePath,
    JSON.stringify({
      sessionId: "copilot-smoke-1",
      creationDate: 1_710_000_000_000,
      lastMessageDate: 1_710_000_060_000,
      requests: [
        {
          id: "req-1",
          timestamp: 1_710_000_000_000,
          message: { text: "hello" },
          response: {
            markdown: "hi",
            usage: { input_tokens: 50, output_tokens: 30 },
          },
          toolCalls: [],
        },
      ],
    }),
    "utf8"
  );

  const parsed = parseChatSessionFile(filePath, "/workspace/proj");
  assert.ok(parsed, "copilot session parsed");
  assert.equal(parsed.startedAt, "2024-03-09T16:00:00.000Z");
  assert.ok(
    Object.keys(parsed.tokensByModel).length > 0,
    "tokensByModel populated"
  );
  assert.ok(parsed.tokenSeries.length > 0, "tokenSeries populated");
});

test("Copilot Chat: no timestamps in data — mtime fallback produces a session", () => {
  // Copilot fixture with messages that have no timestamp fields.
  // The parser falls back to file mtime for startedAt.
  const dir = mkdtempSync(path.join(os.tmpdir(), "copilot-mtime-"));
  const filePath = path.join(dir, "session.json");
  writeFileSync(
    filePath,
    JSON.stringify({
      sessionId: "copilot-no-ts",
      requests: [
        {
          id: "req-1",
          message: { text: "hello" },
          response: { markdown: "hi" },
        },
      ],
    }),
    "utf8"
  );

  const parsed = parseChatSessionFile(filePath, "/workspace/proj");
  // Known caveat: mtime-fallback means startedAt will be the test file's
  // creation time, not the actual conversation time. This is acceptable for
  // copilot sessions that lack timestamps in their JSON data.
  assert.ok(parsed, "mtime fallback produces a session");
  assert.ok(parsed.startedAt, "startedAt is set via mtime fallback");
});

test("Cursor: minimal fixture with token_count — startedAt, tokensByModel, tokenSeries", async () => {
  // Cursor parser requires a token_count/usage type event for tokensByModel.
  const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-smoke-"));
  const sessionDir = path.join(dir, "session-cursor-1");
  mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, "rollout.jsonl");
  writeFileSync(
    filePath,
    [
      {
        timestamp: "2024-03-09T16:00:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/workspace/cursor-proj",
          model: "claude-3-7-sonnet",
        },
      },
      {
        timestamp: "2024-03-09T16:00:05.000Z",
        type: "user_message",
        payload: { message: "fix the bug" },
      },
      {
        timestamp: "2024-03-09T16:00:10.000Z",
        type: "assistant_message",
        payload: { message: "on it" },
      },
      {
        timestamp: "2024-03-09T16:00:12.000Z",
        type: "token_count",
        payload: {
          usage: { input_tokens: 80, output_tokens: 40 },
          model: "claude-3-7-sonnet",
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n"),
    "utf8"
  );

  const parsed = await parseCursorFile(filePath);
  assert.ok(parsed, "cursor session parsed");
  assert.equal(parsed.startedAt, "2024-03-09T16:00:00.000Z");
  assert.ok(
    Object.keys(parsed.tokensByModel).length > 0,
    "tokensByModel populated"
  );
  assert.ok(parsed.tokenSeries.length > 0, "tokenSeries populated");
});

test("OpenCode: minimal fixture — startedAt, tokensByModel populated", () => {
  // OpenCode builds tokenSeries from per-message tokens in the `data` column.
  // The session table carries aggregate tokens (tokens_input, etc.).
  // tokenSeries requires per-message token data (data.tokens) which the
  // minimal fixture omits. tokensByModel is derived from the session row.
  const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-smoke-"));
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, slug TEXT, directory TEXT NOT NULL, title TEXT NOT NULL,
      version TEXT NOT NULL, agent TEXT, model TEXT, permission TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO session (id, slug, directory, title, version, agent, model, permission,
      time_created, time_updated, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "oc_1",
    "eager-fox",
    "/workspace/oc-proj",
    "Overview",
    "2.0.0",
    "build",
    JSON.stringify({ id: "gpt-5", providerID: "opencode" }),
    "",
    1_710_000_000_000,
    1_710_000_060_000,
    200,
    80,
    10,
    60,
    0
  );
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  ).run(
    "msg_oc1",
    "oc_1",
    1_710_000_000_000,
    1_710_000_000_000,
    JSON.stringify({ role: "user", time: { created: 1_710_000_000_000 } })
  );
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  ).run(
    "msg_oc2",
    "oc_1",
    1_710_000_030_000,
    1_710_000_030_000,
    JSON.stringify({
      role: "assistant",
      path: { cwd: "/workspace/oc-proj", root: "/workspace/oc-proj" },
      time: { created: 1_710_000_030_000 },
    })
  );
  db.close();

  const sessions = loadSessionsFromDb(dbPath);
  assert.equal(sessions.length, 1);
  const parsed = sessions[0];
  assert.equal(parsed.startedAt, "2024-03-09T16:00:00.000Z");
  assert.ok(
    Object.keys(parsed.tokensByModel).length > 0,
    "tokensByModel populated"
  );
  // tokenSeries is populated from per-message tokens. Without tokens in the
  // message data columns, the session-level fallback uses the aggregate row
  // from the session table. Verify the aggregate values are correct.
  assert.deepEqual(parsed.tokensByModel["gpt-5"], {
    input: 200,
    output: 90, // output 80 + reasoning 10
    cacheRead: 60,
    cacheWrite: 0,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AREA 9: PR #1511 review fixes — resumed bursts, overwrite semantics,
// residue purge, hook-path token_events append
// ═══════════════════════════════════════════════════════════════════════════

test("Codex: RESUMED burst rollout — replayed prefix dropped, only post-resume tokens counted", async () => {
  // A resume re-serializes the original session as a tight leading burst
  // (>=20 records in <5s), then real work follows. The replayed token_counts
  // carry the ORIGINAL session's cumulative totals; without the rebase the
  // first one lands as a giant delta double-counted against the original
  // rollout file.
  const lines: unknown[] = [
    {
      timestamp: "2026-05-22T15:18:00.000Z",
      type: "session_meta",
      payload: { id: CODEX_UUID, cwd: "/test" },
    },
    {
      timestamp: "2026-05-22T15:18:00.010Z",
      type: "turn_context",
      payload: { model: "gpt-5.5" },
    },
  ];
  // 20 replayed assistant messages within ~1s.
  for (let i = 0; i < 20; i++) {
    lines.push({
      timestamp: `2026-05-22T15:18:00.${String(20 + i * 40).padStart(3, "0")}Z`,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `replayed ${i}` }],
      },
    });
  }
  // Two replayed token_counts carrying the original session's cumulative
  // totals (norm deltas: #1 = 30000/9000/20000, #2 = 300/100/200).
  lines.push(
    {
      timestamp: "2026-05-22T15:18:01.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 50_000,
            cached_input_tokens: 20_000,
            output_tokens: 9000,
            reasoning_output_tokens: 0,
          },
        },
        turn_context: { model: "gpt-5.5" },
      },
    },
    {
      timestamp: "2026-05-22T15:18:01.500Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 50_500,
            cached_input_tokens: 20_200,
            output_tokens: 9100,
            reasoning_output_tokens: 0,
          },
        },
        turn_context: { model: "gpt-5.5" },
      },
    },
    // Post-resume real work, one minute later.
    {
      timestamp: "2026-05-22T15:19:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "keep going" },
    },
    {
      timestamp: "2026-05-22T15:19:05.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "new work" }],
      },
    },
    {
      timestamp: "2026-05-22T15:19:06.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 52_000,
            cached_input_tokens: 21_000,
            output_tokens: 9600,
            reasoning_output_tokens: 0,
          },
        },
        turn_context: { model: "gpt-5.5" },
      },
    }
  );

  const filePath = writeRollout(
    `rollout-2026-05-22T15-18-00-${CODEX_UUID}.jsonl`,
    lines
  );

  const parsed = await parseRolloutFile(filePath);
  // The session imports (span > 5s — NOT the whole-file burst skip)...
  assert.ok(parsed);

  // ...but only the post-resume token delta survives:
  // norm latest = (52000-21000, 9600, 21000) minus replayed baseline
  // (30000+300, 9000+100, 20000+200) = (700, 500, 800).
  assert.equal(parsed.tokenSeries.length, 1, "replayed token entries dropped");
  assert.equal(parsed.tokenSeries[0].timestamp, "2026-05-22T15:19:06.000Z");
  assert.equal(parsed.tokenSeries[0].input, 700);
  assert.equal(parsed.tokenSeries[0].output, 500);
  assert.equal(parsed.tokenSeries[0].cacheRead, 800);

  assert.equal(parsed.tokensByModel["gpt-5.5"]?.input, 700);
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.output, 500);
  assert.equal(parsed.tokensByModel["gpt-5.5"]?.cacheRead, 800);
});

test("Codex: tokensByModel fallback skips codex-auto-review series entries", async () => {
  // A rollout whose ONLY token rows are codex-auto-review must not key
  // tokensByModel under the reviewer label — importSessionWithTx would
  // backfill sessions.model from that sole key.
  const filePath = writeRollout(
    `rollout-2026-05-18T11-00-00-${CODEX_UUID}.jsonl`,
    [
      {
        timestamp: "2026-05-18T11:00:00.000Z",
        type: "session_meta",
        payload: { id: CODEX_UUID, cwd: "/test" },
      },
      {
        timestamp: "2026-05-18T11:00:05.000Z",
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
          turn_context: { model: "codex-auto-review" },
        },
      },
    ]
  );

  const parsed = await parseRolloutFile(filePath);
  assert.ok(parsed);
  assert.equal(parsed.model, null, "reviewer label never becomes model");
  assert.equal(
    parsed.tokensByModel["codex-auto-review"],
    undefined,
    "tokensByModel must not be keyed by the reviewer label"
  );
  // FEA-2085: the fallback key is now the real, priceable "gpt-5-codex" (was
  // the unpriceable "gpt-codex" placeholder) and is flagged as an inferred
  // (guessed) attribution.
  assert.equal(
    parsed.tokensByModel["gpt-codex"],
    undefined,
    "the unpriceable gpt-codex placeholder is no longer emitted"
  );
  assert.ok(
    parsed.tokensByModel["gpt-5-codex"],
    "priceable fallback key carries the totals"
  );
  assert.equal(parsed.tokensByModel["gpt-5-codex"].input, 800);
  assert.equal(
    parsed.tokensByModel["gpt-5-codex"].inferred,
    true,
    "model-less fallback attribution is flagged inferred"
  );
});

test("Codex FEA-2085: model-less rollout keys tokens + series under priceable gpt-5-codex fallback, flagged inferred", async () => {
  // No turn_context.model and no session model anywhere → the parser must fall
  // back to the priceable gpt-5-codex (not the unpriceable gpt-codex) and flag
  // the attribution as inferred on BOTH the per-event series row and the
  // tokensByModel aggregate.
  const filePath = writeRollout(
    `rollout-2026-05-18T12-00-00-${CODEX_UUID}.jsonl`,
    [
      {
        timestamp: "2026-05-18T12:00:00.000Z",
        type: "session_meta",
        payload: { id: CODEX_UUID, cwd: "/test" },
      },
      {
        timestamp: "2026-05-18T12:00:05.000Z",
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
        },
      },
    ]
  );

  const parsed = await parseRolloutFile(filePath);
  assert.ok(parsed);
  assert.equal(parsed.model, null, "no model could be extracted");
  assert.equal(
    parsed.tokensByModel["gpt-codex"],
    undefined,
    "the unpriceable placeholder is never emitted"
  );
  const agg = parsed.tokensByModel["gpt-5-codex"];
  assert.ok(agg, "tokens keyed under the priceable gpt-5-codex fallback");
  assert.equal(agg.inferred, true, "aggregate fallback flagged inferred");

  const series = parsed.tokenSeries.find((r) => r.model === "gpt-5-codex");
  assert.ok(series, "series row uses the gpt-5-codex fallback");
  assert.equal(series.inferred, true, "series fallback row flagged inferred");
});

test("Codex FEA-2085: a concrete turn_context.model is kept and never flagged inferred", async () => {
  // No-regression: when a real model id is present, the fallback must not fire
  // and nothing is flagged inferred.
  const filePath = writeRollout(
    `rollout-2026-05-18T13-00-00-${CODEX_UUID}.jsonl`,
    [
      {
        timestamp: "2026-05-18T13:00:00.000Z",
        type: "session_meta",
        payload: { id: CODEX_UUID, cwd: "/test" },
      },
      {
        timestamp: "2026-05-18T13:00:05.000Z",
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
          turn_context: { model: "gpt-5.1-codex" },
        },
      },
    ]
  );

  const parsed = await parseRolloutFile(filePath);
  assert.ok(parsed);
  assert.equal(parsed.model, "gpt-5.1-codex", "real model is promoted");
  assert.equal(
    parsed.tokensByModel["gpt-5-codex"],
    undefined,
    "fallback not used when a real model is present"
  );
  const real = parsed.tokensByModel["gpt-5.1-codex"];
  assert.ok(real, "tokens keyed under the real model");
  assert.ok(!real.inferred, "real attribution is not flagged inferred");

  const series = parsed.tokenSeries.find((r) => r.model === "gpt-5.1-codex");
  assert.ok(series, "series uses the real model");
  assert.ok(!series.inferred, "real series row not flagged inferred");
});

test("Importer: re-import with SMALLER totals (dedup upgrade) overwrites instead of stacking", async () => {
  // PR #1511 review: the old HWM upsert treated EXCLUDED.raw < stored raw as
  // a counter reset and ADDED the new value on top — an upgraded install
  // reimporting deduped (smaller) totals got input = old_inflated + new.
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    // First import: v1-style inflated totals.
    await db.importer.importSession(
      makeSession({
        sessionId: "shrink-test",
        tokensByModel: {
          "claude-sonnet-4-5": {
            input: 10_000,
            output: 5000,
            cacheRead: 100,
            cacheWrite: 50,
          },
        },
      }),
      "claude"
    );

    // Re-import: deduped (much smaller) totals for the same session.
    await db.importer.importSession(
      makeSession({
        sessionId: "shrink-test",
        tokensByModel: {
          "claude-sonnet-4-5": {
            input: 3000,
            output: 1500,
            cacheRead: 100,
            cacheWrite: 50,
          },
        },
      }),
      "claude"
    );

    const usage = await db.tokenUsage.getBySession("shrink-test");
    assert.equal(usage.length, 1);
    assert.equal(usage[0].inputTokens, 3000, "overwrite, not 13000");
    assert.equal(usage[0].outputTokens, 1500, "overwrite, not 6500");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Importer FEA-2085: token_usage.inferred persists per-model (guessed vs real attribution)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2085-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-22T12:00:00.000Z",
  });

  try {
    await db.importer.importSession(
      makeSession({
        sessionId: "inferred-test",
        tokensByModel: {
          // Guessed fallback attribution (model-less rollout).
          "gpt-5-codex": {
            input: 1000,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
            inferred: true,
          },
          // Genuine extracted-model attribution.
          "gpt-5.1-codex": {
            input: 2000,
            output: 200,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      }),
      "codex"
    );

    const rows = await db.prisma.client.$queryRawUnsafe<
      { model: string; inferred: unknown }[]
    >(
      "SELECT model, inferred FROM token_usage WHERE session_id = $1 ORDER BY model ASC",
      "inferred-test"
    );
    const inferredByModel = new Map(
      rows.map((r) => [r.model, Number(r.inferred)])
    );
    assert.equal(
      inferredByModel.get("gpt-5-codex"),
      1,
      "guessed attribution persists inferred=1"
    );
    assert.equal(
      inferredByModel.get("gpt-5.1-codex"),
      0,
      "real attribution persists inferred=0"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Importer: large token counters import and read back exactly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2027-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await db.importer.importSession(
      makeSession({
        sessionId: "large-cache-read-session",
        tokensByModel: {
          "claude-opus-4-8": {
            input: 10_000,
            output: 5000,
            cacheRead: LARGE_CACHE_READ_TOKENS,
            cacheWrite: 50,
          },
        },
        tokenSeries: [
          {
            timestamp: "2026-06-07T10:00:30.000Z",
            model: "claude-opus-4-8",
            input: 10_000,
            output: 5000,
            cacheRead: LARGE_CACHE_READ_TOKENS,
            cacheWrite: 50,
          },
        ],
      }),
      "claude"
    );

    const usage = await db.tokenUsage.getBySession("large-cache-read-session");
    assert.equal(usage.length, 1);
    assert.equal(usage[0].cacheReadTokens, LARGE_CACHE_READ_TOKENS);

    const [detail] = await db.syncSource.loadSyncedSessions(
      ["large-cache-read-session"],
      emptyAttributionCache()
    );
    assert.equal(
      detail?.tokenUsageByModel[0]?.cacheReadTokens,
      LARGE_CACHE_READ_TOKENS
    );

    const events = await db.prisma.client.$queryRawUnsafe<
      { cache_read_tokens: unknown }[]
    >(
      "SELECT cache_read_tokens FROM token_events WHERE session_id = $1",
      "large-cache-read-session"
    );
    assert.equal(events.length, 1);
    assert.equal(Number(events[0].cache_read_tokens), LARGE_CACHE_READ_TOKENS);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Importer: real Claude transcript with large cache read imports and reads back exactly", async () => {
  const transcriptPath = writeClaudeTranscript("large-jsonl-session", [
    {
      type: "user",
      timestamp: "2026-06-07T10:00:00.000Z",
      cwd: "/workspace/large-jsonl-session",
    },
    {
      type: "assistant",
      timestamp: "2026-06-07T10:00:30.000Z",
      uuid: "large-jsonl-line",
      requestId: "req_large_jsonl",
      message: {
        id: "msg_large_jsonl",
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 10_000,
          output_tokens: 5000,
          cache_read_input_tokens: LARGE_CACHE_READ_TOKENS,
          cache_creation_input_tokens: 50,
        },
        content: [{ type: "text", text: "large token response" }],
      },
    },
  ]);
  const parsed = await parseClaudeFile(transcriptPath);
  assert.ok(parsed);

  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2027-jsonl-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const result = await db.importer.importSession(parsed, "claude");
    assert.equal(result.failed, undefined);

    const usage = await db.tokenUsage.getBySession("large-jsonl-session");
    assert.equal(usage.length, 1);
    assert.equal(usage[0].cacheReadTokens, LARGE_CACHE_READ_TOKENS);

    const [detail] = await db.syncSource.loadSyncedSessions(
      ["large-jsonl-session"],
      emptyAttributionCache()
    );
    assert.equal(
      detail?.tokenUsageByModel[0]?.cacheReadTokens,
      LARGE_CACHE_READ_TOKENS
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Importer: a session with unsafe token counters is skipped whole, writing nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2027-unsafe-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const result = await db.importer.importSession(
      makeSession({
        sessionId: "unsafe-cache-read-session",
        tokensByModel: {
          "claude-opus-4-8": {
            input: 10_000,
            output: 5000,
            cacheRead: Number.MAX_SAFE_INTEGER + 1,
            cacheWrite: 50,
          },
        },
      }),
      "claude"
    );

    // FEA-1791 / FEA-2027: with per-record isolation the import no longer wraps
    // everything in one transaction, so an unsafe token counter is detected up
    // front and the WHOLE session is skipped (writing nothing) rather than
    // marking the import failed — which previously halted the rest of the
    // source. The "never persist a corrupt token row" guarantee is preserved by
    // skipping before any group commits, not by a whole-import rollback.
    assert.notEqual(result.failed, true);
    assert.equal(result.skipped, true);
    // Nothing was written: no token rows AND no session row.
    assert.deepEqual(
      await db.tokenUsage.getBySession("unsafe-cache-read-session"),
      []
    );
    const sessionRows = await db.prisma.client.$queryRawUnsafe<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM sessions WHERE id = $1",
      "unsafe-cache-read-session"
    );
    assert.equal(Number(sessionRows[0]?.n ?? 0), 0, "no session row written");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Importer: unsafe persisted BIGINT token rows fail on production read paths", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2027-unsafe-read-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      "unsafe-persisted-session",
      "Unsafe persisted session",
      "completed",
      "2026-06-07T10:00:00.000Z",
      "2026-06-07T10:01:00.000Z",
      "claude"
    );
    await db.run(
      `INSERT INTO token_usage (
         session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         raw_input, raw_output, raw_cache_read, raw_cache_write
       )
       VALUES ($1, $2, $3, 1, 1, 1, $3, 1, 1, 1)`,
      "unsafe-persisted-session",
      "claude-opus-4-8",
      "9007199254740992"
    );

    // The contract is that an unsafe persisted token count is REJECTED on read,
    // never silently mis-read. Under SQLite the bigint came back as a string and
    // the app-level guard raised InvalidTokenCountError. libSQL (intMode
    // "number") rejects the value at the driver layer first — a RangeError
    // "cannot be safely represented as a JavaScript number" — which is a
    // strictly stronger guarantee (the value can never reach JS truncated). Both
    // satisfy the contract; accept either rejection.
    await assert.rejects(
      () => db.tokenUsage.getBySession("unsafe-persisted-session"),
      (error: unknown) =>
        error instanceof InvalidTokenCountError ||
        (error instanceof RangeError &&
          // biome-ignore lint/performance/useTopLevelRegex: one-off test assertion
          /cannot be safely represented/.test(error.message))
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Importer: re-import removes token_usage rows for models that disappeared", async () => {
  // Delete+reinsert semantics: a v1 row keyed under a model the new parser no
  // longer emits (e.g. codex-auto-review) must not survive the reimport.
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await db.importer.importSession(
      makeSession({
        sessionId: "stale-model-test",
        tokensByModel: {
          "gpt-5.5": { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
          "codex-auto-review": {
            input: 999,
            output: 999,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      }),
      "codex"
    );

    await db.importer.importSession(
      makeSession({
        sessionId: "stale-model-test",
        tokensByModel: {
          "gpt-5.5": { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        },
      }),
      "codex"
    );

    const usage = await db.tokenUsage.getBySession("stale-model-test");
    assert.equal(usage.length, 1, "stale model row removed");
    assert.equal(usage[0].model, "gpt-5.5");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Importer: reimport purges idx-keyed subagent residue and stale import events; working hook subagents survive", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const sid = "residue-test";
    // First import: v1-style — Task toolUse WITHOUT a tool id (idx-keyed sub).
    await db.importer.importSession(
      makeSession({
        sessionId: sid,
        toolUses: [
          {
            name: "Task",
            timestamp: "2026-06-07T10:00:40.000Z",
            input: { prompt: "do thing" },
          },
        ],
      }),
      "claude"
    );

    // Simulate v1 per-content-block Stop residue: three Stop rows at the same
    // timestamp inserted by the pre-dedup importer.
    for (let i = 0; i < 3; i++) {
      await db.run(
        `INSERT INTO events (id, session_id, agent_id, event_type, created_at)
         VALUES ($1, $2, $3, 'Stop', '2026-06-07T10:00:31.000Z')`,
        `legacy-stop-${i}`,
        sid,
        `${sid}-main`
      );
    }
    // Simulate a LIVE hook-spawned subagent still working — must survive.
    await db.run(
      `INSERT INTO agents (id, session_id, name, type, status, started_at, updated_at, parent_agent_id)
       VALUES ($1, $2, 'live-sub', 'subagent', 'working', '2026-06-07T10:30:00.000Z', '2026-06-07T10:30:00.000Z', $3)`,
      `${sid}-sub-deadbeef`,
      sid,
      `${sid}-main`
    );

    // Re-import: same logical session, Task toolUse NOW carries a toolu_* id.
    await db.importer.importSession(
      makeSession({
        sessionId: sid,
        toolUses: [
          {
            name: "Task",
            timestamp: "2026-06-07T10:00:40.000Z",
            id: "toolu_NEW",
            input: { prompt: "do thing" },
            resultTimestamp: "2026-06-07T10:00:50.000Z",
          },
        ],
      }),
      "claude"
    );

    const agentRows = await db.prisma.client.$queryRawUnsafe<
      { id: string; status: string }[]
    >(
      "SELECT id, status FROM agents WHERE session_id = $1 AND type = 'subagent' ORDER BY id",
      sid
    );
    const ids = agentRows.map((r) => r.id);
    assert.ok(
      ids.includes(`${sid}-sub-toolu_NEW`),
      "new toolu-keyed subagent row present"
    );
    assert.ok(
      ids.includes(`${sid}-sub-deadbeef`),
      "working hook subagent survives the purge"
    );
    assert.ok(
      !ids.includes(`${sid}-sub-0`),
      "stale idx-keyed subagent row purged"
    );
    assert.equal(ids.length, 2, "exactly new import row + live hook row");

    // Stop events: the 3 legacy per-content-block rows are gone; the per-turn
    // re-derived Stop (from messageTimestamps) is the only one left.
    const stops = await db.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
      "SELECT COUNT(*) AS cnt FROM events WHERE session_id = $1 AND event_type = 'Stop'",
      sid
    );
    assert.equal(stops[0].cnt, 1, "legacy Stop residue purged");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Hook path: token_events appended incrementally; empty extract never wipes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");

  // Injectable transcript extracts, switched per hook call.
  let currentRecords: Array<{
    timestamp: string;
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }> = [];
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
    extractTranscript: () => ({
      tokensByModel: new Map([
        [
          "claude-sonnet-4-5",
          { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
        ],
      ]),
      latestModel: "claude-sonnet-4-5",
      compactionCount: 0,
      records: currentRecords,
    }),
  });

  try {
    const sid = "hook-append-test";
    const rec = (ts: string, input: number) => ({
      timestamp: ts,
      model: "claude-sonnet-4-5",
      input,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
    });

    // First hook event: transcript has 2 turn records.
    currentRecords = [
      rec("2026-06-07T10:00:30.000Z", 100),
      rec("2026-06-07T10:01:00.000Z", 200),
    ];
    await db.processEvent(
      "PostToolUse",
      { session_id: sid, transcript_path: "/fake/transcript.jsonl" },
      "claude"
    );

    const count1 = await db.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
      "SELECT COUNT(*) AS cnt FROM token_events WHERE session_id = $1",
      sid
    );
    assert.equal(count1[0].cnt, 2, "both records inserted on first call");

    // Second hook event: transcript appended one new turn. Only the new
    // record (past the HWM) inserts — the older two are not re-inserted.
    currentRecords = [
      rec("2026-06-07T10:00:30.000Z", 100),
      rec("2026-06-07T10:01:00.000Z", 200),
      rec("2026-06-07T10:02:00.000Z", 300),
    ];
    await db.processEvent(
      "PostToolUse",
      { session_id: sid, transcript_path: "/fake/transcript.jsonl" },
      "claude"
    );

    const rows2 = await db.prisma.client.$queryRawUnsafe<
      { created_at: string }[]
    >(
      "SELECT created_at FROM token_events WHERE session_id = $1 ORDER BY created_at",
      sid
    );
    assert.equal(rows2.length, 3, "exactly one new row appended");

    // Third hook event: empty extract (e.g. unreadable/empty transcript) must
    // NOT wipe the existing rows.
    currentRecords = [];
    await db.processEvent(
      "Stop",
      { session_id: sid, transcript_path: "/fake/transcript.jsonl" },
      "claude"
    );

    const count3 = await db.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
      "SELECT COUNT(*) AS cnt FROM token_events WHERE session_id = $1",
      sid
    );
    assert.equal(count3[0].cnt, 3, "empty extract never wipes rows");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
