/**
 * @file activity-segment-store.test.ts
 * @description FEA-2267 end-to-end store tests: the real importer persists a
 * complete activity-segment tiling whose per-segment spend reconciles EXACTLY to
 * the session's token_events (FR-5/6), idle segments carry no spend (Q-005), the
 * half-open boundary turn at endMs is never dropped, and re-import is
 * byte-identical (Goal 3). Drives the production `openSqliteAgentDatabase`
 * importer so the load-bearing phase ordering (segments after token_events) is
 * exercised, not just asserted by inspection.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { segmentIndexForMs } from "../src/main/collectors/parsing/activity-segment-classifier.js";
import type { NormalizedTokenRecord } from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeSession } from "./normalized-session-test-utils.js";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;
type Segment = { startMs: number; endMs: number; phase: string };

function turn(timestamp: string, input: number): NormalizedTokenRecord {
  return {
    timestamp,
    model: "claude-sonnet-4-5",
    input,
    output: Math.round(input / 2),
    cacheRead: 10,
    cacheWrite: 5,
  };
}

async function openDb(): Promise<{ db: Db; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2267-store-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });
  return {
    db,
    cleanup: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function readSegments(db: Db, sessionId: string): Promise<Segment[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { start_ms: bigint | number; end_ms: bigint | number; phase: string }[]
  >(
    `SELECT start_ms, end_ms, phase FROM session_activity_segments
       WHERE session_id = $1 ORDER BY start_ms ASC`,
    sessionId
  );
  return rows.map((r) => ({
    startMs: Number(r.start_ms),
    endMs: Number(r.end_ms),
    phase: r.phase,
  }));
}

async function readTokenEvents(
  db: Db,
  sessionId: string
): Promise<{ ms: number; cost: number }[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { created_at: string; cost: number | null }[]
  >(
    `SELECT created_at, COALESCE(cost_usd_estimated, 0) AS cost FROM token_events
       WHERE session_id = $1`,
    sessionId
  );
  return rows.map((r) => ({
    ms: Date.parse(r.created_at),
    cost: Number(r.cost),
  }));
}

/**
 * Asserts complete tiling + exact Σ reconciliation; returns per-segment spend.
 * Throws (rather than calling assert.* outside a test body) to satisfy biome's
 * noMisplacedAssertion rule; a throw fails the calling test all the same.
 */
function reconcile(
  segments: Segment[],
  events: { ms: number; cost: number }[]
): number[] {
  const perSegment = new Array<number>(segments.length).fill(0);
  let assigned = 0;
  for (const event of events) {
    const idx = segmentIndexForMs(segments, event.ms);
    if (idx < 0) {
      throw new Error(
        `token_event @${event.ms} must land in exactly one segment`
      );
    }
    perSegment[idx] += event.cost;
    assigned += 1;
  }
  if (assigned !== events.length) {
    throw new Error("every token_event must be attributed exactly once");
  }
  const segTotal = perSegment.reduce((a, b) => a + b, 0);
  const eventTotal = events.reduce((a, e) => a + e.cost, 0);
  if (Math.abs(segTotal - eventTotal) >= 1e-9) {
    throw new Error(
      `Σ(segment spend)=${segTotal} must equal Σ(token_events)=${eventTotal}`
    );
  }
  return perSegment;
}

test("import tiles a session and reconciles spend exactly; idle carries none", async () => {
  const { db, cleanup } = await openDb();
  try {
    const session = makeSession({
      sessionId: "recon-idle",
      startedAt: "2026-06-07T00:00:00.000Z",
      endedAt: "2026-06-07T00:25:00.000Z",
      tokenSeries: [
        turn("2026-06-07T00:01:00.000Z", 100),
        // 19-minute idle gap (> ACTIVITY_IDLE_GAP_MS)
        turn("2026-06-07T00:20:00.000Z", 60),
      ],
    });
    await db.importer.importSession(session, "claude");

    const segments = await readSegments(db, "recon-idle");
    assert.deepEqual(
      segments.map((s) => s.phase),
      ["other", "idle", "other"],
      "idle is persisted as its own labelled slice between active segments"
    );

    const events = await readTokenEvents(db, "recon-idle");
    assert.equal(events.length, 2, "one token_event per turn");
    const perSegment = reconcile(segments, events);

    const idleIndex = segments.findIndex((s) => s.phase === "idle");
    assert.equal(
      perSegment[idleIndex],
      0,
      "idle segment carries no token spend"
    );
  } finally {
    await cleanup();
  }
});

