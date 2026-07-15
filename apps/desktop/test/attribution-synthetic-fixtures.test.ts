/**
 * @file attribution-synthetic-fixtures.test.ts
 * @description Synthetic copilot/cursor/opencode smoke fixtures (FEA-1459).
 * Split out of the former fea1459-attribution-accuracy.test.ts (FEA-2235 D2).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parseChatSessionFile } from "../src/main/collectors/copilot/copilot-parser.js";
import { parseTranscriptFile as parseCursorFile } from "../src/main/collectors/cursor/cursor-parser.js";
import { loadSessionsFromDb } from "../src/main/collectors/opencode/opencode-parser.js";

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
