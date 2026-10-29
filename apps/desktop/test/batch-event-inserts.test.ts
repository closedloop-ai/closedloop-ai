// perf/desktop-batch-event-inserts: the import path now writes per-event rows
// and token_events rows via chunked multi-row INSERTs instead of one INSERT per
// row. These tests pin the behavior-preserving contract: importing a session
// with MANY events writes ALL of them correctly, the chunking is exercised
// (event count far exceeds one chunk), and a re-import is idempotent (no
// duplicate rows) thanks to the preserved ON CONFLICT (id) DO NOTHING semantics
// and the token_events delete+reinsert.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  LARGE_SESSION_EVENT_CATEGORIES,
  makeLargeNormalizedSession,
} from "./support/large-normalized-session.js";

test("batch inserts: large session writes ALL events and token_events, idempotently", async () => {
  const perCategory = 1000;
  const dir = await mkdtemp(path.join(os.tmpdir(), "batch-event-inserts-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const session = makeLargeNormalizedSession(perCategory);
    const first = await db.importer.importSession(session, "claude");
    assert.equal(first.skipped, false, "first import should not be skipped");

    // Each batched event category contributes `perCategory` rows.
    const expectedEvents = perCategory * LARGE_SESSION_EVENT_CATEGORIES;
    const eventsRow = await db.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
      "SELECT COUNT(*) AS cnt FROM events WHERE session_id = $1",
      session.sessionId
    );
    assert.equal(
      Number(eventsRow[0].cnt),
      expectedEvents,
      `all ${expectedEvents} event rows written`
    );

    const tokenRow = await db.prisma.client.$queryRawUnsafe<{ cnt: number }[]>(
      "SELECT COUNT(*) AS cnt FROM token_events WHERE session_id = $1",
      session.sessionId
    );
    assert.equal(
      Number(tokenRow[0].cnt),
      perCategory,
      `all ${perCategory} token_events rows written`
    );

    // Per-category breakdown — proves columns/ordering preserved, not just total.
    const byType = await db.prisma.client.$queryRawUnsafe<
      { event_type: string; cnt: number }[]
    >(
      "SELECT event_type, COUNT(*) AS cnt FROM events WHERE session_id = $1 GROUP BY event_type",
      session.sessionId
    );
    const counts = new Map(byType.map((r) => [r.event_type, Number(r.cnt)]));
    assert.equal(counts.get("Stop"), perCategory, "Stop events");
    assert.equal(counts.get("PostToolUse"), perCategory, "PostToolUse events");
    assert.equal(
      counts.get("TurnDuration"),
      perCategory,
      "TurnDuration events"
    );
    assert.equal(counts.get("APIError"), perCategory, "APIError events");
    assert.equal(counts.get("ToolError"), perCategory, "ToolError events");
    assert.equal(counts.get("Compaction"), perCategory, "Compaction events");

    // Spot-check a token_events row carries the correct normalized columns.
    const firstToken = await db.prisma.client.$queryRawUnsafe<
      {
        input_tokens: number;
        output_tokens: number;
      }[]
    >(
      "SELECT input_tokens, output_tokens FROM token_events WHERE session_id = $1 ORDER BY created_at ASC LIMIT 1",
      session.sessionId
    );
    assert.equal(Number(firstToken[0].input_tokens), 10, "token input col");
    assert.equal(Number(firstToken[0].output_tokens), 5, "token output col");

    // Re-import the SAME session: ON CONFLICT (id) DO NOTHING on events +
    // delete/reinsert on token_events must keep the row counts identical.
    await db.importer.importSession(session, "claude");
    const eventsAfter = await db.prisma.client.$queryRawUnsafe<
      { cnt: number }[]
    >(
      "SELECT COUNT(*) AS cnt FROM events WHERE session_id = $1",
      session.sessionId
    );
    assert.equal(
      Number(eventsAfter[0].cnt),
      expectedEvents,
      "event count unchanged after re-import (idempotent)"
    );
    const tokensAfter = await db.prisma.client.$queryRawUnsafe<
      { cnt: number }[]
    >(
      "SELECT COUNT(*) AS cnt FROM token_events WHERE session_id = $1",
      session.sessionId
    );
    assert.equal(
      Number(tokensAfter[0].cnt),
      perCategory,
      "token_events count unchanged after re-import (idempotent)"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
