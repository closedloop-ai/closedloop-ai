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
import { OpencodeDefaultModel } from "@repo/lib/harness/synthetic-model-keys";
import {
  loadOpencodeSessionsFromDb,
  loadSessionsFromDb,
} from "../src/main/collectors/opencode/opencode-parser.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { estimateTokenCost } from "../src/shared/token-cost.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";
import {
  UNPARSEABLE_TIMESTAMP,
  writeOpencodeDb as writeOpencodeStore,
} from "./opencode-store-fixture.js";

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
 * FEA-4183 (sessions missing cost data): a message that carries real token
 * counts but NO resolved model — session model null, no agent, no per-message
 * model — used to be dropped by `pushMessageTokenSeries` (it required a truthy
 * model), so the session recorded zero tokens and no cost could ever derive.
 * The tokens must instead be captured under the synthetic `opencode-default`
 * key (matching the step-token and session-rollup fallbacks), which the cost
 * engine's unknown-model fallback (FEA-3546) prices at a non-zero figure.
 */
test("OpenCode message tokens with no model are captured under opencode-default so cost derives", () => {
  const dir = makeTempDir("opencode-nomodel-cost-");
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(OPENCODE_SCHEMA_DDL);
  // Session-level columns carry NO usage and NO model/agent, so the ONLY usage
  // source is the message-level `data.tokens` on an unattributed assistant turn.
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
    "",
    "",
    "",
    1_710_000_000_000,
    1_710_000_060_000,
    0,
    0,
    0,
    0,
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
  // Assistant message WITH message-level tokens but NO `model`/`modelID`.
  insertMessage.run(
    "msg_2",
    "ses_1",
    1_710_000_030_000,
    1_710_000_030_000,
    JSON.stringify({
      role: "assistant",
      time: { created: 1_710_000_030_000 },
      tokens: { input: 100_000, output: 5000, cacheRead: 0, cacheWrite: 0 },
    })
  );
  db.close();

  const parsed = loadOne(dbPath);
  // The message-level tokens are captured in the series (not dropped) under the
  // synthetic default key — this is the series that flows into token_events and
  // per-event cost.
  assert.equal(parsed.tokenSeries.length, 1);
  assert.equal(parsed.tokenSeries[0].model, OpencodeDefaultModel);
  assert.equal(parsed.tokenSeries[0].input, 100_000);
  assert.equal(parsed.tokenSeries[0].output, 5000);

  // The real fix: `tokensByModel` — the SOLE source `importPhaseTokenUsage`
  // writes `token_usage` from, and thus the only source the authoritative
  // `sessions.cost_usd_estimated` rollup derives from — is populated from the
  // series under `opencode-default` even though the session-row aggregate
  // columns are all zero. Before FEA-4183 this was empty, so the import wrote no
  // `token_usage` row and the session cost stayed null. The message-level tokens
  // sum verbatim (input fresh, cache separate) and carry the `inferred` flag
  // because the key is a synthetic fallback, not a store-read model id. (The
  // import-rollup end-to-end assertion — parse → importSession → non-null
  // session cost — lives in model-pricing-sqlite.test.ts.)
  assert.deepEqual(parsed.tokensByModel, {
    [OpencodeDefaultModel]: {
      input: 100_000,
      output: 5000,
      cacheRead: 0,
      cacheWrite: 0,
      inferred: true,
    },
  });

  // And that synthetic `*-default` key is priceable via the unknown-model
  // fallback, so the session yields a positive cost rather than $0/null.
  const estimate = estimateTokenCost({
    model: OpencodeDefaultModel,
    inputTokens: parsed.tokensByModel[OpencodeDefaultModel].input,
    outputTokens: parsed.tokensByModel[OpencodeDefaultModel].output,
    cacheReadTokens: parsed.tokensByModel[OpencodeDefaultModel].cacheRead,
    cacheWriteTokens: parsed.tokensByModel[OpencodeDefaultModel].cacheWrite,
  });
  assert.ok(estimate, "expected opencode-default to be priceable");
  assert.ok(estimate.costUsd > 0, "expected a positive derived cost");
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

/**
 * FEA-3728: an OpenAI-backed OpenCode message reports `reasoning_output_tokens`
 * in its `data.tokens` payload. That field is a SUBSET of `output_tokens`
 * (proven for OpenAI/Codex in FEA-3126 / FEA-3527) — the output figure already
 * includes it. `extractTokenCounts` must NOT fold it into output again; doing so
 * double-counts reasoning into every token_events row and inflates cost.
 */
test("OpenCode parser does not fold reasoning_output_tokens into output (OpenAI subset)", () => {
  const dir = makeTempDir("opencode-reasoning-subset-");
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
    0,
    0,
    0,
    0,
    0
  );
  const insertMessage = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  );
  // Assistant message whose OpenAI-shape usage carries reasoning_output_tokens
  // (a subset of output_tokens) alongside output_tokens.
  insertMessage.run(
    "msg_2",
    "ses_1",
    1_710_000_030_000,
    1_710_000_030_000,
    JSON.stringify({
      role: "assistant",
      time: { created: 1_710_000_030_000 },
      tokens: {
        input_tokens: 100,
        output_tokens: 40,
        reasoning_output_tokens: 15,
      },
    })
  );
  db.close();

  const parsed = loadOne(dbPath);
  assert.equal(parsed.tokenSeries.length, 1);
  // output stays 40 — reasoning_output_tokens is already inside it, not added.
  assert.equal(parsed.tokenSeries[0].output, 40);
  assert.notEqual(parsed.tokenSeries[0].output, 40 + 15);
});