test("a turn at exactly endMs is attributed (half-open boundary not dropped)", async () => {
  const { db, cleanup } = await openDb();
  try {
    // endedAt == latest turn ⇒ endMs == that turn's timestamp.
    const session = makeSession({
      sessionId: "boundary",
      startedAt: "2026-06-07T00:00:00.000Z",
      endedAt: "2026-06-07T00:05:00.000Z",
      tokenSeries: [
        turn("2026-06-07T00:01:00.000Z", 100),
        turn("2026-06-07T00:05:00.000Z", 80),
      ],
    });
    await db.importer.importSession(session, "claude");

    const segments = await readSegments(db, "boundary");
    const events = await readTokenEvents(db, "boundary");
    const lastSegment = segments.at(-1);
    assert.ok(lastSegment);
    // endMs is one ms past the latest turn, so the final segment has positive
    // width and the last turn (at endedAt) stays strictly inside it.
    assert.equal(
      lastSegment.endMs,
      Date.parse("2026-06-07T00:05:00.000Z") + 1,
      "endMs is one ms past the latest turn"
    );
    assert.equal(
      segmentIndexForMs(segments, Date.parse("2026-06-07T00:05:00.000Z")),
      segments.length - 1,
      "the turn at the session end is attributed to the final segment"
    );
    // reconcile() asserts every token (incl. the final one) maps to exactly one
    // segment and Σ(segment spend) == Σ(token_events).
    reconcile(segments, events);
  } finally {
    await cleanup();
  }
});

test("re-import is byte-identical: same session → identical segment rows", async () => {
  const { db, cleanup } = await openDb();
  try {
    const session = makeSession({
      sessionId: "determinism",
      startedAt: "2026-06-07T00:00:00.000Z",
      endedAt: "2026-06-07T00:25:00.000Z",
      tokenSeries: [
        turn("2026-06-07T00:01:00.000Z", 100),
        turn("2026-06-07T00:20:00.000Z", 60),
      ],
    });

    await db.importer.importSession(session, "claude");
    const first = await readSegmentRows(db, "determinism");
    await db.importer.importSession(session, "claude");
    const second = await readSegmentRows(db, "determinism");

    assert.ok(first.length > 0, "segments were persisted");
    assert.deepEqual(
      second,
      first,
      "re-import replaces rows with identical content"
    );
  } finally {
    await cleanup();
  }
});

test("deleting a session removes its activity segments (no orphans)", async () => {
  const { db, cleanup } = await openDb();
  try {
    const session = makeSession({
      sessionId: "to-delete",
      startedAt: "2026-06-07T00:00:00.000Z",
      endedAt: "2026-06-07T00:05:00.000Z",
      tokenSeries: [turn("2026-06-07T00:01:00.000Z", 100)],
    });
    await db.importer.importSession(session, "claude");
    assert.ok(
      (await readSegments(db, "to-delete")).length > 0,
      "segments persisted by import"
    );

    await db.deleteSessionRow("to-delete");

    assert.equal(
      (await readSegments(db, "to-delete")).length,
      0,
      "session_activity_segments rows are removed with the session"
    );
  } finally {
    await cleanup();
  }
});

async function readSegmentRows(
  db: Db,
  sessionId: string
): Promise<
  {
    id: string;
    phase: string;
    start_ms: number;
    end_ms: number;
    version: number;
  }[]
> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    {
      id: string;
      phase: string;
      start_ms: bigint | number;
      end_ms: bigint | number;
      version: number;
    }[]
  >(
    `SELECT id, phase, start_ms, end_ms, version FROM session_activity_segments
       WHERE session_id = $1 ORDER BY start_ms ASC`,
    sessionId
  );
  return rows.map((r) => ({
    id: r.id,
    phase: r.phase,
    start_ms: Number(r.start_ms),
    end_ms: Number(r.end_ms),
    version: Number(r.version),
  }));
}
