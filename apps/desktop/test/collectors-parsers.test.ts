/**
 * @file collectors-parsers.test.ts
 * @description Validates the first-party harness parsers (FEA-1503) against
 * synthetic transcripts in the documented on-disk formats. Fixtures are carried
 * over from the prior vendor-parser tests so the CommonJS→TypeScript port is
 * proven not to drift, plus a Claude transcript fixture for the new first-party
 * Claude collector.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { createCodexCollector } from "../src/main/collectors/codex/codex-collector.js";
import { parseRolloutFile } from "../src/main/collectors/codex/codex-parser.js";
import { workspacePathFromUri } from "../src/main/collectors/copilot/copilot-home.js";
import {
  parseChatSessionFile,
  parseCliEventFile,
} from "../src/main/collectors/copilot/copilot-parser.js";
import { parseTranscriptFile } from "../src/main/collectors/cursor/cursor-parser.js";
import { loadSessionsFromDb } from "../src/main/collectors/opencode/opencode-parser.js";
import {
  cleanupTempDirs,
  makeTempDir,
  writeJsonl,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

const CODEX_UUID = "11111111-1111-4111-8111-111111111111";
const CODEX_PARENT_UUID = "22222222-2222-4222-8222-222222222222";
const CODEX_CHILD_UUID = "33333333-3333-4333-8333-333333333333";
const CODEX_GRANDCHILD_UUID = "44444444-4444-4444-8444-444444444444";
const CODEX_MISSING_PARENT_UUID = "55555555-5555-4555-8555-555555555555";
const CODEX_DUPLICATE_UUID = "66666666-6666-4666-8666-666666666666";
const CODEX_FORK_UUID = "77777777-7777-4777-8777-777777777777";

function writeRollout(name: string, lines: unknown[]): string {
  return writeJsonl(makeTempDir("codex-rollout-"), name, lines);
}

function writeCodexCollectorRollout(
  root: string,
  id: string,
  lines: unknown[],
  prefix = "2026-06-24T10-00-00"
): string {
  const dir = path.join(root, "2026", "06", "24");
  mkdirSync(dir, { recursive: true });
  return writeJsonl(dir, `rollout-${prefix}-${id}.jsonl`, lines);
}

function codexSessionMeta(
  timestamp: string,
  payload: Record<string, unknown>
): unknown {
  return {
    timestamp,
    type: "session_meta",
    payload: {
      cwd: "/Users/dev/codex-parent",
      cli_version: "0.40.0",
      ...payload,
    },
  };
}

function codexSubagentMeta(
  timestamp: string,
  id: string,
  parentThreadId: string,
  depth = 1
): unknown {
  return codexSessionMeta(timestamp, {
    id,
    source: {
      subagent: {
        agent_nickname: `child-${id.slice(0, 4)}`,
        agent_role: "worker",
        thread_spawn: {
          parent_thread_id: parentThreadId,
          depth,
        },
      },
    },
  });
}

function codexTurn(timestamp: string, model = "gpt-5-codex"): unknown {
  return {
    timestamp,
    type: "turn_context",
    payload: { model, cwd: "/Users/dev/codex-parent" },
  };
}

function codexUser(timestamp: string): unknown {
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "user_message", message: "work" },
  };
}

function codexAssistant(timestamp: string): unknown {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    },
  };
}

function codexTokenCount(
  timestamp: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number
): unknown {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: cachedInputTokens,
          output_tokens: outputTokens,
        },
      },
      turn_context: { model: "gpt-5-codex" },
    },
  };
}

function codexMcpToolCallBegin(
  timestamp: string,
  argumentsValue: unknown
): unknown {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "mcp_tool_call_begin",
      server: "github",
      method: "create_pull_request",
      arguments: argumentsValue,
    },
  };
}

function codexMcpToolCallEnd(timestamp: string, output: unknown): unknown {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "mcp_tool_call_end",
      output,
    },
  };
}

function minimalCodexRollout(
  id: string,
  timestamp: string,
  totals: { input: number; cached: number; output: number },
  meta?: unknown
): unknown[] {
  return [
    meta ?? codexSessionMeta(timestamp, { id, source: "exec" }),
    codexTurn(timestamp),
    codexUser(timestamp),
    codexAssistant(timestamp),
    codexTokenCount(timestamp, totals.input, totals.cached, totals.output),
  ];
}

describe("Copilot parsers", () => {
  test("Copilot workspace file URIs decode to filesystem paths", () => {
    assert.equal(
      workspacePathFromUri("file:///Users/dev/my%20project"),
      "/Users/dev/my project"
    );
  });

  test("Copilot Chat parser supports request-based session files", () => {
    const dir = makeTempDir("copilot-chat-");
    const filePath = path.join(dir, "session.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        sessionId: "copilot-session-1",
        creationDate: 1_710_000_000_000,
        lastMessageDate: 1_710_000_060_000,
        requests: [
          {
            id: "req-1",
            timestamp: 1_710_000_000_000,
            message: { text: "Summarize the repo" },
            response: { markdown: "Here is the summary." },
            toolCalls: [{ name: "search", arguments: '{"query":"repo"}' }],
            reasoning: { summary: "think first" },
          },
        ],
      }),
      "utf8"
    );

    const parsed = parseChatSessionFile(filePath, "/Users/dev/my project");
    assert.ok(parsed, "expected a parsed Copilot chat session");
    assert.equal(parsed.sessionId, "copilot-chat-copilot-session-1");
    assert.equal(parsed.name, "my project");
    assert.equal(parsed.userMessages, 1);
    assert.equal(parsed.assistantMessages, 1);
    assert.equal(parsed.toolUses.length, 1);
    assert.equal(parsed.toolUses[0].name, "search");
    assert.equal(parsed.thinkingBlockCount, 1);
    assert.deepEqual(parsed.turnDurations, [
      { durationMs: 60_000, timestamp: "2024-03-09T16:01:00.000Z" },
    ]);
    assert.equal(parsed.entrypoint, "copilot");
    assert.equal(parsed.startedAt, "2024-03-09T16:00:00.000Z");
    assert.equal(parsed.endedAt, "2024-03-09T16:01:00.000Z");
  });

  // See the fresh-shape INVARIANT note above the Cursor test. Copilot's source is
  // OpenAI-compatible but reports `input` as FRESH with cache as separate additive
  // fields (confirmed: real fixtures carry cache_read far exceeding input — which
  // is impossible under an inclusive total). Assert the parser stores input
  // verbatim, never folding cache into it.
  test("Copilot Chat parser emits the canonical fresh token shape (input excludes cache)", () => {
    const dir = makeTempDir("copilot-fresh-");
    const filePath = path.join(dir, "session.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        sessionId: "copilot-fresh-1",
        creationDate: 1_710_000_000_000,
        lastMessageDate: 1_710_000_060_000,
        model: "gpt-5.5",
        usage: {
          input_tokens: 600,
          output_tokens: 220,
          cache_read_tokens: 2000,
          cache_write_tokens: 300,
        },
        requests: [
          {
            id: "req-1",
            timestamp: 1_710_000_000_000,
            message: { text: "Summarize" },
            response: { markdown: "Done." },
          },
        ],
      }),
      "utf8"
    );

    const parsed = parseChatSessionFile(filePath, "/Users/dev/my project");
    assert.ok(parsed, "expected a parsed Copilot chat session");
    assert.deepEqual(parsed.tokensByModel["gpt-5.5"], {
      input: 600,
      output: 220,
      cacheRead: 2000,
      cacheWrite: 300,
    });
  });

  // Exercises the Copilot CLI events.jsonl dispatch path: session metadata,
  // multi-alias user/assistant/tool/usage/error/reasoning events, the tool_result
  // back-link to the most recent unresolved tool use, and turn-duration pairing.
  test("Copilot CLI parser dispatches events.jsonl into the shared session shape", async () => {
    const dir = makeTempDir("copilot-cli-");
    const filePath = path.join(dir, "events.jsonl");
    const events = [
      {
        type: "session_start",
        timestamp: "2024-03-09T16:00:00.000Z",
        payload: {
          cwd: "/Users/dev/cli project",
          version: "1.2.3",
          model: "gpt-5-cli",
        },
      },
      {
        type: "user_message",
        timestamp: "2024-03-09T16:00:01.000Z",
        payload: { text: "Hello CLI" },
      },
      {
        type: "tool_call",
        timestamp: "2024-03-09T16:00:02.000Z",
        payload: { name: "bash", arguments: '{"cmd":"ls"}' },
      },
      {
        type: "tool_result",
        timestamp: "2024-03-09T16:00:03.000Z",
        payload: { name: "bash", output: "file.txt" },
      },
      { type: "reasoning", timestamp: "2024-03-09T16:00:04.000Z", payload: {} },
      {
        type: "assistant_message",
        timestamp: "2024-03-09T16:00:05.000Z",
        payload: { text: "Here you go" },
      },
      {
        type: "usage",
        timestamp: "2024-03-09T16:00:06.000Z",
        payload: {
          model: "gpt-5-cli",
          usage: {
            input_tokens: 100,
            output_tokens: 40,
            cache_read_tokens: 10,
            cache_write_tokens: 5,
          },
        },
      },
      {
        type: "error",
        timestamp: "2024-03-09T16:00:07.000Z",
        payload: { message: "boom" },
      },
    ];
    writeFileSync(
      filePath,
      `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
      "utf8"
    );

    const parsed = await parseCliEventFile(filePath, "cli-1");
    assert.ok(parsed, "expected a parsed Copilot CLI session");
    assert.equal(parsed.sessionId, "copilot-cli-cli-1");
    assert.equal(parsed.name, "cli project");
    assert.equal(parsed.cwd, "/Users/dev/cli project");
    assert.equal(parsed.version, "1.2.3");
    assert.equal(parsed.model, "gpt-5-cli");
    assert.equal(parsed.userMessages, 1);
    assert.equal(parsed.assistantMessages, 1);
    assert.equal(parsed.thinkingBlockCount, 1);
    assert.equal(parsed.entrypoint, "copilot");
    assert.equal(parsed.startedAt, "2024-03-09T16:00:00.000Z");
    assert.equal(parsed.endedAt, "2024-03-09T16:00:07.000Z");
    // tool_result back-links onto the open bash tool use.
    assert.equal(parsed.toolUses.length, 1);
    assert.equal(parsed.toolUses[0].name, "bash");
    assert.equal(parsed.toolUses[0].output, "file.txt");
    // The open turn spans the user→assistant pair (reasoning does not close it).
    assert.deepEqual(parsed.turnDurations, [
      { durationMs: 4000, timestamp: "2024-03-09T16:00:05.000Z" },
    ]);
    assert.deepEqual(parsed.tokensByModel["gpt-5-cli"], {
      input: 100,
      output: 40,
      cacheRead: 10,
      cacheWrite: 5,
    });
    assert.equal(parsed.tokenSeries.length, 1);
    assert.equal(parsed.tokenSeries[0].model, "gpt-5-cli");
    assert.equal(parsed.apiErrors.length, 1);
    assert.equal(parsed.apiErrors[0].message, "boom");
    // Message order: human → thinking indicator (null text) → assistant.
    assert.deepEqual(
      parsed.messages.map((m) => ({
        role: m.role,
        text: m.text,
        isThinking: m.isThinking ?? false,
      })),
      [
        { role: "human", text: "Hello CLI", isThinking: false },
        { role: "assistant", text: null, isThinking: true },
        { role: "assistant", text: "Here you go", isThinking: false },
      ]
    );
  });
});

describe("OpenCode parser", () => {
  test("OpenCode parser loads sessions from opencode.db", () => {
    const dir = makeTempDir("opencode-db-");
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
    INSERT INTO session (
      id, slug, directory, title, version, agent, model, permission,
      time_created, time_updated, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
      "ses_1",
      "quiet-orchid",
      "/Users/dev/my project",
      "Repo overview",
      "1.15.5",
      "build",
      JSON.stringify({ id: "big-pickle", providerID: "opencode" }),
      "",
      1_710_000_000_000,
      1_710_000_060_000,
      100,
      20,
      5,
      40,
      0
    );
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "msg_1",
      "ses_1",
      1_710_000_000_000,
      1_710_000_000_000,
      JSON.stringify({ role: "user", time: { created: 1_710_000_000_000 } })
    );
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "msg_2",
      "ses_1",
      1_710_000_030_000,
      1_710_000_030_000,
      JSON.stringify({
        role: "assistant",
        path: { cwd: "/Users/dev/my project", root: "/Users/dev/my project" },
        time: { created: 1_710_000_030_000 },
      })
    );
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "part_2",
      "msg_2",
      "ses_1",
      1_710_000_025_000,
      1_710_000_026_000,
      JSON.stringify({
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "/Users/dev/my project/README.md" },
        },
        time: { start: 1_710_000_025_000, end: 1_710_000_026_000 },
      })
    );
    db.close();

    const sessions = loadSessionsFromDb(dbPath);
    assert.equal(sessions.length, 1);
    const parsed = sessions[0];
    assert.equal(parsed.sessionId, "opencode-ses_1");
    assert.equal(parsed.cwd, "/Users/dev/my project");
    assert.equal(parsed.name, "my project");
    assert.equal(parsed.model, "big-pickle");
    assert.equal(parsed.version, "1.15.5");
    assert.equal(parsed.toolUses.length, 1);
    assert.equal(parsed.toolUses[0].name, "read");
    assert.deepEqual(parsed.tokensByModel["big-pickle"], {
      input: 100,
      output: 25,
      cacheRead: 40,
      cacheWrite: 0,
    });
  });
});

describe("Codex parser", () => {
  test("Codex parser reads modern rollout envelopes into the shared session shape", async () => {
    const filePath = writeRollout(
      `rollout-2026-05-18T10-00-00-${CODEX_UUID}.jsonl`,
      [
        {
          timestamp: "2026-05-18T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: CODEX_UUID,
            cwd: "/Users/dev/myproj",
            cli_version: "0.40.0",
            git: { branch: "main" },
          },
        },
        {
          timestamp: "2026-05-18T10:00:01.000Z",
          type: "turn_context",
          payload: { model: "gpt-5-codex", cwd: "/Users/dev/myproj" },
        },
        {
          timestamp: "2026-05-18T10:00:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "fix the bug" },
        },
        {
          timestamp: "2026-05-18T10:00:05.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "on it" }],
          },
        },
        {
          timestamp: "2026-05-18T10:00:06.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "shell",
            arguments: '{"command":["ls"]}',
            call_id: "c1",
          },
        },
        {
          timestamp: "2026-05-18T10:00:07.000Z",
          type: "response_item",
          payload: {
            type: "reasoning",
            summary: [],
          },
        },
        {
          timestamp: "2026-05-18T10:00:08.000Z",
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
            turn_context: { model: "gpt-5-codex" },
          },
        },
      ]
    );

    const parsed = await parseRolloutFile(filePath);
    assert.ok(parsed, "expected a parsed Codex rollout");
    assert.equal(parsed.sessionId, CODEX_UUID);
    assert.equal(parsed.cwd, "/Users/dev/myproj");
    assert.equal(parsed.model, "gpt-5-codex");
    assert.equal(parsed.gitBranch, "main");
    assert.equal(parsed.version, "0.40.0");
    assert.equal(parsed.name, "myproj");
    assert.equal(parsed.entrypoint, "codex");
    assert.equal(parsed.userMessages, 1);
    assert.equal(parsed.assistantMessages, 1);
    assert.equal(parsed.thinkingBlockCount, 1);
    assert.equal(parsed.toolUses.length, 1);
    assert.equal(parsed.toolUses[0].name, "shell");
    // FEA-1459 Fix 3: input now excludes cached tokens for cross-harness
    // comparability (1200 total - 400 cached = 800 non-cached input).
    assert.deepEqual(parsed.tokensByModel["gpt-5-codex"], {
      input: 800,
      output: 350,
      cacheRead: 400,
      cacheWrite: 0,
    });
    assert.deepEqual(parsed.turnDurations, [
      { durationMs: 3000, timestamp: "2026-05-18T10:00:05.000Z" },
    ]);
    for (const key of [
      "messageTimestamps",
      "compactions",
      "apiErrors",
      "turnDurations",
      "toolResultErrors",
      "usageExtras",
      "teams",
    ] as const) {
      assert.ok(key in parsed, `missing normalized field: ${key}`);
    }
  });

  test("Codex parser excludes injected-context user messages and captures originator as entrypoint (FEA-2641)", async () => {
    // Mirrors the real `codex exec` rollout shape: Codex injects the AGENTS.md
    // blob + <environment_context> as a response_item user message with NO
    // event_msg/user_message twin; the submitted prompt gets both records.
    const filePath = writeRollout(
      `rollout-2026-07-10T07-00-00-${CODEX_UUID}.jsonl`,
      [
        {
          timestamp: "2026-07-10T07:00:00.000Z",
          type: "session_meta",
          payload: {
            id: CODEX_UUID,
            cwd: "/tmp/wg-review",
            cli_version: "0.40.0",
            originator: "codex_exec",
          },
        },
        {
          timestamp: "2026-07-10T07:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "# AGENTS.md instructions for /tmp/wg-review\n\n<INSTRUCTIONS>do things</INSTRUCTIONS>",
              },
              {
                type: "input_text",
                text: "<environment_context>\n  <cwd>/tmp/wg-review</cwd>\n</environment_context>",
              },
            ],
          },
        },
        {
          timestamp: "2026-07-10T07:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Review the diff." }],
          },
        },
        {
          timestamp: "2026-07-10T07:00:02.100Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Review the diff." },
        },
        {
          timestamp: "2026-07-10T07:00:09.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Reviewed." }],
          },
        },
      ]
    );

    const parsed = await parseRolloutFile(filePath);
    assert.ok(parsed, "expected a parsed Codex rollout");
    // Launch mode is preserved for downstream headless attribution.
    assert.equal(parsed.entrypoint, "codex_exec");
    // Only the submitted prompt is a human message; the injected context
    // response_item (no user_message event twin) is dropped.
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Review the diff.");
    assert.equal(parsed.userMessages, 1);
  });

  test("Codex parser keeps response_item user messages when the rollout has no user_message events (FEA-2641)", async () => {
    // Legacy/aborted rollouts carry no event_msg records at all — the
    // structural filter must fall back to counting response_item user
    // messages so old formats never lose genuine turns.
    const filePath = writeRollout(
      `rollout-2026-07-10T08-00-00-${CODEX_UUID}.jsonl`,
      [
        {
          timestamp: "2026-07-10T08:00:00.000Z",
          type: "session_meta",
          payload: { id: CODEX_UUID, cwd: "/x", cli_version: "0.30.0" },
        },
        {
          timestamp: "2026-07-10T08:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello world" }],
          },
        },
        {
          timestamp: "2026-07-10T08:00:05.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hi" }],
          },
        },
      ]
    );

    const parsed = await parseRolloutFile(filePath);
    assert.ok(parsed, "expected a parsed Codex rollout");
    assert.equal(parsed.entrypoint, "codex");
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "hello world");
    assert.equal(parsed.userMessages, 1);
  });

  test("Codex parser tolerates legacy records and returns null without timestamps", async () => {
    const legacyPath = writeRollout(`rollout-legacy-${CODEX_UUID}.jsonl`, [
      {
        session_id: CODEX_UUID,
        cwd: "/x",
        timestamp: "2026-05-18T09:00:00.000Z",
      },
      { type: "message", role: "user", content: "hi" },
      { type: "function_call", name: "apply_patch", arguments: "{}" },
    ]);
    const parsed = await parseRolloutFile(legacyPath);
    assert.ok(parsed);
    assert.equal(parsed.cwd, "/x");
    assert.equal(parsed.userMessages, 1);
    assert.equal(parsed.toolUses[0].name, "apply_patch");

    const untimestampedUserPath = writeRollout(
      `rollout-legacy-turns-${CODEX_UUID}.jsonl`,
      [
        {
          session_id: CODEX_UUID,
          cwd: "/x",
          timestamp: "2026-05-18T09:00:00.000Z",
        },
        { type: "message", role: "user", content: "hi" },
        {
          timestamp: "2026-05-18T09:00:05.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hello" }],
          },
        },
      ]
    );
    assert.deepEqual(
      (await parseRolloutFile(untimestampedUserPath))?.turnDurations,
      []
    );

    const emptyPath = writeRollout(`rollout-empty-${CODEX_UUID}.jsonl`, [
      {
        type: "event_msg",
        payload: { type: "agent_message_delta", delta: "x" },
      },
      "not json at all",
    ]);
    assert.equal(await parseRolloutFile(emptyPath), null);
  });
});

describe("Codex collector", () => {
  test("Codex collector folds parent-present child and grandchild rollouts", async () => {
    const root = makeTempDir("codex-collector-");
    const parentPath = writeCodexCollectorRollout(
      root,
      CODEX_PARENT_UUID,
      minimalCodexRollout(CODEX_PARENT_UUID, "2026-06-24T10:00:00.000Z", {
        input: 1000,
        cached: 400,
        output: 100,
      })
    );
    const childPath = writeCodexCollectorRollout(
      root,
      CODEX_CHILD_UUID,
      minimalCodexRollout(
        CODEX_CHILD_UUID,
        "2026-06-24T10:01:00.000Z",
        { input: 500, cached: 100, output: 50 },
        codexSubagentMeta(
          "2026-06-24T10:01:00.000Z",
          CODEX_CHILD_UUID,
          CODEX_PARENT_UUID,
          1
        )
      ),
      "2026-06-24T10-01-00"
    );
    writeCodexCollectorRollout(
      root,
      CODEX_GRANDCHILD_UUID,
      minimalCodexRollout(
        CODEX_GRANDCHILD_UUID,
        "2026-06-24T10:02:00.000Z",
        { input: 250, cached: 50, output: 25 },
        codexSubagentMeta(
          "2026-06-24T10:02:00.000Z",
          CODEX_GRANDCHILD_UUID,
          CODEX_CHILD_UUID,
          2
        )
      ),
      "2026-06-24T10-02-00"
    );
    const grandchildPath = path.join(
      root,
      "2026",
      "06",
      "24",
      `rollout-2026-06-24T10-02-00-${CODEX_GRANDCHILD_UUID}.jsonl`
    );
    const sources = [parentPath, childPath, grandchildPath];
    const collector = createCodexCollector({
      sessionsDir: root,
      archivedDir: path.join(root, "archive"),
      listSources: () => sources,
    });

    const [parent] = await collector.parse(parentPath);
    const directChild = await collector.parse(childPath);

    assert.equal(directChild.length, 0, "direct child source is suppressed");
    assert.equal(parent.subagents?.length, 2);
    assert.equal(parent.subagents?.[0].id, CODEX_CHILD_UUID);
    assert.equal(parent.subagents?.[0].parentId, null);
    assert.equal(parent.subagents?.[1].id, CODEX_GRANDCHILD_UUID);
    assert.equal(parent.subagents?.[1].parentId, CODEX_CHILD_UUID);
    assert.deepEqual(parent.tokensByModel["gpt-5-codex"], {
      input: 1200,
      output: 175,
      cacheRead: 550,
      cacheWrite: 0,
    });
  });

  test("Codex collector drops poisoned/malformed persisted linkage cache entries", async () => {
    const root = makeTempDir("codex-poisoned-cache-");
    const parentPath = writeCodexCollectorRollout(
      root,
      CODEX_PARENT_UUID,
      minimalCodexRollout(CODEX_PARENT_UUID, "2026-06-24T10:20:00.000Z", {
        input: 100,
        cached: 0,
        output: 10,
      }),
      "2026-06-24T10-20-00"
    );
    const childPath = writeCodexCollectorRollout(
      root,
      CODEX_CHILD_UUID,
      minimalCodexRollout(
        CODEX_CHILD_UUID,
        "2026-06-24T10:21:00.000Z",
        { input: 50, cached: 0, output: 5 },
        codexSubagentMeta(
          "2026-06-24T10:21:00.000Z",
          CODEX_CHILD_UUID,
          CODEX_PARENT_UUID
        )
      ),
      "2026-06-24T10-21-00"
    );

    // A poisoned cache: entries match the real files' mtime/size (so the
    // freshness check would accept them), but the parent's linkage.sourcePath
    // points at an unrelated path and the child's linkage is malformed. Trusting
    // either would crash the build (null.rolloutId) or aim descendant graph work
    // at a path outside the admitted source.
    const cachePath = path.join(root, "linkage-cache.json");
    const parentStat = statSync(parentPath);
    const childStat = statSync(childPath);
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        entries: {
          [parentPath]: {
            mtimeMs: parentStat.mtimeMs,
            size: parentStat.size,
            linkage: {
              rolloutId: CODEX_PARENT_UUID,
              parentThreadId: null,
              depth: null,
              agentNickname: null,
              agentRole: null,
              forkedFromId: null,
              sourcePath: path.join(root, "evil-outside.jsonl"),
            },
          },
          [childPath]: {
            mtimeMs: childStat.mtimeMs,
            size: childStat.size,
            linkage: null,
          },
        },
      })
    );

    const collector = createCodexCollector({
      sessionsDir: root,
      archivedDir: path.join(root, "archive"),
      listSources: () => [parentPath, childPath],
      linkageCachePath: cachePath,
    });

    // Must not throw, and must rebuild the graph from disk so the child still
    // folds into the parent (the poisoned entries are dropped, not trusted).
    const [parent] = await collector.parse(parentPath);
    const directChild = await collector.parse(childPath);

    assert.equal(directChild.length, 0, "child source is suppressed");
    assert.equal(parent.sessionId, CODEX_PARENT_UUID);
    assert.equal(parent.subagents?.length, 1);
    assert.equal(parent.subagents?.[0].id, CODEX_CHILD_UUID);
  });

  test("Codex collector prepareSourceBatch yields to the event loop on a cold-cache build", async () => {
    const root = makeTempDir("codex-cold-prep-yield-");
    // More than the graph-prep yield cadence (256) so a cold build crosses at
    // least one yield boundary in both the stat and read passes.
    const sources: string[] = [];
    for (let i = 0; i < 300; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      sources.push(
        writeCodexCollectorRollout(
          root,
          id,
          minimalCodexRollout(id, "2026-06-24T10:00:00.000Z", {
            input: 1,
            cached: 0,
            output: 1,
          })
        )
      );
    }

    // No linkageCachePath: a cold cache, so the build reads every rollout's
    // session_meta rather than reusing persisted linkage.
    const collector = createCodexCollector({
      sessionsDir: root,
      archivedDir: path.join(root, "archive"),
      listSources: () => sources,
    });

    const prep = collector.prepareSourceBatch?.(sources);
    assert.ok(
      prep instanceof Promise,
      "prepareSourceBatch must be cooperative (async)"
    );

    // Count event-loop turns that interleave while the build runs. A fully
    // synchronous build would let none fire before the promise's microtask
    // continuation resumes this test.
    let loopTurns = 0;
    let prepDone = false;
    const tick = () => {
      loopTurns++;
      if (!prepDone) {
        setImmediate(tick);
      }
    };
    setImmediate(tick);
    await prep;
    prepDone = true;

    assert.ok(
      loopTurns > 0,
      "the cold-cache rollout-graph build must yield to the event loop"
    );
  });

  test("Codex collector preserves folded child artifact refs on the parent session", async () => {
    const root = makeTempDir("codex-child-artifact-");
    const parentPath = writeCodexCollectorRollout(
      root,
      CODEX_PARENT_UUID,
      minimalCodexRollout(CODEX_PARENT_UUID, "2026-06-24T10:10:00.000Z", {
        input: 100,
        cached: 0,
        output: 10,
      }),
      "2026-06-24T10-10-00"
    );
    const childPath = writeCodexCollectorRollout(
      root,
      CODEX_CHILD_UUID,
      [
        codexSubagentMeta(
          "2026-06-24T10:11:00.000Z",
          CODEX_CHILD_UUID,
          CODEX_PARENT_UUID
        ),
        codexTurn("2026-06-24T10:11:00.000Z"),
        codexMcpToolCallBegin("2026-06-24T10:11:01.000Z", {
          title: "child PR",
        }),
        codexMcpToolCallEnd("2026-06-24T10:11:02.000Z", {
          url: "https://github.com/closedloop-ai/symphony-alpha/pull/4242",
        }),
        codexTokenCount("2026-06-24T10:11:03.000Z", 50, 0, 5),
      ],
      "2026-06-24T10-11-00"
    );
    const collector = createCodexCollector({
      sessionsDir: root,
      archivedDir: path.join(root, "archive"),
      listSources: () => [parentPath, childPath],
    });

    const [parent] = await collector.parse(parentPath);

    assert.equal(parent.subagents?.[0]?.toolUses?.length, 1);
    assert.equal(
      parent.subagents?.[0]?.toolUses?.[0]?.subagentId,
      CODEX_CHILD_UUID
    );
    assert.equal(parent.toolUses.length, 1);
    assert.equal(parent.toolUses[0]?.subagentId, CODEX_CHILD_UUID);
    assert.deepEqual(parent.artifacts.prs, [
      {
        number: "4242",
        repo: "closedloop-ai/symphony-alpha",
        url: "https://github.com/closedloop-ai/symphony-alpha/pull/4242",
      },
    ]);
  });

  test("Codex collector preserves missing-parent child as standalone", async () => {
    const root = makeTempDir("codex-missing-parent-");
    const childPath = writeCodexCollectorRollout(
      root,
      CODEX_MISSING_PARENT_UUID,
      minimalCodexRollout(
        CODEX_MISSING_PARENT_UUID,
        "2026-06-24T10:03:00.000Z",
        { input: 500, cached: 100, output: 50 },
        codexSubagentMeta(
          "2026-06-24T10:03:00.000Z",
          CODEX_MISSING_PARENT_UUID,
          "99999999-9999-4999-8999-999999999999",
          1
        )
      )
    );
    const collector = createCodexCollector({
      sessionsDir: root,
      archivedDir: path.join(root, "archive"),
      listSources: () => [childPath],
    });

    const [session] = await collector.parse(childPath);

    assert.equal(session.sessionId, CODEX_MISSING_PARENT_UUID);
    assert.equal(session.subagents?.length ?? 0, 0);
  });

  test("Codex collector collapses duplicate rollout ids while folding", async () => {
    const root = makeTempDir("codex-duplicate-");
    const parentPath = writeCodexCollectorRollout(
      root,
      CODEX_PARENT_UUID,
      minimalCodexRollout(CODEX_PARENT_UUID, "2026-06-24T10:04:00.000Z", {
        input: 100,
        cached: 0,
        output: 10,
      })
    );
    const firstChild = writeCodexCollectorRollout(
      root,
      CODEX_DUPLICATE_UUID,
      minimalCodexRollout(
        CODEX_DUPLICATE_UUID,
        "2026-06-24T10:05:00.000Z",
        { input: 50, cached: 0, output: 5 },
        codexSubagentMeta(
          "2026-06-24T10:05:00.000Z",
          CODEX_DUPLICATE_UUID,
          CODEX_PARENT_UUID
        )
      ),
      "2026-06-24T10-05-00"
    );
    const secondChild = writeCodexCollectorRollout(
      root,
      CODEX_DUPLICATE_UUID,
      minimalCodexRollout(
        CODEX_DUPLICATE_UUID,
        "2026-06-24T10:06:00.000Z",
        { input: 900, cached: 0, output: 90 },
        codexSubagentMeta(
          "2026-06-24T10:06:00.000Z",
          CODEX_DUPLICATE_UUID,
          CODEX_PARENT_UUID
        )
      ),
      "2026-06-24T10-06-00"
    );
    const collector = createCodexCollector({
      sessionsDir: root,
      archivedDir: path.join(root, "archive"),
      listSources: () => [parentPath, firstChild, secondChild],
    });

    const [parent] = await collector.parse(parentPath);

    assert.equal(parent.subagents?.length, 1);
    assert.deepEqual(parent.tokensByModel["gpt-5-codex"], {
      input: 150,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("Codex collector excludes present-parent fork replay snapshots", async () => {
    const root = makeTempDir("codex-fork-");
    const parentPath = writeCodexCollectorRollout(
      root,
      CODEX_PARENT_UUID,
      [
        codexSessionMeta("2026-06-24T10:07:00.000Z", {
          id: CODEX_PARENT_UUID,
          source: "exec",
        }),
        codexTurn("2026-06-24T10:07:00.000Z"),
        codexTokenCount("2026-06-24T10:07:01.000Z", 1000, 400, 100),
        codexTokenCount("2026-06-24T10:07:02.000Z", 3000, 1200, 300),
      ],
      "2026-06-24T10-07-00"
    );
    const forkPath = writeCodexCollectorRollout(
      root,
      CODEX_FORK_UUID,
      [
        {
          timestamp: "2026-06-24T10:08:00.000Z",
          type: "session_meta",
          payload: {
            id: CODEX_FORK_UUID,
            forked_from_id: CODEX_PARENT_UUID,
            source: {
              subagent: {
                agent_nickname: "fork-worker",
                agent_role: "worker",
                thread_spawn: {
                  parent_thread_id: CODEX_PARENT_UUID,
                  depth: 1,
                },
              },
            },
          },
        },
        codexTurn("2026-06-24T10:08:00.000Z"),
        codexTokenCount("2026-06-24T10:08:00.001Z", 1000, 400, 100),
        codexTokenCount("2026-06-24T10:08:00.002Z", 3000, 1200, 300),
        codexTokenCount("2026-06-24T10:08:30.000Z", 3500, 1300, 350),
        codexTokenCount("2026-06-24T10:09:00.000Z", 5000, 2000, 500),
      ],
      "2026-06-24T10-08-00"
    );
    const collector = createCodexCollector({
      sessionsDir: root,
      archivedDir: path.join(root, "archive"),
      listSources: () => [parentPath, forkPath],
    });

    const [parent] = await collector.parse(parentPath);

    assert.deepEqual(parent.subagents?.[0].tokensByModel?.["gpt-5-codex"], {
      input: 1200,
      output: 200,
      cacheRead: 800,
      cacheWrite: 0,
    });
    assert.deepEqual(parent.tokensByModel["gpt-5-codex"], {
      input: 3000,
      output: 500,
      cacheRead: 2000,
      cacheWrite: 0,
    });
  });
});

describe("Cursor parser", () => {
  test("Cursor parser derives turn durations from user/assistant timestamps", async () => {
    const dir = makeTempDir("cursor-transcript-");
    const sessionDir = path.join(dir, "session-123");
    mkdirSync(sessionDir, { recursive: true });
    const filePath = writeJsonl(sessionDir, "rollout.jsonl", [
      {
        timestamp: "2024-03-09T16:00:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/Users/dev/cursor project",
          model: "claude-3-7-sonnet",
        },
      },
      {
        timestamp: "2024-03-09T16:00:05.000Z",
        type: "user_message",
        payload: { message: "Investigate failing test" },
      },
      {
        timestamp: "2024-03-09T16:00:11.500Z",
        type: "assistant_message",
        payload: { message: "Looking now" },
      },
    ]);

    const parsed = await parseTranscriptFile(filePath);
    assert.ok(parsed, "expected a parsed Cursor transcript");
    assert.deepEqual(parsed.turnDurations, [
      { durationMs: 6500, timestamp: "2024-03-09T16:00:11.500Z" },
    ]);
  });

  // INVARIANT: every parser MUST emit the canonical fresh shape (see
  // NormalizedTokenCounts) — `input` is uncached, `cacheRead`/`cacheWrite` are
  // separate additive components. The cost engine ALWAYS sums these to the
  // genai-prices grand total, and dashboards treat `input` as cache-exclusive;
  // an inclusive `input` would mis-price (FEA-2082 compute_error) and double-count
  // dashboard totals. We assert with `cache_read > input` — a state impossible
  // under an inclusive total — so a parser that wrongly subtracted/clamped would
  // fail. Claude/Codex/OpenCode are covered by their assertions above (Codex must
  // subtract because its source is inclusive); these cover Cursor and Copilot.
  test("Cursor parser emits the canonical fresh token shape (input excludes cache)", async () => {
    const dir = makeTempDir("cursor-fresh-");
    const sessionDir = path.join(dir, "session-fresh");
    mkdirSync(sessionDir, { recursive: true });
    const filePath = writeJsonl(sessionDir, "rollout.jsonl", [
      {
        timestamp: "2024-03-09T16:00:00.000Z",
        type: "session_meta",
        payload: { cwd: "/Users/dev/cursor project", model: "gpt-5.5" },
      },
      {
        timestamp: "2024-03-09T16:00:05.000Z",
        type: "token_count",
        payload: {
          usage: {
            input_tokens: 600,
            output_tokens: 220,
            cache_read_tokens: 2000,
            cache_write_tokens: 300,
          },
        },
      },
    ]);

    const parsed = await parseTranscriptFile(filePath);
    assert.ok(parsed, "expected a parsed Cursor transcript");
    assert.deepEqual(parsed.tokensByModel["gpt-5.5"], {
      input: 600,
      output: 220,
      cacheRead: 2000,
      cacheWrite: 300,
    });
  });
});

describe("Claude parser", () => {
  test("Claude parser extracts session metadata, tokens, tools, and thinking", async () => {
    const dir = makeTempDir("claude-proj-");
    const filePath = writeJsonl(dir, "claude-sess-1.jsonl", [
      {
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        gitBranch: "main",
        version: "1.2.3",
        message: {
          role: "user",
          content: "Investigate the local changes.",
        },
      },
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:05.000Z",
        message: {
          model: "claude-opus-4-5",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
          },
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "tool_use", name: "Read", input: { file_path: "x" } },
          ],
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.sessionId, "claude-sess-1");
    assert.equal(parsed.cwd, "/Users/dev/proj");
    assert.equal(parsed.gitBranch, "main");
    assert.equal(parsed.version, "1.2.3");
    assert.equal(parsed.model, "claude-opus-4-5");
    assert.equal(parsed.userMessages, 1);
    assert.equal(parsed.assistantMessages, 1);
    assert.equal(parsed.messages[0]?.role, "human");
    assert.equal(parsed.messages[0]?.text, "Investigate the local changes.");
    assert.equal(parsed.thinkingBlockCount, 1);
    assert.equal(parsed.toolUses.length, 1);
    assert.equal(parsed.toolUses[0].name, "Read");
    assert.deepEqual(parsed.messageTimestamps, ["2024-03-09T16:00:05.000Z"]);
    assert.deepEqual(parsed.tokensByModel["claude-opus-4-5"], {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
    });
    assert.equal(parsed.startedAt, "2024-03-09T16:00:00.000Z");
    assert.equal(parsed.endedAt, "2024-03-09T16:00:05.000Z");
    assert.equal(parsed.entrypoint, "claude");
  });

  test("Claude parser excludes tool-result-only user turns from human messages (FEA-2192)", async () => {
    const dir = makeTempDir("claude-toolresult-");
    const filePath = writeJsonl(dir, "claude-toolresult.jsonl", [
      {
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Read the config file." },
      },
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_read_1",
              name: "Read",
              input: { file_path: "config.ts" },
            },
          ],
        },
      },
      {
        // Synthetic tool-result turn: delivered as a `user` entry but carrying no
        // human-authored text. Must NOT be counted as human steering (FEA-2192).
        type: "user",
        timestamp: "2024-03-09T16:00:02.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_read_1",
              content: "export const config = {};",
            },
          ],
        },
      },
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:03.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [{ type: "text", text: "Done." }],
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // Only the genuine prompt counts; the tool-result turn is not a human message.
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Read the config file.");
    // The tool_result is still back-linked to its tool_use (applyToolResult runs).
    assert.equal(parsed.toolUses.length, 1);
    assert.equal(parsed.toolUses[0]?.output, "export const config = {};");
  });

  test("Claude parser keeps user turns mixing text and tool_result as human messages (FEA-2192)", async () => {
    const dir = makeTempDir("claude-mixed-");
    const filePath = writeJsonl(dir, "claude-mixed.jsonl", [
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_read_1",
              name: "Read",
              input: { file_path: "config.ts" },
            },
          ],
        },
      },
      {
        // A user turn carrying BOTH a tool_result and human-authored text — a
        // genuine prompt that must NOT be skipped (FEA-2192).
        type: "user",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_read_1",
              content: "export const config = {};",
            },
            { type: "text", text: "Now refactor it." },
          ],
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // The mixed turn still counts as one human message and keeps its text...
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Now refactor it.");
    // ...while the tool_result in the same turn is still back-linked to its tool.
    assert.equal(parsed.toolUses[0]?.output, "export const config = {};");
  });

  test("Claude parser excludes synthetic user turns (meta, compaction, task-notification) from human messages (FEA-2192)", async () => {
    const dir = makeTempDir("claude-synthetic-");
    const filePath = writeJsonl(dir, "claude-synthetic.jsonl", [
      {
        // Genuine human prompt.
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        message: { role: "user", content: "Run the review." },
      },
      {
        // Slash-command expansion injected as a meta turn.
        type: "user",
        isMeta: true,
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "# Comprehensive Review\nRun..." }],
        },
      },
      {
        // Auto-compaction continuation summary.
        type: "user",
        isCompactSummary: true,
        timestamp: "2024-03-09T16:00:02.000Z",
        message: {
          role: "user",
          content:
            "This session is being continued from a previous conversation.",
        },
      },
      {
        // Background-task completion notification (origin.kind).
        type: "user",
        origin: { kind: "task-notification" },
        timestamp: "2024-03-09T16:00:03.000Z",
        message: {
          role: "user",
          content:
            "<task-notification>\n<task-id>abc</task-id>\n<result>DONE</result>\n</task-notification>",
        },
      },
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:04.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [{ type: "text", text: "On it." }],
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // Only the genuine prompt is a human message; meta/compaction/task-notification
    // turns reuse the `user` role but are not human steering (FEA-2192).
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Run the review.");
  });

  test("Claude parser still captures tool_result on a synthetic user turn (FEA-2192)", async () => {
    const dir = makeTempDir("claude-synthetic-toolresult-");
    const filePath = writeJsonl(dir, "claude-synthetic-toolresult.jsonl", [
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_read_1",
              name: "Read",
              input: { file_path: "config.ts" },
            },
          ],
        },
      },
      {
        // Synthetic (isMeta) turn that ALSO carries a tool_result. The synthetic
        // guard must skip the human message, but applyToolResult runs first and
        // unconditionally, so the tool output must still be back-linked (FEA-2192).
        type: "user",
        isMeta: true,
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_read_1",
              content: "export const config = {};",
            },
          ],
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // The synthetic turn adds no human message...
    assert.equal(parsed.userMessages, 0);
    assert.equal(parsed.messages.filter((m) => m.role === "human").length, 0);
    // ...but its tool_result is still captured and back-linked to the tool_use.
    assert.equal(parsed.toolUses.length, 1);
    assert.equal(parsed.toolUses[0]?.output, "export const config = {};");
  });

  test("Claude parser carries inline sidechain parentUuid into subagent hierarchy", async () => {
    const dir = makeTempDir("claude-sidechain-");
    const filePath = writeJsonl(dir, "claude-sidechain.jsonl", [
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        uuid: "parent-sidechain",
        isSidechain: true,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_parent_sidechain",
              name: "Read",
              input: { file_path: "parent.ts" },
            },
          ],
        },
      },
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:01.000Z",
        uuid: "child-sidechain",
        parentUuid: "parent-sidechain",
        isSidechain: true,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_sidechain",
              name: "Read",
              input: { file_path: "nested.ts" },
            },
          ],
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);

    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.subagents?.length, 2);
    const child = parsed.subagents?.find(
      (subagent) => subagent.id === "child-sidechain"
    );
    assert.equal(child?.parentId, "parent-sidechain");
    assert.equal(child?.toolUses?.[0]?.subagentId, "child-sidechain");
  });

  test("Claude parser does not create self-parented sidechain subagents from fallback ids", async () => {
    const dir = makeTempDir("claude-sidechain-fallback-");
    const filePath = path.join(dir, "claude-sidechain-fallback.jsonl");
    writeFileSync(
      filePath,
      `${JSON.stringify({
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        parentUuid: "parent-only-id",
        isSidechain: true,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "fallback.ts" },
            },
          ],
        },
      })}\n`,
      "utf8"
    );

    const parsed = await parseClaudeFile(filePath);

    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.subagents?.[0]?.id, "parent-only-id");
    assert.equal(parsed.subagents?.[0]?.parentId, null);
  });

  test("Claude parser de-dupes matching inline sidechain and sidecar tool uses", async () => {
    const dir = makeTempDir("claude-sidechain-sidecar-");
    const sessionId = "claude-sidechain-sidecar";
    const nativeSubagentId = "agent-dup";
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    const subagentsDir = path.join(dir, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      filePath,
      [
        {
          type: "assistant",
          timestamp: "2024-03-09T16:00:00.000Z",
          uuid: nativeSubagentId,
          isSidechain: true,
          message: {
            role: "assistant",
            model: "claude-opus-4-5",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            content: [
              {
                type: "tool_use",
                id: "toolu_duplicate",
                name: "Read",
                input: { file_path: "inline.ts" },
              },
            ],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(subagentsDir, `${nativeSubagentId}.jsonl`),
      `${JSON.stringify({
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-5",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [
            {
              type: "tool_use",
              id: "toolu_duplicate",
              name: "Read",
              input: { file_path: "sidecar.ts" },
            },
          ],
        },
      })}\n`,
      "utf8"
    );

    const parsed = await parseClaudeFile(filePath);

    assert.ok(parsed, "expected a parsed Claude transcript");
    const subagent = parsed.subagents?.find(
      (candidate) => candidate.id === nativeSubagentId
    );
    assert.equal(subagent?.toolUses?.length, 1);
    assert.equal(subagent?.toolUses?.[0]?.id, "toolu_duplicate");
    assert.deepEqual(subagent?.toolUses?.[0]?.input, {
      file_path: "inline.ts",
    });
  });

  test("Claude parser excludes ScheduleWakeup XML re-injection from human messages (FEA-2641)", async () => {
    const dir = makeTempDir("claude-wakeup-xml-");
    const filePath = writeJsonl(dir, "claude-wakeup-xml.jsonl", [
      {
        // Genuine typed prompt — must still count.
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Run the suite." },
      },
      {
        // Assistant records the ScheduleWakeup prompt to re-inject later.
        type: "assistant",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_1",
              name: "ScheduleWakeup",
              input: { prompt: "/babysit-pr 2257 --no-merge" },
            },
          ],
        },
      },
      {
        // Harness re-injects the scheduled prompt as expanded slash-command XML.
        // Must NOT be counted as a human message (FEA-2641).
        type: "user",
        timestamp: "2024-03-09T16:00:02.000Z",
        message: {
          role: "user",
          content:
            "<command-message>babysit-pr</command-message>\n<command-name>/babysit-pr</command-name>\n<command-args>2257 --no-merge</command-args>",
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // Only the genuine prompt counts; the XML re-injection is excluded.
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Run the suite.");
    // The ScheduleWakeup tool_use is still captured even though the re-injection
    // is excluded from human messages.
    const wakeupTool = parsed.toolUses.find(
      (tu) => tu.name === "ScheduleWakeup"
    );
    assert.ok(wakeupTool, "ScheduleWakeup tool_use must be captured");
  });

  test("Claude parser excludes ScheduleWakeup plain-text re-injection from human messages (FEA-2641)", async () => {
    const dir = makeTempDir("claude-wakeup-plain-");
    const filePath = writeJsonl(dir, "claude-wakeup-plain.jsonl", [
      {
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Start the task." },
      },
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_2",
              name: "ScheduleWakeup",
              input: { prompt: "check the deploy status" },
            },
          ],
        },
      },
      {
        // Harness re-injects the prompt verbatim as plain text. Must NOT count (FEA-2641).
        type: "user",
        timestamp: "2024-03-09T16:00:02.000Z",
        message: { role: "user", content: "check the deploy status" },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Start the task.");
  });

  test("Claude parser consumes a scheduled prompt per firing — a later genuine identical prompt still counts (FEA-2641)", async () => {
    const dir = makeTempDir("claude-wakeup-consume-");
    const filePath = writeJsonl(dir, "claude-wakeup-consume.jsonl", [
      {
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_consume",
              name: "ScheduleWakeup",
              input: { prompt: "check status" },
            },
          ],
        },
      },
      {
        // The single scheduled firing re-injects the prompt: NOT counted, and
        // this match CONSUMES the recorded firing.
        type: "user",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: { role: "user", content: "check status" },
      },
      {
        // A human later GENUINELY types the same text. With the firing already
        // consumed, this must count as a human message.
        type: "user",
        timestamp: "2024-03-09T16:00:02.000Z",
        message: { role: "user", content: "check status" },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "check status");
    assert.equal(humanMessages[0]?.timestamp, "2024-03-09T16:00:02.000Z");
  });

  test("Claude parser excludes slash-normalized ScheduleWakeup XML re-injection from human messages (FEA-2641)", async () => {
    const dir = makeTempDir("claude-wakeup-slashnorm-");
    const filePath = writeJsonl(dir, "claude-wakeup-slashnorm.jsonl", [
      {
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Go ahead." },
      },
      {
        // Older transcript records the prompt WITHOUT the leading slash.
        type: "assistant",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_3",
              name: "ScheduleWakeup",
              input: { prompt: "babysit-pr 2257 --no-merge" },
            },
          ],
        },
      },
      {
        // XML re-injection carries the leading slash in <command-name>; the
        // parser strips it when matching against the slash-free recorded prompt
        // (FEA-2641). Must NOT count as a human message.
        type: "user",
        timestamp: "2024-03-09T16:00:02.000Z",
        message: {
          role: "user",
          content:
            "<command-name>/babysit-pr</command-name>\n<command-args>2257 --no-merge</command-args>",
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Go ahead.");
  });

  test("Claude parser excludes <local-command-stdout> user entries from human messages (FEA-2641)", async () => {
    const dir = makeTempDir("claude-local-stdout-");
    const filePath = writeJsonl(dir, "claude-local-stdout.jsonl", [
      {
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Build it." },
      },
      {
        // Local command output echoed back as a user entry — not human input (FEA-2641).
        type: "user",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          role: "user",
          content: "<local-command-stdout>Bye!</local-command-stdout>",
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // The local-command-stdout echo must not be counted as a human message.
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Build it.");
    // FEA-3112: the echo is kept in the transcript as a role:"system" message
    // (not dropped), so the session-detail trace still shows the command output.
    const systemMessages = parsed.messages.filter((m) => m.role === "system");
    assert.equal(systemMessages.length, 1);
    assert.equal(
      systemMessages[0]?.text,
      "<local-command-stdout>Bye!</local-command-stdout>"
    );
  });

  test("Claude parser excludes teammate-injected user entries from human messages (FEA-2641)", async () => {
    const dir = makeTempDir("claude-teammate-msg-");
    const filePath = writeJsonl(dir, "claude-teammate-msg.jsonl", [
      {
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Keep going." },
      },
      {
        // Agent-to-agent message injected as a user entry — not human steering (FEA-2641).
        type: "user",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          role: "user",
          content: "Another Claude session sent a message: check the PR status",
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Keep going.");
  });

  test("Claude parser counts genuine typed slash command with no matching ScheduleWakeup as a human message (FEA-2641)", async () => {
    const dir = makeTempDir("claude-genuine-slash-");
    const filePath = writeJsonl(dir, "claude-genuine-slash.jsonl", [
      {
        // User types a slash command; no ScheduleWakeup recorded this prompt,
        // so it is genuine human input and must count (FEA-2641).
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: {
          role: "user",
          content:
            "<command-name>/model</command-name>\n<command-args></command-args>",
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // No matching ScheduleWakeup → must be counted as a human message.
    assert.equal(parsed.userMessages, 1);
    assert.equal(parsed.messages.filter((m) => m.role === "human").length, 1);
  });

  test("Claude parser excludes typed /exit from human messages but keeps the slash-command record (FEA-2641)", async () => {
    const dir = makeTempDir("claude-exit-cmd-");
    const filePath = writeJsonl(dir, "claude-exit-cmd.jsonl", [
      {
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Build it." },
      },
      {
        // Typed /exit — a clean session exit is not human steering (FEA-2641
        // PM ruling). Must not add a human turn, but the command itself stays
        // in the slash-command record.
        type: "user",
        timestamp: "2024-03-09T18:00:00.000Z",
        message: {
          role: "user",
          content:
            "<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>",
        },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Build it.");
    assert.ok(
      parsed.slashCommands.some((c) => c.name === "/exit"),
      "typed /exit must still be recorded as a slash command"
    );
  });

  test("Claude parser counts user entries with origin.kind='human' as genuine messages (FEA-2641)", async () => {
    const dir = makeTempDir("claude-origin-human-");
    const filePath = writeJsonl(dir, "claude-origin-human.jsonl", [
      {
        // Newer harness versions stamp origin.kind:"human" on genuinely-typed
        // prompts. Must NOT be treated as synthetic — it is real human input
        // (FEA-2641; contrast: origin.kind:"task-notification" IS synthetic).
        type: "user",
        origin: { kind: "human" },
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Deploy to staging." },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Deploy to staging.");
  });

  test("Claude parser handles invalid ScheduleWakeup inputs without crashing and still counts subsequent genuine prompts (FEA-2641)", async () => {
    const dir = makeTempDir("claude-wakeup-edge-");
    const filePath = writeJsonl(dir, "claude-wakeup-edge.jsonl", [
      {
        // null prompt — must not crash or record anything in scheduledPrompts.
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_null",
              name: "ScheduleWakeup",
              input: { prompt: null },
            },
          ],
        },
      },
      {
        // Empty string prompt — must not record (empty after trim).
        type: "assistant",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_empty",
              name: "ScheduleWakeup",
              input: { prompt: "" },
            },
          ],
        },
      },
      {
        // Numeric prompt — not a string, must not be recorded.
        type: "assistant",
        timestamp: "2024-03-09T16:00:02.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_num",
              name: "ScheduleWakeup",
              input: { prompt: 42 },
            },
          ],
        },
      },
      {
        // Missing prompt field entirely — must not crash.
        type: "assistant",
        timestamp: "2024-03-09T16:00:03.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_nofield",
              name: "ScheduleWakeup",
              input: {},
            },
          ],
        },
      },
      {
        // Genuine human prompt after all the invalid edge inputs — must still count.
        type: "user",
        timestamp: "2024-03-09T16:00:04.000Z",
        cwd: "/Users/dev/proj",
        message: { role: "user", content: "Proceed normally." },
      },
    ]);

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // Genuine prompt after all invalid ScheduleWakeup inputs must count.
    assert.equal(parsed.userMessages, 1);
    const humanMessages = parsed.messages.filter((m) => m.role === "human");
    assert.equal(humanMessages.length, 1);
    assert.equal(humanMessages[0]?.text, "Proceed normally.");
    // All four ScheduleWakeup tool_uses are still captured despite invalid inputs.
    assert.equal(
      parsed.toolUses.filter((tu) => tu.name === "ScheduleWakeup").length,
      4
    );
  });

  test("Claude parser returns null for a transcript with no timestamps", async () => {
    const dir = makeTempDir("claude-empty-");
    const filePath = path.join(dir, "empty.jsonl");
    writeFileSync(filePath, `${JSON.stringify({ type: "summary" })}\n`, "utf8");
    assert.equal(await parseClaudeFile(filePath), null);
  });

  test("Claude parser ignores symlinked subagent sidecars outside the session directory", async () => {
    const dir = makeTempDir("claude-sidecar-");
    const outsideDir = makeTempDir("claude-sidecar-out-");
    try {
      const sessionId = "claude-sidecar";
      const filePath = path.join(dir, `${sessionId}.jsonl`);
      const subagentsDir = path.join(dir, sessionId, "subagents");
      const outsideSubagent = path.join(outsideDir, "agent-outside.jsonl");
      mkdirSync(subagentsDir, { recursive: true });
      writeFileSync(
        filePath,
        [
          {
            type: "user",
            timestamp: "2024-03-09T16:00:00.000Z",
            cwd: "/Users/dev/proj",
            message: { role: "user", content: "hello" },
          },
          {
            type: "assistant",
            timestamp: "2024-03-09T16:00:05.000Z",
            message: {
              model: "claude-opus-4-5",
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
              content: [{ type: "text", text: "hello" }],
            },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
        "utf8"
      );
      writeFileSync(
        outsideSubagent,
        `${JSON.stringify({
          type: "assistant",
          timestamp: "2024-03-09T16:00:06.000Z",
          message: {
            model: "claude-opus-4-5",
            usage: {
              input_tokens: 1000,
              output_tokens: 1000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            content: [{ type: "text", text: "outside" }],
          },
        })}\n`,
        "utf8"
      );
      symlinkSync(
        outsideSubagent,
        path.join(subagentsDir, "agent-outside.jsonl")
      );

      const parsed = await parseClaudeFile(filePath);

      assert.ok(parsed);
      assert.deepEqual(parsed.tokensByModel["claude-opus-4-5"], {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // FEA-2771: malformed JSONL lines are skipped silently; the parse-quality
  // signal must count them and separate a benign truncated final line from
  // mid-file corruption that drops a turn with no other trace.
  const userLine = JSON.stringify({
    type: "user",
    timestamp: "2024-03-09T16:00:00.000Z",
    // Synthetic, non-home cwd: these parse-quality cases don't exercise cwd
    // path handling, so keep it machine-independent (apps/desktop/AGENTS.md).
    cwd: "/workspace/project",
    message: { role: "user", content: "hello" },
  });
  const assistantLine = JSON.stringify({
    type: "assistant",
    timestamp: "2024-03-09T16:00:05.000Z",
    message: {
      model: "claude-opus-4-5",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "text", text: "hi" }],
    },
  });
  // A truncated mid-write line: valid JSON prefix, no closing brace.
  const truncatedLine = '{"type":"assistant","timestamp":"2024-03-09T16:00:06';

  test("Claude parser reports a clean parse quality when all lines are valid", async () => {
    const dir = makeTempDir("claude-pq-clean-");
    const filePath = path.join(dir, "clean.jsonl");
    writeFileSync(filePath, `${userLine}\n${assistantLine}\n`, "utf8");

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 2,
      malformedLines: 0,
      truncatedFinalLine: false,
    });
  });

  test("Claude parser flags a truncated final line as benign in parse quality (FEA-2771)", async () => {
    const dir = makeTempDir("claude-pq-truncated-");
    const filePath = path.join(dir, "truncated.jsonl");
    // Valid turns followed by a truncated trailing line (live/interrupted write).
    writeFileSync(
      filePath,
      `${userLine}\n${assistantLine}\n${truncatedLine}\n`,
      "utf8"
    );

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // Prior turns still parse; the trailing drop is flagged but expected.
    assert.deepEqual(parsed.tokensByModel["claude-opus-4-5"], {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
    });
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 3,
      malformedLines: 1,
      truncatedFinalLine: true,
    });
  });

  test("Claude parser flags mid-file corruption in parse quality (FEA-2771)", async () => {
    const dir = makeTempDir("claude-pq-corrupt-");
    const filePath = path.join(dir, "corrupt.jsonl");
    // A malformed line BEFORE the final line: real corruption, not truncation.
    writeFileSync(
      filePath,
      `${userLine}\n${truncatedLine}\n${assistantLine}\n`,
      "utf8"
    );

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 3,
      malformedLines: 1,
      // Final line parsed cleanly → the drop is mid-file, not a truncation.
      truncatedFinalLine: false,
    });
    // Consumers derive mid-file corruption = malformedLines - (truncated ? 1 : 0).
    const midFileMalformed =
      (parsed.parseQuality?.malformedLines ?? 0) -
      (parsed.parseQuality?.truncatedFinalLine ? 1 : 0);
    assert.equal(midFileMalformed, 1);
  });

  // A distinct valid subagent turn, used to place corruption mid-file (a
  // malformed line that is NOT the subagent's final line).
  const subAssistantLine = JSON.stringify({
    type: "assistant",
    timestamp: "2024-03-09T16:00:10.000Z",
    message: {
      model: "claude-opus-4-5",
      usage: {
        input_tokens: 20,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "text", text: "sub" }],
    },
  });

  test("Claude parser surfaces mid-file corruption in a subagent transcript (FEA-2905)", async () => {
    const dir = makeTempDir("claude-pq-subagent-corrupt-");
    const sessionId = "claude-pq-subagent-corrupt";
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    // Clean main transcript: no corruption, no truncated final line.
    writeFileSync(filePath, `${userLine}\n${assistantLine}\n`, "utf8");

    // A subagent sidecar with a malformed line BEFORE its final line: real
    // corruption that silently drops that turn's folded token usage. Without
    // FEA-2905 the parent still reports a clean parse (malformedLines: 0).
    const subagentsDir = path.join(dir, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      path.join(subagentsDir, "agent-corrupt.jsonl"),
      `${subAssistantLine}\n${truncatedLine}\n${subAssistantLine}\n`,
      "utf8"
    );

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // Main (2) + subagent (3) lines are aggregated; the subagent's malformed
    // line is mid-file (its final line parsed cleanly), so it reads as genuine
    // corruption rather than a benign truncation.
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 5,
      malformedLines: 1,
      truncatedFinalLine: false,
    });
    const midFileMalformed =
      (parsed.parseQuality?.malformedLines ?? 0) -
      (parsed.parseQuality?.truncatedFinalLine ? 1 : 0);
    assert.equal(midFileMalformed, 1);
  });

  test("Claude parser treats a truncated subagent final line as benign, not corruption (FEA-2905)", async () => {
    const dir = makeTempDir("claude-pq-subagent-truncated-");
    const sessionId = "claude-pq-subagent-truncated";
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    // Clean main transcript.
    writeFileSync(filePath, `${userLine}\n${assistantLine}\n`, "utf8");

    // A subagent sidecar whose only malformed line is its FINAL line — the
    // benign shape of a still-running/interrupted subagent write. It must be
    // discounted the same way the main transcript's truncated final line is, so
    // it does not read as mid-file corruption for the parent session.
    const subagentsDir = path.join(dir, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      path.join(subagentsDir, "agent-live.jsonl"),
      `${subAssistantLine}\n${truncatedLine}\n`,
      "utf8"
    );

    const parsed = await parseClaudeFile(filePath);
    assert.ok(parsed, "expected a parsed Claude transcript");
    // The subagent's valid turn still folds its tokens into the parent.
    assert.equal(
      parsed.tokensByModel["claude-opus-4-5"]?.input,
      // main assistant (100) + subagent assistant (20)
      120
    );
    // Main (2) + subagent (2) lines counted, but the subagent's benign trailing
    // truncation is discounted → no mid-file corruption reported.
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 4,
      malformedLines: 0,
      truncatedFinalLine: false,
    });
    const midFileMalformed =
      (parsed.parseQuality?.malformedLines ?? 0) -
      (parsed.parseQuality?.truncatedFinalLine ? 1 : 0);
    assert.equal(midFileMalformed, 0);
  });
});

// FEA-2907: the Codex rollout parser silently dropped malformed JSONL lines and
// never emitted a parse-quality signal, so a truncated/corrupt rollout lost a
// turn's token usage with zero diagnostic. These mirror the Claude parity tests
// above (FEA-2771).
describe("Codex parser parse quality (FEA-2907)", () => {
  // A minimal, valid Codex rollout: one user turn + one assistant turn whose
  // token usage lands in tokensByModel.
  const codexLines: unknown[] = [
    {
      timestamp: "2026-05-18T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: CODEX_UUID,
        cwd: "/workspace/project",
        cli_version: "0.40.0",
      },
    },
    {
      timestamp: "2026-05-18T10:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5-codex", cwd: "/workspace/project" },
    },
    {
      timestamp: "2026-05-18T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "fix the bug" },
    },
    {
      timestamp: "2026-05-18T10:00:05.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "on it" }],
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
        turn_context: { model: "gpt-5-codex" },
      },
    },
  ];
  const validText = codexLines.map((line) => JSON.stringify(line)).join("\n");
  // A truncated mid-write line: valid JSON prefix, no closing brace.
  const truncatedLine =
    '{"timestamp":"2026-05-18T10:00:07.000Z","type":"event_msg';

  test("Codex parser reports a clean parse quality when all lines are valid", async () => {
    const dir = makeTempDir("codex-pq-clean-");
    const filePath = path.join(
      dir,
      `rollout-2026-05-18T10-00-00-${CODEX_UUID}.jsonl`
    );
    writeFileSync(filePath, `${validText}\n`, "utf8");

    const parsed = await parseRolloutFile(filePath, {
      mergeWorkflowJournalTokens: false,
    });
    assert.ok(parsed, "expected a parsed Codex rollout");
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 5,
      malformedLines: 0,
      truncatedFinalLine: false,
    });
  });

  test("Codex parser flags a truncated final line as benign in parse quality (FEA-2907)", async () => {
    const dir = makeTempDir("codex-pq-truncated-");
    const filePath = path.join(
      dir,
      `rollout-2026-05-18T10-00-00-${CODEX_UUID}.jsonl`
    );
    // Valid turns followed by a truncated trailing line (live/interrupted write).
    writeFileSync(filePath, `${validText}\n${truncatedLine}\n`, "utf8");

    const parsed = await parseRolloutFile(filePath, {
      mergeWorkflowJournalTokens: false,
    });
    assert.ok(parsed, "expected a parsed Codex rollout");
    // Prior turns still parse; the trailing drop is flagged but expected.
    assert.deepEqual(parsed.tokensByModel["gpt-5-codex"], {
      input: 800,
      output: 350,
      cacheRead: 400,
      cacheWrite: 0,
    });
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 6,
      malformedLines: 1,
      truncatedFinalLine: true,
    });
  });

  test("Codex parser flags mid-file corruption in parse quality (FEA-2907)", async () => {
    const dir = makeTempDir("codex-pq-corrupt-");
    const filePath = path.join(
      dir,
      `rollout-2026-05-18T10-00-00-${CODEX_UUID}.jsonl`
    );
    // A malformed line BEFORE the final line: real corruption, not truncation.
    writeFileSync(
      filePath,
      `${validText}\n${truncatedLine}\n${validText}\n`,
      "utf8"
    );

    const parsed = await parseRolloutFile(filePath, {
      mergeWorkflowJournalTokens: false,
    });
    assert.ok(parsed, "expected a parsed Codex rollout");
    // 5 valid + 1 malformed + 5 valid = 11 non-empty lines attempted.
    assert.equal(parsed.parseQuality?.totalLines, 11);
    assert.equal(parsed.parseQuality?.malformedLines, 1);
    // Final line parsed cleanly → the drop is mid-file, not a truncation.
    assert.equal(parsed.parseQuality?.truncatedFinalLine, false);
    // Consumers derive mid-file corruption = malformedLines - (truncated ? 1 : 0).
    const midFileMalformed =
      (parsed.parseQuality?.malformedLines ?? 0) -
      (parsed.parseQuality?.truncatedFinalLine ? 1 : 0);
    assert.equal(midFileMalformed, 1);
  });

  const workflowUsageLine = JSON.stringify({
    type: "usage",
    model: "gpt-5-codex",
    tokens_input: 10,
    tokens_output: 5,
    session_id: "inner-agent-1",
  });

  test("Codex parser folds a corrupt workflow journal's malformed line into parent parse quality (FEA-2979)", async () => {
    const dir = makeTempDir("codex-pq-wf-corrupt-");
    const filePath = path.join(
      dir,
      `rollout-2026-05-18T10-00-00-${CODEX_UUID}.jsonl`
    );
    writeFileSync(filePath, `${validText}\n`, "utf8");
    // Companion inner-agent journal with mid-file corruption: a malformed line
    // BEFORE the final valid line silently drops that inner turn's token usage.
    writeFileSync(
      path.join(dir, "workflow-inner.jsonl"),
      `${workflowUsageLine}\n${truncatedLine}\n${workflowUsageLine}\n`,
      "utf8"
    );

    // Default options → workflow journals ARE scanned and folded.
    const parsed = await parseRolloutFile(filePath);
    assert.ok(parsed, "expected a parsed Codex rollout");
    // 5 clean rollout lines + 3 workflow-journal lines (2 valid, 1 malformed).
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 8,
      malformedLines: 1,
      truncatedFinalLine: false,
    });
    // The valid inner-agent tokens are still folded under the workflow key.
    assert.deepEqual(parsed.tokensByModel["workflow-agent"], {
      input: 20,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("Codex parser discounts a truncated final line in a workflow journal (FEA-2979)", async () => {
    const dir = makeTempDir("codex-pq-wf-truncated-");
    const filePath = path.join(
      dir,
      `rollout-2026-05-18T10-00-00-${CODEX_UUID}.jsonl`
    );
    writeFileSync(filePath, `${validText}\n`, "utf8");
    // Companion journal whose ONLY malformed line is the trailing one — the
    // benign shape of a live/interrupted write, discounted from the fold.
    writeFileSync(
      path.join(dir, "workflow-inner.jsonl"),
      `${workflowUsageLine}\n${truncatedLine}\n`,
      "utf8"
    );

    const parsed = await parseRolloutFile(filePath);
    assert.ok(parsed, "expected a parsed Codex rollout");
    // totalLines counts the truncated line (5 + 2) but malformedLines stays 0:
    // the trailing drop is discounted, and the main rollout is clean.
    assert.deepEqual(parsed.parseQuality, {
      totalLines: 7,
      malformedLines: 0,
      truncatedFinalLine: false,
    });
  });
});
