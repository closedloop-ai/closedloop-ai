/**
 * @file attribution-pr1511-fixes.test.ts
 * @description PR #1511 review fixes: resumed bursts, overwrite semantics (FEA-1459).
 * Split out of the former fea1459-attribution-accuracy.test.ts (FEA-2235 D2).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { parseRolloutFile } from "../src/main/collectors/codex/codex-parser.js";
import { InvalidTokenCountError } from "../src/main/token-counts.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  CODEX_UUID,
  emptyAttributionCache,
  LARGE_CACHE_READ_TOKENS,
  writeRollout,
} from "./attribution-test-helpers.js";
import {
  makePopulatedSession as makeSession,
  writeClaudeTranscript,
} from "./normalized-session-test-utils.js";

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
  const db = await openTestDb(dir);

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
  const db = await openTestDb(dir, {
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
  const db = await openTestDb(dir);

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
  const db = await openTestDb(dir);

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
  const db = await openTestDb(dir);

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

    // FEA-2027: with per-record isolation each import group commits separately,
    // so an unsafe token counter is detected up front and the WHOLE session is
    // skipped (writing nothing) rather than marking the import failed. The
    // "never persist a corrupt token row" guarantee holds by skipping before any
    // group commits.
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
  const db = await openTestDb(dir);

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
  const db = await openTestDb(dir);

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
  const db = await openTestDb(dir);

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

  // Injectable transcript extracts, switched per hook call.
  let currentRecords: Array<{
    timestamp: string;
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }> = [];
  const db = await openTestDb(dir, {
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
