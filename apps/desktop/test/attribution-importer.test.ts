/**
 * @file attribution-importer.test.ts
 * @description Importer behavior on in-memory SQLite (FEA-1459 Fixes 5, 7, 8, 9).
 * Split out of the former fea1459-attribution-accuracy.test.ts (FEA-2235 D2).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openTestDb } from "./agent-db-test-utils.js";
import { makePopulatedSession as makeSession } from "./normalized-session-test-utils.js";

// ═══════════════════════════════════════════════════════════════════════════
// AREA 4: Importer behavior (Fixes 5, 7, 8, 9) — in-memory SQLite
// ═══════════════════════════════════════════════════════════════════════════

test("Importer: token_events rows created from tokenSeries with timestamps", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-sqlite-"));
  const db = await openTestDb(dir);

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
    const analytics = await db.dashboard.getTokenAnalytics(
      new Date("2026-06-07T12:00:00.000Z")
    );
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
  const db = await openTestDb(dir);

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
    const analytics = await db.dashboard.getTokenAnalytics(
      new Date("2026-06-07T12:00:00.000Z")
    );
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
  const db = await openTestDb(dir);

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
  const db = await openTestDb(dir);

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
  const db = await openTestDb(dir);

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
  const db = await openTestDb(dir);

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

test("Importer: parser subagent tool uses are not duplicated on the main session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-sqlite-"));
  const db = await openTestDb(dir);

  try {
    const subagentToolUse = {
      name: "Read",
      timestamp: "2026-06-07T10:00:35.000Z",
      input: { file_path: "child.ts" },
      subagentId: "child-agent",
    };
    const session = makeSession({
      sessionId: "parser-subagent-tool-dedup-test",
      toolUses: [subagentToolUse],
      subagents: [
        {
          id: "child-agent",
          parentId: null,
          name: "Child agent",
          status: "completed",
          toolUses: [subagentToolUse],
        },
      ],
    });

    await db.importer.importSession(session, "claude");

    const events = await db.events.getBySession(
      "parser-subagent-tool-dedup-test"
    );
    const toolEvents = events.filter(
      (e: { eventType: string }) => e.eventType === "PostToolUse"
    );
    assert.equal(toolEvents.length, 1);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Importer: subagent rows use toolu_* id and resultTimestamp for ended_at", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea1459-sqlite-"));
  const db = await openTestDb(dir);

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
  const db = await openTestDb(dir);

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
