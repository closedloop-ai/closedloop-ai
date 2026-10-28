/**
 * ISS-9117: the batched segment read applies its PER-SESSION bound in a
 * constant number of statements instead of one per session id, and the capped
 * event read stays bound to its single-session caller.
 *
 * The bound is the whole difficulty. A flat `IN (…)` with one `LIMIT`/`take`
 * caps the TOTAL across the batch and — with rows ordered by session id —
 * silently starves later sessions while returning exactly as many rows as it was
 * asked for, so no row-count total would catch it. Every test here asserts what
 * EACH session received, never what the batch received.
 *
 * Statement counts are literals written here rather than derived from the module
 * under test, so a change to a read's shape has to be restated in this file.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { CapturedStatement } from "../src/main/database/prisma-statement-observers.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import {
  ACTIVITY_SEGMENT_PAGE_SIZE,
  ACTIVITY_SEGMENT_SYNC_MAX_ROWS,
  selectBoundedActivitySegments,
  selectEventRows,
} from "../src/main/database/sync-source-bounded-reads.js";
import { getSharedAgentSessionDetail } from "../src/main/session/shared-agent-session-detail-read.js";
import { openTestPrisma } from "./prisma-test-utils.js";

/** Segments the over-ceiling session gets: one past the memory-safety ceiling. */
const OVER_CEILING_SEGMENTS = ACTIVITY_SEGMENT_SYNC_MAX_ROWS + 1;
/** Segments the small session gets — every one of them must survive. */
const SMALL_SESSION_SEGMENTS = 3;

/**
 * The statements one batched segment read may issue, whatever the batch width:
 * the overflow sentinel, then the one read of every session within the ceiling.
 * A session ABOVE the ceiling adds one bounded read of its own.
 *
 * Both statements run inside the read's snapshot `$transaction`, so counting
 * them at all depends on `onStatement` reaching a transaction's own queries. A
 * spy that stops at the connection reports 0 here, which is why these are equal
 * assertions and not lower bounds.
 */
const BATCHED_SEGMENT_STATEMENTS = 2;
/** Segments the at-ceiling session gets: the largest tiling still read in the batch. */
const AT_CEILING_SEGMENTS = ACTIVITY_SEGMENT_SYNC_MAX_ROWS;
/** SQLite opcodes that only appear when a statement AGGREGATES its input. */
const AGGREGATE_OPCODES = new Set([
  "AggFinal",
  "AggInverse",
  "AggStep",
  "AggStep1",
  "AggValue",
  "Count",
]);
const SEGMENT_INDEX_SEEK_RE =
  /SEARCH \w+ USING (?:COVERING )?INDEX idx_session_activity_segments_session_start/;
/** The Prisma read delegate's own paged segment SELECT (never the raw sentinel). */
const PAGED_SEGMENT_SELECT_RE = /^SELECT `main`\.`session_activity_segments`/;
/** Any full walk of the segments table — the regression the sentinel exists to avoid. */
const SEGMENT_SCAN_RE = /\bSCAN session_activity_segments\b/;
/**
 * The `LIMIT`-bounded event statements ONE capped production hydration may
 * issue. It is a per-id loop, so this literal also pins the caller at one id.
 */
const BOUNDED_EVENT_STATEMENTS = 1;

/**
 * Insert `count` segments for `sessionId` in one statement. A recursive CTE
 * rather than `count` round trips: the ceiling case needs tens of thousands of
 * rows and the seeding is not what is under test.
 */
function segmentSeedSql(sessionId: string, count: number): string {
  return `
    INSERT INTO session_activity_segments
      (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, subagent_id, observed_at)
    WITH RECURSIVE seq(i) AS (
      SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < ${count - 1}
    )
    SELECT
      '${sessionId}-seg-' || i, '${sessionId}', 'implement',
      i * 10, i * 10 + 5, 0.9, '["structural"]', 4, NULL, NULL, 'observed'
    FROM seq`;
}

function eventSeedSql(sessionId: string, count: number): string {
  return `
    INSERT INTO events (id, session_id, event_type, tool_name, summary, data, created_at)
    WITH RECURSIVE seq(i) AS (
      SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < ${count - 1}
    )
    SELECT
      '${sessionId}-evt-' || i, '${sessionId}', 'PostToolUse', 'Bash', 'summary', '{}',
      '2026-09-01T00:00:' || SUBSTR('0' || i, -2) || '.000Z'
    FROM seq`;
}

function sessionIds(prefix: string, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(`${prefix}-${String(i).padStart(4, "0")}`);
  }
  return ids;
}

