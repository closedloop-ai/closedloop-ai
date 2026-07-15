/**
 * @file opencode-parser.test.ts
 * @description Canonical-token-shape coverage for the OpenCode parser (FEA-2235
 * coverage gap): OpenCode was the only harness without an explicit "fresh token
 * shape (input excludes cache)" test. Builds a minimal `opencode.db` fixture and
 * asserts the session→tokensByModel mapping keeps `input` cache-exclusive, folds
 * reasoning into `output`, and falls back model→agent for the attribution key.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { loadSessionsFromDb } from "../src/main/collectors/opencode/opencode-parser.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

type SessionTokens = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

/** The three-table `opencode.db` schema shared by every fixture below. */
const OPENCODE_SCHEMA_DDL = `
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
`;

/**
 * Write a one-session `opencode.db` with the given token columns + model/agent,
 * plus a user and assistant message so the session parses. Returns the db path.
 */
function writeOpencodeDb(
  dir: string,
  opts: { model: string | null; agent: string; tokens: SessionTokens }
): string {
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(OPENCODE_SCHEMA_DDL);
  const modelCol =
    opts.model === null
      ? ""
      : JSON.stringify({ id: opts.model, providerID: "opencode" });
  db.prepare(`
    INSERT INTO session (
      id, slug, directory, title, version, agent, model, permission,
      time_created, time_updated, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "ses_1",
    "quiet-orchid",
    "/workspace/my-project",
    "Repo overview",
    "1.15.5",
    opts.agent,
    modelCol,
    "",
    1_710_000_000_000,
    1_710_000_060_000,
    opts.tokens.input,
    opts.tokens.output,
    opts.tokens.reasoning,
    opts.tokens.cacheRead,
    opts.tokens.cacheWrite
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
      path: { cwd: "/workspace/my-project", root: "/workspace/my-project" },
      time: { created: 1_710_000_030_000 },
    })
  );
  db.close();
  return dbPath;
}

function loadOne(dbPath: string): NormalizedSession {
  const sessions = loadSessionsFromDb(dbPath);
  if (sessions.length !== 1) {
    throw new Error(
      `expected exactly one parsed session, got ${sessions.length}`
    );
  }
  return sessions[0];
}

test("OpenCode parser emits the canonical fresh token shape (input excludes cache)", () => {
  const dir = makeTempDir("opencode-tokens-");
  const dbPath = writeOpencodeDb(dir, {
    model: "oc-model",
    agent: "build",
    tokens: {
      input: 100,
      output: 20,
      reasoning: 5,
      cacheRead: 40,
      cacheWrite: 7,
    },
  });
  const parsed = loadOne(dbPath);
  // input stays uncached; reasoning folds into output; cache stays separate.
  assert.deepEqual(parsed.tokensByModel["oc-model"], {
    input: 100,
    output: 25,
    cacheRead: 40,
    cacheWrite: 7,
  });
  // Explicit fresh-shape guard: input is NOT the inclusive prompt total.
  assert.notEqual(parsed.tokensByModel["oc-model"].input, 100 + 40 + 7);
});

test("OpenCode token attribution falls back to the agent name when no model id", () => {
  const dir = makeTempDir("opencode-fallback-");
  const dbPath = writeOpencodeDb(dir, {
    model: null,
    agent: "build",
    tokens: { input: 10, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const parsed = loadOne(dbPath);
  assert.deepEqual(Object.keys(parsed.tokensByModel), ["build"]);
  assert.equal(parsed.tokensByModel.build.input, 10);
  assert.equal(parsed.tokensByModel.build.output, 4);
});

/**
 * FEA-2958: OpenCode reports a message's usage twice — at the message level
 * (data.tokens) and again on that message's step-finish part. Both used to flow
 * into tokenSeries → token_events, inflating the Dashboard cost SUM. The parser
 * now drops a step-finish token push whose owning message already contributed a
 * message-level entry, while still keeping step-finish tokens for messages that
 * carry no message-level usage.
 */
test("OpenCode tokenSeries de-dupes step-finish usage against message-level tokens", () => {
  const dir = makeTempDir("opencode-token-dedup-");
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(OPENCODE_SCHEMA_DDL);
  db.prepare(`
    INSERT INTO session (
      id, slug, directory, title, version, agent, model, permission,
      time_created, time_updated, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "ses_1",
    "quiet-orchid",
    "/workspace/my-project",
    "Repo overview",
    "1.15.5",
    "build",
    JSON.stringify({ id: "oc-model", providerID: "opencode" }),
    "",
    1_710_000_000_000,
    1_710_000_060_000,
    150,
    30,
    0,
    40,
    0
  );
  const insertMessage = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  );
  insertMessage.run(
    "msg_1",
    "ses_1",
    1_710_000_000_000,
    1_710_000_000_000,
    JSON.stringify({ role: "user", time: { created: 1_710_000_000_000 } })
  );
  // Assistant message WITH message-level tokens: its data.tokens is the
  // cumulative per-message total (input 100 = the 60 + 40 of its two steps). Both
  // of its step-finish parts repeat that usage and must be de-duped, so multi-step
  // messages keep exactly one entry (the total) rather than the total plus steps.
  insertMessage.run(
    "msg_2",
    "ses_1",
    1_710_000_030_000,
    1_710_000_030_000,
    JSON.stringify({
      role: "assistant",
      time: { created: 1_710_000_030_000 },
      tokens: { input: 100, output: 20, cacheRead: 40, cacheWrite: 0 },
    })
  );
  // Assistant message WITHOUT message-level tokens — its step-finish part is the
  // only usage source and must be kept.
  insertMessage.run(
    "msg_3",
    "ses_1",
    1_710_000_040_000,
    1_710_000_040_000,
    JSON.stringify({
      role: "assistant",
      time: { created: 1_710_000_040_000 },
    })
  );
  const insertPart = db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
  );
  // Two step-finish parts for msg_2 (60 + 40 = its 100 message-level total) —
  // both must be dropped since msg_2 already contributed a message-level entry.
  insertPart.run(
    "part_2a",
    "msg_2",
    "ses_1",
    1_710_000_031_000,
    1_710_000_031_000,
    JSON.stringify({
      type: "step-finish",
      messageID: "msg_2",
      time: { created: 1_710_000_031_000 },
      usage: { input: 60, output: 12, cacheRead: 40, cacheWrite: 0 },
    })
  );
  insertPart.run(
    "part_2b",
    "msg_2",
    "ses_1",
    1_710_000_032_000,
    1_710_000_032_000,
    JSON.stringify({
      type: "step-finish",
      messageID: "msg_2",
      time: { created: 1_710_000_032_000 },
      usage: { input: 40, output: 8, cacheRead: 0, cacheWrite: 0 },
    })
  );
  // msg_3 has no message-level tokens, so its lone step-finish is the only usage
  // source and must be kept.
  insertPart.run(
    "part_3",
    "msg_3",
    "ses_1",
    1_710_000_041_000,
    1_710_000_041_000,
    JSON.stringify({
      type: "step-finish",
      messageID: "msg_3",
      time: { created: 1_710_000_041_000 },
      usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 },
    })
  );
  db.close();

  const parsed = loadOne(dbPath);
  // Exactly two entries: msg_2's single message-level push (both its step-finish
  // parts deduped) and msg_3's lone step-finish push. Without the fix there would
  // be four (msg_2's message-level plus its two steps, then msg_3).
  assert.equal(parsed.tokenSeries.length, 2);
  const msg2Entries = parsed.tokenSeries.filter((r) => r.input === 100);
  assert.equal(msg2Entries.length, 1);
  const msg3Entries = parsed.tokenSeries.filter((r) => r.input === 50);
  assert.equal(msg3Entries.length, 1);
  // The per-step usages (60, 40) never leak into the series as separate rows.
  assert.equal(
    parsed.tokenSeries.filter((r) => r.input === 60 || r.input === 40).length,
    0
  );
});