/**
 * FEA-3728 (contrast): `reasoning_tokens` is reasoning counted SEPARATELY from
 * output, so it stays additive — only the OpenAI `reasoning_output_tokens`
 * subset field is excluded from the fold.
 */
test("OpenCode parser still folds additive reasoning_tokens into output", () => {
  const dir = makeTempDir("opencode-reasoning-additive-");
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
    0,
    0,
    0,
    0,
    0
  );
  const insertMessage = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  );
  insertMessage.run(
    "msg_2",
    "ses_1",
    1_710_000_030_000,
    1_710_000_030_000,
    JSON.stringify({
      role: "assistant",
      time: { created: 1_710_000_030_000 },
      tokens: {
        input_tokens: 100,
        output_tokens: 40,
        reasoning_tokens: 15,
      },
    })
  );
  db.close();

  const parsed = loadOne(dbPath);
  assert.equal(parsed.tokenSeries.length, 1);
  // reasoning_tokens is separate reasoning, so it folds into output.
  assert.equal(parsed.tokenSeries[0].output, 40 + 15);
});

/** Insert a zero-aggregate session row (id `ses_1`) with a nested-cache schema. */
function insertZeroAggregateSession(db: DatabaseSync): void {
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
    JSON.stringify({ id: "big-pickle", providerID: "opencode" }),
    "",
    1_710_000_000_000,
    1_710_000_060_000,
    0,
    0,
    0,
    0,
    0
  );
}

/**
 * ISS-4380: real OpenCode message `data.tokens` nests cache counts under a
 * `cache: { read, write }` object, NOT the flat `cache_read`/`cacheRead` aliases.
 * The parser previously read only the flat aliases, so every message-level token
 * entry recorded `cacheRead`/`cacheWrite` = 0 — dropping all cache tokens from
 * `tokenSeries` (→ per-event cost). The nested shape must now be captured.
 */
test("OpenCode parser reads nested tokens.cache.read/write at the message level (ISS-4380)", () => {
  const dir = makeTempDir("opencode-nested-cache-msg-");
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  insertZeroAggregateSession(db);
  // Real assistant-message token shape: input/output flat, cache NESTED.
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  ).run(
    "msg_2",
    "ses_1",
    1_710_000_030_000,
    1_710_000_030_000,
    JSON.stringify({
      role: "assistant",
      modelID: "big-pickle",
      time: { created: 1_710_000_030_000 },
      tokens: {
        total: 30_252,
        input: 28_352,
        output: 27,
        reasoning: 81,
        cache: { write: 512, read: 1792 },
      },
    })
  );
  db.close();

  const parsed = loadOne(dbPath);
  assert.equal(parsed.tokenSeries.length, 1);
  const [record] = parsed.tokenSeries;
  // Flat `input` stays fresh/uncached; reasoning folds into output.
  assert.equal(record.input, 28_352);
  assert.equal(record.output, 27 + 81);
  // The nested cache legs are now captured (were 0 before ISS-4380).
  assert.equal(record.cacheRead, 1792);
  assert.equal(record.cacheWrite, 512);
});

/**
 * ISS-4380: the nested `cache: { read, write }` shape also appears on
 * `step-finish` part `tokens`. A message with NO message-level tokens relies on
 * its step-finish part for usage; its nested cache must be captured too.
 */