function countBySessionId<T extends { sessionId: string }>(
  rows: T[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.sessionId, (counts.get(row.sessionId) ?? 0) + 1);
  }
  return counts;
}

test("ISS-9117: a session over the segment ceiling keeps its own bound and does not consume another session's segments", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // 'seg-a' sorts before 'seg-b', so a single `take` over `IN ('seg-a','seg-b')`
    // ordered by session id would spend its whole allowance on 'seg-a' and hand
    // 'seg-b' nothing at all — with a row count that looks exactly right.
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        "INSERT INTO sessions (id, status) VALUES ('seg-a','inactive'), ('seg-b','inactive')"
      )
    );
    await prisma.write((client) =>
      client.$executeRawUnsafe(segmentSeedSql("seg-a", OVER_CEILING_SEGMENTS))
    );
    await prisma.write((client) =>
      client.$executeRawUnsafe(segmentSeedSql("seg-b", SMALL_SESSION_SEGMENTS))
    );

    const { rows } = await prisma.read((reader) =>
      selectBoundedActivitySegments(reader, ["seg-a", "seg-b"])
    );

    const counts = countBySessionId(rows);
    assert.equal(
      counts.get("seg-a"),
      OVER_CEILING_SEGMENTS,
      "the over-ceiling session reads its entire tiling via paged reads"
    );
    assert.equal(
      counts.get("seg-b"),
      SMALL_SESSION_SEGMENTS,
      "the second session keeps every segment it has — a batch-total bound would starve it"
    );
    // Each session's own rows stay in start order.
    const first = rows.find((row) => row.sessionId === "seg-b");
    assert.equal(first?.startMs, 0n);
  } finally {
    await close();
  }
});

test("ISS-9117: the segment read costs the same two statements at 20 ids and at 200", async () => {
  const captured: CapturedStatement[] = [];
  const { prisma, close } = await openTestPrisma(undefined, {
    onStatement: (statement) => captured.push(statement),
  });
  try {
    const ids = sessionIds("wide", 200);
    for (const id of ids) {
      // `$executeRawUnsafe` is served on the adapter's `executeRaw`, so seeding
      // never lands in `captured` and cannot be mistaken for a read statement.
      await prisma.write((client) =>
        client.$executeRawUnsafe(
          "INSERT INTO sessions (id, status) VALUES (?, 'inactive')",
          id
        )
      );
      await prisma.write((client) =>
        client.$executeRawUnsafe(segmentSeedSql(id, SMALL_SESSION_SEGMENTS))
      );
    }

    captured.length = 0;
    const { rows: narrow } = await prisma.read((reader) =>
      selectBoundedActivitySegments(reader, ids.slice(0, 20))
    );
    const narrowStatements = captured.length;
    captured.length = 0;
    const { rows: wide } = await prisma.read((reader) =>
      selectBoundedActivitySegments(reader, ids)
    );
    const wideStatements = captured.length;

    assert.equal(narrowStatements, BATCHED_SEGMENT_STATEMENTS);
    assert.equal(
      wideStatements,
      BATCHED_SEGMENT_STATEMENTS,
      "a 10x wider batch must not cost 10x the statements"
    );
    assert.equal(narrow.length, 20 * SMALL_SESSION_SEGMENTS);
    assert.equal(wide.length, 200 * SMALL_SESSION_SEGMENTS);
    const counts = countBySessionId(wide);
    assert.equal(counts.size, 200, "every session in the batch is represented");
    for (const id of ids) {
      assert.equal(
        counts.get(id),
        SMALL_SESSION_SEGMENTS,
        `${id} kept its full tiling`
      );
    }
  } finally {
    await close();
  }
});

test("ISS-9117: the only production caller that caps the event read passes ONE session id", async () => {
  const captured: CapturedStatement[] = [];
  const { prisma, close } = await openTestPrisma(undefined, {
    onStatement: (statement) => captured.push(statement),
  });
  try {
    for (const id of ["detail-a", "detail-b"]) {
      await prisma.write((client) =>
        client.$executeRawUnsafe(
          "INSERT INTO sessions (id, status) VALUES (?, 'inactive')",
          id
        )
      );
      await prisma.write((client) =>
        client.$executeRawUnsafe(eventSeedSql(id, 9))
      );
    }

    captured.length = 0;
    // The real production entry point, not a hand-built call: this is what sets
    // `eventRowCap` at all.
    const detail = await getSharedAgentSessionDetail(
      createSqliteSessionSyncSource(prisma),
      "detail-a"
    );
    const cappedEventReads = captured.filter(
      (statement) =>
        statement.sql.includes("FROM events") && statement.sql.includes("LIMIT")
    );

    assert.ok(detail, "the detail read resolved its session");
    // The capped read costs one `LIMIT` statement per id it is handed. Pinning
    // it at exactly one is what binds `eventRowCap` to a single-session caller:
    // a future capped caller that hydrates a batch turns this loop into an N+1
    // and fails here rather than silently.
    assert.equal(
      cappedEventReads.length,
      BOUNDED_EVENT_STATEMENTS,
      "a capped hydration must cover exactly one session"
    );
    for (const statement of cappedEventReads) {
      assert.equal(
        statement.args.length,
        1,
        "the capped read binds exactly one session id"
      );
    }
  } finally {
    await close();
  }
});

