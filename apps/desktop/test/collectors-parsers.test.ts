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
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { parseRolloutFile } from "../src/main/collectors/codex/codex-parser.js";
import { workspacePathFromUri } from "../src/main/collectors/copilot/copilot-home.js";
import {
  parseChatSessionFile,
  parseCliEventFile,
} from "../src/main/collectors/copilot/copilot-parser.js";
import { parseTranscriptFile } from "../src/main/collectors/cursor/cursor-parser.js";
import { loadSessionsFromDb } from "../src/main/collectors/opencode/opencode-parser.js";

const CODEX_UUID = "11111111-1111-4111-8111-111111111111";

function writeRollout(name: string, lines: unknown[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-rollout-"));
  const filePath = path.join(dir, name);
  writeFileSync(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8"
  );
  return filePath;
}

test("Copilot workspace file URIs decode to filesystem paths", () => {
  assert.equal(
    workspacePathFromUri("file:///Users/dev/my%20project"),
    "/Users/dev/my project"
  );
});

test("Copilot Chat parser supports request-based session files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "copilot-chat-"));
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
  const dir = mkdtempSync(path.join(tmpdir(), "copilot-fresh-"));
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
  const dir = mkdtempSync(path.join(tmpdir(), "copilot-cli-"));
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

test("OpenCode parser loads sessions from opencode.db", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencode-db-"));
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
    { type: "event_msg", payload: { type: "agent_message_delta", delta: "x" } },
    "not json at all",
  ]);
  assert.equal(await parseRolloutFile(emptyPath), null);
});

test("Cursor parser derives turn durations from user/assistant timestamps", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cursor-transcript-"));
  const sessionDir = path.join(dir, "session-123");
  mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, "rollout.jsonl");
  writeFileSync(
    filePath,
    [
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
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
    "utf8"
  );

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
  const dir = mkdtempSync(path.join(tmpdir(), "cursor-fresh-"));
  const sessionDir = path.join(dir, "session-fresh");
  mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, "rollout.jsonl");
  writeFileSync(
    filePath,
    [
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
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
    "utf8"
  );

  const parsed = await parseTranscriptFile(filePath);
  assert.ok(parsed, "expected a parsed Cursor transcript");
  assert.deepEqual(parsed.tokensByModel["gpt-5.5"], {
    input: 600,
    output: 220,
    cacheRead: 2000,
    cacheWrite: 300,
  });
});

test("Claude parser extracts session metadata, tokens, tools, and thinking", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-proj-"));
  const filePath = path.join(dir, "claude-sess-1.jsonl");
  writeFileSync(
    filePath,
    [
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
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
    "utf8"
  );

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

test("Claude parser returns null for a transcript with no timestamps", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-empty-"));
  const filePath = path.join(dir, "empty.jsonl");
  writeFileSync(filePath, `${JSON.stringify({ type: "summary" })}\n`, "utf8");
  assert.equal(await parseClaudeFile(filePath), null);
});

test("Claude parser ignores symlinked subagent sidecars outside the session directory", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-sidecar-"));
  const outsideDir = mkdtempSync(path.join(tmpdir(), "claude-sidecar-out-"));
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