test("OpenCode parser reads nested tokens.cache.read/write on step-finish parts (ISS-4380)", () => {
  const dir = makeTempDir("opencode-nested-cache-step-");
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  insertZeroAggregateSession(db);
  // Assistant message with NO message-level tokens — its step-finish part is the
  // only usage source.
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  ).run(
    "msg_3",
    "ses_1",
    1_710_000_040_000,
    1_710_000_040_000,
    JSON.stringify({
      role: "assistant",
      time: { created: 1_710_000_040_000 },
    })
  );
  // Real step-finish part: tokens flat input/output, cache NESTED, message id in
  // the `message_id` column only (matches the real store).
  db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "part_3",
    "msg_3",
    "ses_1",
    1_710_000_041_000,
    1_710_000_041_000,
    JSON.stringify({
      type: "step-finish",
      reason: "tool-calls",
      time: { created: 1_710_000_041_000 },
      tokens: {
        total: 24_868,
        input: 24_742,
        output: 103,
        reasoning: 23,
        cache: { write: 64, read: 4096 },
      },
    })
  );
  db.close();

  const parsed = loadOne(dbPath);
  assert.equal(parsed.tokenSeries.length, 1);
  const [record] = parsed.tokenSeries;
  assert.equal(record.input, 24_742);
  assert.equal(record.output, 103 + 23);
  assert.equal(record.cacheRead, 4096);
  assert.equal(record.cacheWrite, 64);
});

/**
 * ISS-4380 (flat-first precedence): a version-skewed payload can carry BOTH a
 * flat alias such as `cache_read: 0` AND a nonzero nested `cache.read`. The flat
 * alias is present — an explicit, canonical zero — so it must win; the nested
 * value must NOT override it. (A truthy-only fallback would silently record the
 * nested count, violating the stated flat-first precedence.)
 */
test("OpenCode parser keeps an explicit flat cache zero over a nested cache value (ISS-4380)", () => {
  const dir = makeTempDir("opencode-flat-zero-over-nested-");
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  insertZeroAggregateSession(db);
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  ).run(
    "msg_4",
    "ses_1",
    1_710_000_050_000,
    1_710_000_050_000,
    JSON.stringify({
      role: "assistant",
      modelID: "big-pickle",
      time: { created: 1_710_000_050_000 },
      tokens: {
        input: 100,
        output: 10,
        // Flat aliases are explicitly present as 0; nested cache is nonzero.
        cache_read: 0,
        cache_write: 0,
        cache: { read: 999, write: 888 },
      },
    })
  );
  db.close();

  const parsed = loadOne(dbPath);
  assert.equal(parsed.tokenSeries.length, 1);
  const [record] = parsed.tokenSeries;
  assert.equal(record.input, 100);
  assert.equal(record.output, 10);
  // The present flat zero wins; the nested value does not override it.
  assert.equal(record.cacheRead, 0);
  assert.equal(record.cacheWrite, 0);
});