test("ISS-9117: a capped multi-id read still bounds EACH session, never the batch total", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const ids = ["evt-a", "evt-b", "evt-c"];
    for (const id of ids) {
      await prisma.write((client) =>
        client.$executeRawUnsafe(
          "INSERT INTO sessions (id, status) VALUES (?, 'inactive')",
          id
        )
      );
      await prisma.write((client) =>
        client.$executeRawUnsafe(eventSeedSql(id, 9))
      );
    }

    const rows = await prisma.read((reader) =>
      selectEventRows(reader, ids, "data", 2)
    );

    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.session_id, (counts.get(row.session_id) ?? 0) + 1);
    }
    for (const id of ids) {
      // cap + 1: the read deliberately fetches one row past the ceiling so the
      // caller can tell a complete stream from a prefix. A single `LIMIT` over
      // the multi-id `IN (...)` would have spent all 3 rows on `evt-a`.
      assert.equal(counts.get(id), 3, `${id} reads its own cap + 1`);
    }
    // Oldest-first within each session, so the bounded set is a stable prefix.
    const firstOfB = rows.find((row) => row.session_id === "evt-b");
    assert.equal(firstOfB?.id, "evt-b-evt-0");
  } finally {
    await close();
  }
});

test("ISS-9117: the overflow classification is a bounded sentinel, not a count over the whole tiling", async () => {
  const captured: CapturedStatement[] = [];
  const { prisma, close } = await openTestPrisma(undefined, {
    onStatement: (statement) => captured.push(statement),
  });
  try {
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        "INSERT INTO sessions (id, status) VALUES ('sentinel-a','inactive')"
      )
    );
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        segmentSeedSql("sentinel-a", SMALL_SESSION_SEGMENTS)
      )
    );

    captured.length = 0;
    await prisma.read((reader) =>
      selectBoundedActivitySegments(reader, ["sentinel-a"])
    );
    // The classification is by contract the FIRST statement the read issues:
    // nothing can be fetched before the batch is split by it.
    const [classification] = captured;
    assert.ok(classification, "the read issued a classification statement");

    // Replayed, never transcribed: EXPLAIN runs the SQL and bindings that
    // actually reached the driver adapter, so editing the classification moves
    // these assertions with it instead of leaving a stale copy green.
    const plan = await prisma.read((reader) =>
      reader.$queryRawUnsafe<{ detail: string }[]>(
        `EXPLAIN QUERY PLAN ${classification.sql}`,
        ...classification.args
      )
    );
    const planText = plan.map((row) => row.detail).join("\n");
    assert.match(
      planText,
      SEGMENT_INDEX_SEEK_RE,
      "the sentinel seeks the (session_id, start_ms) index once per id"
    );
    assert.doesNotMatch(
      planText,
      SEGMENT_SCAN_RE,
      "classifying must never walk the segments table"
    );

    // The plan alone cannot tell a bounded sentinel from a `COUNT(*)`: both seek
    // the same index. The difference is that a count AGGREGATES — it has to
    // visit every row of an over-ceiling session to produce its number, which is
    // exactly the db-host stall this read must not pay. Only the bytecode says
    // which one this is.
    const bytecode = await prisma.read((reader) =>
      reader.$queryRawUnsafe<{ opcode: string }[]>(
        `EXPLAIN ${classification.sql}`,
        ...classification.args
      )
    );
    const aggregates = bytecode
      .map((row) => row.opcode)
      .filter((opcode) => AGGREGATE_OPCODES.has(opcode));
    assert.deepEqual(
      aggregates,
      [],
      "the sentinel asks whether a row EXISTS past the ceiling; it must not aggregate"
    );
  } finally {
    await close();
  }
});

