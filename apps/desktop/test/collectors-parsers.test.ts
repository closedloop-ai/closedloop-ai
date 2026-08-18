/**
 * @file collectors-parsers.test.ts
 * @description Validates the first-party harness parsers (FEA-1503) against
 * synthetic transcripts in the documented on-disk formats. Fixtures are carried
 * over from the prior vendor-parser tests so the CommonJS→TypeScript port is
 * proven not to drift.
 *
 * Covers four harnesses — Copilot, OpenCode, Codex, and Cursor. The CLAUDE
 * parser's suites were carved out of this file, into the sibling
 * `test/claude-*.test.ts` files, so its contract is readable from the file tree
 * rather than buried in what was then a five-harness suite. They are siblings,
 * not a subdirectory: `scripts/run-node-tests.mjs` discovers suites with a flat,
 * non-recursive `readdirSync` over `test/`, so a suite in a subdirectory would
 * never run in CI.
 */
import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import { parseCursorTranscript } from "@repo/lib/harness/cursor/parse-cursor";
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
  CODEX_CHILD_UUID,
  CODEX_DUPLICATE_UUID,
  CODEX_FORK_UUID,
  CODEX_GRANDCHILD_UUID,
  CODEX_MISSING_PARENT_UUID,
  CODEX_PARENT_UUID,
  CODEX_UUID,
  codexMcpToolCallBegin,
  codexMcpToolCallEnd,
  codexSessionMeta,
  codexSubagentMeta,
  codexTokenCount,
  codexTurn,
  minimalCodexRollout,
  writeCodexCollectorRollout,
} from "./codex-rollout-fixture.js";
import {
  cleanupTempDirs,
  makeTempDir,
  writeJsonl,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

function writeRollout(name: string, lines: unknown[]): string {
  return writeJsonl(makeTempDir("codex-rollout-"), name, lines);
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

  // FEA-3728: an OpenAI-backed Copilot payload reports `reasoning_output_tokens`,
  // which is a SUBSET of `output_tokens` (proven for OpenAI/Codex in FEA-3126 /
  // FEA-3527) — the output figure already includes it. The parser must NOT fold
  // it into output again; doing so double-counts reasoning and inflates cost.
  test("Copilot Chat parser does not fold reasoning_output_tokens into output (OpenAI subset)", () => {
    const dir = makeTempDir("copilot-reasoning-subset-");
    const filePath = path.join(dir, "session.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        sessionId: "copilot-reasoning-1",
        creationDate: 1_710_000_000_000,
        lastMessageDate: 1_710_000_060_000,
        model: "gpt-5.5",
        usage: {
          input_tokens: 600,
          output_tokens: 220,
          reasoning_output_tokens: 80,
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
    // output stays 220 — reasoning_output_tokens is already inside it, not added.
    assert.equal(parsed.tokensByModel["gpt-5.5"].output, 220);
    assert.notEqual(parsed.tokensByModel["gpt-5.5"].output, 220 + 80);
  });

  // FEA-3728 (contrast): `reasoning_tokens` is reasoning counted SEPARATELY from
  // output, so it stays additive — only the OpenAI `reasoning_output_tokens`
  // subset field is excluded from the fold.
  test("Copilot Chat parser still folds additive reasoning_tokens into output", () => {
    const dir = makeTempDir("copilot-reasoning-additive-");
    const filePath = path.join(dir, "session.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        sessionId: "copilot-reasoning-2",
        creationDate: 1_710_000_000_000,
        lastMessageDate: 1_710_000_060_000,
        model: "gpt-5.5",
        usage: {
          input_tokens: 600,
          output_tokens: 220,
          reasoning_tokens: 80,
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
    // reasoning_tokens is separate reasoning, so it folds into output.
    assert.equal(parsed.tokensByModel["gpt-5.5"].output, 220 + 80);
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
      output: 300,
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

  test("Codex collector folds child compactions into the root and skips replayed timestamps (FEA-3127)", async () => {
    const root = makeTempDir("codex-collector-compactions-");
    const parentCompactionTs = "2026-06-24T10:03:00.000Z";
    const childCompactionTs = "2026-06-24T10:04:00.000Z";
    const compactedPair = (ts: string, echoTs: string) => [
      {
        timestamp: ts,
        type: "compacted",
        payload: { message: "", replacement_history: [] },
      },
      {
        timestamp: echoTs,
        type: "event_msg",
        payload: { type: "context_compacted" },
      },
    ];
    const parentPath = writeCodexCollectorRollout(root, CODEX_PARENT_UUID, [
      ...minimalCodexRollout(CODEX_PARENT_UUID, "2026-06-24T10:00:00.000Z", {
        input: 1000,
        cached: 400,
        output: 100,
      }),
      ...compactedPair(parentCompactionTs, "2026-06-24T10:03:00.100Z"),
    ]);
    // The child records the parent's compaction timestamp (a forked rollout
    // replays its source's history, `compacted` records included) plus one
    // compaction of its own.
    const childPath = writeCodexCollectorRollout(
      root,
      CODEX_CHILD_UUID,
      [
        ...minimalCodexRollout(
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
        ...compactedPair(parentCompactionTs, "2026-06-24T10:03:00.100Z"),
        ...compactedPair(childCompactionTs, "2026-06-24T10:04:00.100Z"),
      ],
      "2026-06-24T10-01-00"
    );
    const collector = createCodexCollector({
      sessionsDir: root,
      archivedDir: path.join(root, "archive"),
      listSources: () => [parentPath, childPath],
    });

    const [parent] = await collector.parse(parentPath);
    assert.deepEqual(parent.compactions, [
      { uuid: null, timestamp: parentCompactionTs },
      { uuid: null, timestamp: childCompactionTs },
    ]);
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

  // FEA-3710 (Parser roadmap 4): the Cursor parser core now lives in the shared,
  // browser-safe `@repo/lib/harness` module. This pins the contract that both
  // entrypoints — the desktop file shell (`parseTranscriptFile`, which streams
  // the file and stamps mtime) and the pure core (`parseCursorTranscript`, which
  // the cloud/browser upload path invokes on in-memory lines) — produce the SAME
  // canonical NormalizedSession for the same fixture, modulo the desktop-only
  // `fileModifiedAt` stamp. A surface-specific semantic fork would diverge here.
  test("Cursor: desktop shell and shared core produce the same canonical session", async () => {
    const records = [
      {
        timestamp: "2024-03-09T16:00:00.000Z",
        type: "session_meta",
        payload: {
          cwd: "/Users/dev/cursor project",
          model: "claude-3-7-sonnet",
          git: { branch: "main" },
        },
      },
      {
        timestamp: "2024-03-09T16:00:05.000Z",
        type: "user_message",
        payload: { message: "Investigate failing test" },
      },
      {
        timestamp: "2024-03-09T16:00:08.000Z",
        type: "tool_call",
        payload: { name: "Bash", arguments: { command: "pnpm test" } },
      },
      {
        timestamp: "2024-03-09T16:00:09.000Z",
        type: "tool_result",
        payload: { output: "1 failing", exit_code: 1 },
      },
      {
        timestamp: "2024-03-09T16:00:11.500Z",
        type: "assistant_message",
        payload: { message: "Found it" },
      },
      {
        timestamp: "2024-03-09T16:00:12.000Z",
        type: "token_count",
        payload: {
          usage: {
            input_tokens: 120,
            output_tokens: 45,
            cache_read_tokens: 900,
            cache_write_tokens: 30,
          },
        },
      },
    ];

    const dir = makeTempDir("cursor-parity-");
    const sessionId = "session-parity";
    const sessionDir = path.join(dir, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const filePath = writeJsonl(sessionDir, `${sessionId}.jsonl`, records);

    // Desktop entrypoint: stream the file, derive sessionId from the path.
    const viaShell = await parseTranscriptFile(filePath);
    assert.ok(viaShell, "expected the desktop shell to parse the transcript");

    // Cloud/browser entrypoint: feed the same lines to the pure core with the
    // same sessionId the desktop path derived.
    const viaCore = await parseCursorTranscript(
      records.map((record) => JSON.stringify(record)),
      { sessionId }
    );
    assert.ok(viaCore, "expected the shared core to parse the transcript");

    // The only permitted divergence is the desktop-only source mtime, which the
    // cloud renderer has no file to stamp. Everything else must be identical.
    const { fileModifiedAt: _shellMtime, ...shellCanonical } = viaShell;
    const { fileModifiedAt: _coreMtime, ...coreCanonical } = viaCore;
    assert.deepEqual(shellCanonical, coreCanonical);
  });
});

// FEA-2907: the Codex rollout parser silently dropped malformed JSONL lines and
// never emitted a parse-quality signal, so a truncated/corrupt rollout lost a
// turn's token usage with zero diagnostic. These mirror the Claude parity tests
// in `test/claude/parse-quality.test.ts` (FEA-2771).
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
      output: 300,
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