/** Insert a session row with the given id and healthy zero-aggregate columns. */
function insertNamedZeroAggregateSession(
  db: DatabaseSync,
  sessionId: string,
  slug: string
): void {
  db.prepare(`
    INSERT INTO session (
      id, slug, directory, title, version, agent, model, permission,
      time_created, time_updated, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    slug,
    "/workspace/my-project",
    "Repo overview",
    "1.15.5",
    "build",
    JSON.stringify({ id: "big-pickle", providerID: "opencode" }),
    "",
    1_710_000_000_000,
    1_710_000_060_000,
    0,
    0,
    0,
    0,
    0
  );
}

/**
 * ISS-4380 (batch isolation): OpenCode parses the ENTIRE `opencode.db` in one
 * load, so a throw while parsing one session — e.g. an `InvalidTokenCountError`
 * from a corrupt/version-skewed token count in one message — must NOT suppress
 * every valid session in the store. The bad session is dropped; its healthy
 * sibling still parses. (Reading the nested cache shape now routes more values
 * through the throwing strict reader, widening this surface — wongk review.)
 */
test("OpenCode parser isolates a malformed session and preserves its healthy sibling (ISS-4380)", () => {
  const dir = makeTempDir("opencode-batch-isolation-");
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(OPENCODE_SCHEMA_DDL);
  insertNamedZeroAggregateSession(db, "ses_good", "quiet-orchid");
  insertNamedZeroAggregateSession(db, "ses_bad", "loud-tulip");
  // Healthy sibling: valid nested cache tokens.
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  ).run(
    "msg_good",
    "ses_good",
    1_710_000_030_000,
    1_710_000_030_000,
    JSON.stringify({
      role: "assistant",
      modelID: "big-pickle",
      time: { created: 1_710_000_030_000 },
      tokens: { input: 200, output: 20, cache: { read: 1024, write: 256 } },
    })
  );
  // Malformed session: a fractional cache count the strict reader rejects with
  // InvalidTokenCountError (would abort the whole batch without isolation).
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  ).run(
    "msg_bad",
    "ses_bad",
    1_710_000_040_000,
    1_710_000_040_000,
    JSON.stringify({
      role: "assistant",
      modelID: "big-pickle",
      time: { created: 1_710_000_040_000 },
      tokens: { input: 10, output: 1, cache: { read: 1.5, write: 0 } },
    })
  );
  db.close();

  const sessions = loadSessionsFromDb(dbPath);
  // The malformed session is dropped; the healthy one survives with real tokens.
  assert.equal(sessions.length, 1);
  const [survivor] = sessions;
  assert.equal(survivor.slug, "quiet-orchid");
  assert.equal(survivor.tokenSeries[0].cacheRead, 1024);
  assert.equal(survivor.tokenSeries[0].cacheWrite, 256);
});

// ---------------------------------------------------------------------------
// ISS-5302 — the loader's own arms, and the two DOCUMENTED ways a session row
// legitimately produces no session.
//
// Neither is a DROP: `parseSessionRow` returns null rather than throwing, so the
// row never reaches `ctx.dropped`. Keeping that distinction asserted matters
// because `droppedSessions` is what ISS-5238 added so a caller that prunes,
// deletes, or re-roots can tell a short corpus from a complete one — filing an
// ordinarily-empty session there would make every one of them look like data the
// import failed to read.
// ---------------------------------------------------------------------------

test("ISS-5302: an absent or unset store path loads as empty, silently — absence is not a failure", () => {
  const dir = makeTempDir("opencode-absent-store-");
  const lines: string[] = [];
  // The ordinary state of a host with no OpenCode installed: the path resolves
  // but nothing is there. That loads empty instead of throwing — the contrast is
  // ISS-5161's store that IS present and unreadable, which REFUSES the load (see
  // opencode-collector-fingerprint.test.ts), because there an empty result would
  // be a claim the reader cannot make.
  assert.deepEqual(
    loadOpencodeSessionsFromDb(path.join(dir, "opencode.db"), {
      log: (message) => lines.push(message),
    }),
    { sessions: [], droppedSessions: [] }
  );
  // Nor is it reported: a host without the harness must not emit a monitored
  // import-failure line on every tick.
  assert.deepEqual(lines, []);
  // The same exit guards an empty path, before any `DatabaseSync` is opened.
  assert.deepEqual(loadOpencodeSessionsFromDb(""), {
    sessions: [],
    droppedSessions: [],
  });
});

test("ISS-5302: a session with no message rows yields no session and is not reported as a drop", () => {
  const dir = makeTempDir("opencode-no-messages-");
  const dbPath = writeOpencodeStore(dir, [
    { id: "ses_empty", withoutMessages: true },
    { id: "ses_full" },
  ]);
  const lines: string[] = [];
  const load = loadOpencodeSessionsFromDb(dbPath, {
    log: (message) => lines.push(message),
  });

  assert.deepEqual(
    load.sessions.map((session) => session.sessionId),
    ["opencode-ses_full"]
  );
  assert.deepEqual(load.droppedSessions, []);
  assert.deepEqual(lines, []);
});

test("ISS-5302: a session whose every timestamp is unreadable yields no session, and its sibling survives", () => {
  const dir = makeTempDir("opencode-no-timestamp-");
  // Only `ses_notime` carries the refused timestamps — on the session row, on
  // both message rows' columns, and inside their `data.time.created` — so there
  // is nothing anywhere for `noteTimestamp` to accept. `ses_full` is the same
  // fixture with the ordinary epoch pair, which is what makes the empty result
  // attributable to the timestamps rather than to the fixture.
  const dbPath = writeOpencodeStore(dir, [
    {
      id: "ses_notime",
      timeCreated: UNPARSEABLE_TIMESTAMP,
      timeUpdated: UNPARSEABLE_TIMESTAMP,
    },
    { id: "ses_full" },
  ]);
  const lines: string[] = [];
  const load = loadOpencodeSessionsFromDb(dbPath, {
    log: (message) => lines.push(message),
  });

  // The `NormalizedSession` contract every harness parser shares is "`startedAt`
  // falsy ⇒ the parser returns null (caller skips)". With nothing surviving
  // `noteTimestamp` there is no honest instant to emit, so the session is
  // omitted rather than published on an invented one — which would file its
  // whole history under the wrong day bucket and reconcile against nothing.
  assert.deepEqual(
    load.sessions.map((session) => session.sessionId),
    ["opencode-ses_full"]
  );
  assert.deepEqual(load.droppedSessions, []);
  assert.deepEqual(lines, []);
});