test("ISS-9117: the ceiling boundary decides which read a session gets, not just how many rows it keeps", async () => {
  const captured: CapturedStatement[] = [];
  const { prisma, close } = await openTestPrisma(undefined, {
    onStatement: (statement) => captured.push(statement),
  });
  try {
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        "INSERT INTO sessions (id, status) VALUES ('edge-small','inactive'), ('edge-at','inactive'), ('edge-over','inactive')"
      )
    );
    // `edge-small` is not decoration. Without a session that is under the
    // ceiling on EVERY reading of the sentinel, an off-by-one that pushes
    // `edge-at` over empties the within-ceiling set, the batched statement is
    // skipped entirely, and the two per-session reads land on the same total the
    // correct split produces — a count that agrees with itself for the wrong
    // reason. Anchoring one session inside the batch keeps the totals distinct.
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        segmentSeedSql("edge-small", SMALL_SESSION_SEGMENTS)
      )
    );
    await prisma.write((client) =>
      client.$executeRawUnsafe(segmentSeedSql("edge-at", AT_CEILING_SEGMENTS))
    );
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        segmentSeedSql("edge-over", OVER_CEILING_SEGMENTS)
      )
    );

    captured.length = 0;
    const { rows } = await prisma.read((reader) =>
      selectBoundedActivitySegments(reader, [
        "edge-small",
        "edge-at",
        "edge-over",
      ])
    );

    const counts = countBySessionId(rows);
    assert.equal(
      counts.get("edge-small"),
      SMALL_SESSION_SEGMENTS,
      "the anchor session keeps its whole tiling"
    );
    assert.equal(
      counts.get("edge-at"),
      AT_CEILING_SEGMENTS,
      "a session exactly AT the ceiling keeps every segment"
    );
    assert.equal(
      counts.get("edge-over"),
      OVER_CEILING_SEGMENTS,
      "the over-ceiling session loads its entire tiling via keyset paging"
    );
    // Row counts alone cannot see an off-by-one in the sentinel's OFFSET: a
    // session misrouted to its own `take` returns the identical rows. The
    // STATEMENT COUNT is what separates the two paths — the over-ceiling
    // session pays one paged `findMany` per page of its own tiling.
    //
    // Counted over the segment-delegate SELECTs specifically, not over every
    // statement the connection saw: these suites run in one worker and a
    // sibling case's own segment read has been observed landing in this array,
    // which made a raw `captured.length` flip between runs.
    const segmentSelects = captured.filter((statement) =>
      PAGED_SEGMENT_SELECT_RE.test(String(statement.sql))
    );
    assert.equal(
      segmentSelects.length,
      // The one batched read for the two within-ceiling sessions, then one page
      // per page of the over-ceiling session's own tiling.
      1 + Math.ceil(OVER_CEILING_SEGMENTS / ACTIVITY_SEGMENT_PAGE_SIZE),
      "only the over-ceiling session buys paged reads, one findMany per page"
    );
  } finally {
    await close();
  }
});

test("ISS-9865: duplicate startMs values spanning a page boundary lose no rows", async () => {
  // A page boundary at ACTIVITY_SEGMENT_PAGE_SIZE rows. If two segments share
  // the same startMs and the boundary falls between them, a cursor on startMs
  // alone (gt: lastStartMs) would skip the second. The compound cursor on
  // (startMs, id) prevents that.
  const { prisma, close } = await openTestPrisma();
  try {
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        "INSERT INTO sessions (id, status) VALUES ('dup-start','inactive')"
      )
    );
    // Seed ACTIVITY_SEGMENT_PAGE_SIZE + 10 segments where the last 20 of page 1
    // and first 10 of page 2 ALL share the same startMs. A single-key cursor
    // would skip the 10 that belong to page 2.
    const total = ACTIVITY_SEGMENT_PAGE_SIZE + 10;
    const sharedStartMs = 999_999;
    const values: string[] = [];
    for (let i = 0; i < total; i++) {
      const startMs =
        i < ACTIVITY_SEGMENT_PAGE_SIZE - 20 ? i * 10 : sharedStartMs;
      values.push(
        `('dup-${String(i).padStart(6, "0")}', 'dup-start', 'implement', ${startMs}, ${startMs + 5}, 0.9, '["structural"]', 4, NULL, NULL, 'observed')`
      );
    }
    // Insert in chunks of 500 (SQLite compound limit)
    for (let i = 0; i < values.length; i += 500) {
      const chunk = values.slice(i, i + 500);
      await prisma.write((client) =>
        client.$executeRawUnsafe(
          `INSERT INTO session_activity_segments
             (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, subagent_id, observed_at)
           VALUES ${chunk.join(",")}`
        )
      );
    }

    const { rows } = await prisma.read((reader) =>
      selectBoundedActivitySegments(reader, ["dup-start"])
    );

    assert.equal(
      rows.length,
      total,
      `all ${total} segments must be returned even when startMs values span a page boundary`
    );
  } finally {
    await close();
  }
});