/**
 * FEA-2958 (real-shape regression): real OpenCode `step-finish` parts carry the
 * owning message id only in the part row's `message_id` column — the JSON `data`
 * payload does NOT repeat it. The dedup must key off that column (which mirrors
 * the message row's `id`) rather than a JSON `messageID`/`message_id` field, or
 * the step-finish push double-counts token_events for every real session.
 */
test("OpenCode tokenSeries de-dupes step-finish via the part message_id column", () => {
  const dir = makeTempDir("opencode-token-dedup-column-");
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(OPENCODE_SCHEMA_DDL);
  db.prepare(`
    INSERT INTO session (
      id, slug, directory, title, version, agent, model, permission,
      time_created, time_updated, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "ses_1",
    "quiet-orchid",
    "/workspace/my-project",
    "Repo overview",
    "1.15.5",
    "build",
    JSON.stringify({ id: "oc-model", providerID: "opencode" }),
    "",
    1_710_000_000_000,
    1_710_000_060_000,
    150,
    30,
    0,
    40,
    0
  );
  const insertMessage = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  );
  // Assistant message WITH message-level tokens; its step-finish part repeats the
  // same usage but carries the message id only in the column, not the JSON.
  insertMessage.run(
    "msg_2",
    "ses_1",
    1_710_000_030_000,
    1_710_000_030_000,
    JSON.stringify({
      role: "assistant",
      time: { created: 1_710_000_030_000 },
      tokens: { input: 100, output: 20, cacheRead: 40, cacheWrite: 0 },
    })
  );
  const insertPart = db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
  );
  // Real-shape step-finish: no `messageID` in the JSON `data` — only the
  // `message_id` column links it to msg_2. Must be deduped against msg_2's
  // message-level entry.
  insertPart.run(
    "part_2a",
    "msg_2",
    "ses_1",
    1_710_000_031_000,
    1_710_000_031_000,
    JSON.stringify({
      type: "step-finish",
      time: { created: 1_710_000_031_000 },
      usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 0 },
    })
  );
  db.close();

  const parsed = loadOne(dbPath);
  // Exactly one entry: msg_2's message-level push. The column-linked step-finish
  // is deduped. Without the column-based key it would double to two.
  assert.equal(parsed.tokenSeries.length, 1);
  assert.equal(parsed.tokenSeries.filter((r) => r.input === 100).length, 1);
});