/**
 * ISS-9865 (davetho P1, PR #7099): the absolute ceiling decides overflow
 * BEFORE the rows are retained, and a tiling exactly AT the ceiling is not
 * overflow.
 *
 * Driven at a seeded scale through `bounds` rather than at the production
 * 500,000 — see {@link ActivitySegmentReadBounds} for why that seam exists. The
 * production numbers are asserted separately by the constants' own module.
 */
const TINY_BOUNDS = {
  pagingThreshold: 4,
  pageSize: 3,
  absoluteCeiling: 9,
};

test("ISS-9865: a tiling PAST the absolute ceiling is refused, and the read retains none of it", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    for (const [id, count] of [
      // Exactly AT the ceiling: complete, and it ships.
      ["ceil-at", TINY_BOUNDS.absoluteCeiling],
      // One past: refused.
      ["ceil-over", TINY_BOUNDS.absoluteCeiling + 1],
    ] as const) {
      await prisma.write((client) =>
        client.$executeRawUnsafe(
          `INSERT INTO sessions (id, status) VALUES ('${id}','inactive')`
        )
      );
      await prisma.write((client) =>
        client.$executeRawUnsafe(segmentSeedSql(id, count))
      );
    }

    const { rows, overflowedSessionIds } = await prisma.read((reader) =>
      selectBoundedActivitySegments(
        reader,
        ["ceil-at", "ceil-over"],
        TINY_BOUNDS
      )
    );

    // THE BOUNDARY. `>= ceiling` would refuse both of these and lose a tiling
    // that is complete and deliverable.
    assert.equal(
      overflowedSessionIds.has("ceil-at"),
      false,
      "a tiling exactly AT the ceiling is complete, not overflow"
    );
    assert.equal(
      countBySessionId(rows).get("ceil-at"),
      TINY_BOUNDS.absoluteCeiling,
      "the at-ceiling tiling ships whole"
    );

    assert.equal(
      overflowedSessionIds.has("ceil-over"),
      true,
      "one row past the ceiling is a refusal the read REPORTS"
    );
    // The refusal retains nothing. This is the half a row count alone cannot
    // state: a refused session and a session with no tiling both contribute
    // zero rows, which is exactly why `overflowedSessionIds` is carried.
    assert.equal(
      countBySessionId(rows).get("ceil-over"),
      undefined,
      "a refused tiling contributes no rows to carry downstream"
    );
  } finally {
    await close();
  }
});

test("ISS-9865: the refusal probe never reads a whole page past the ceiling", async () => {
  // The bound the drop-on-overflow depends on: proving overflow costs ONE row
  // past the ceiling, not one more `pageSize` page. With pageSize 3 and ceiling
  // 9, a 12-row tiling must be refused after 3 full pages plus a 1-row probe —
  // 4 paged statements, never 4 full pages (12 rows) plus a fifth.
  const captured: CapturedStatement[] = [];
  const { prisma, close } = await openTestPrisma(undefined, {
    onStatement: (statement) => captured.push(statement),
  });
  try {
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        "INSERT INTO sessions (id, status) VALUES ('probe','inactive')"
      )
    );
    await prisma.write((client) =>
      client.$executeRawUnsafe(segmentSeedSql("probe", 12))
    );

    captured.length = 0;
    const { overflowedSessionIds } = await prisma.read((reader) =>
      selectBoundedActivitySegments(reader, ["probe"], TINY_BOUNDS)
    );

    assert.equal(overflowedSessionIds.has("probe"), true);
    // Counted over the PAGED statements only — the Prisma delegate's own SELECT
    // — rather than over everything the connection saw, so the number states the
    // pager's behaviour and nothing else's.
    const pagedStatements = captured.filter((statement) =>
      PAGED_SEGMENT_SELECT_RE.test(String(statement.sql))
    );
    assert.equal(
      pagedStatements.length,
      // ceil(9/3) full pages, then the 1-row probe. A pager that proved overflow
      // by reading another whole page would be 5, and one that never probed
      // would refuse a tiling that is exactly AT the ceiling.
      Math.ceil(TINY_BOUNDS.absoluteCeiling / TINY_BOUNDS.pageSize) + 1,
      "overflow is proven by a bounded probe, not by reading another full page"
    );
  } finally {
    await close();
  }
});
