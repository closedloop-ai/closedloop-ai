/**
 * @file timestamp-format-heal-rowid-keying.test.ts
 * @description ISS-5491: the FEA-3743 boot heal's KEYING choice for the Codex
 * OTel per-event columns (`codex_trace_span.start_time` / `.end_time`,
 * `token_usage.created_at`).
 *
 * These three carry a per-event instant, so their values are near-unique per
 * row and the DISTINCT-value count tracks the ROW count. On the value-keyed
 * path that meant one `UPDATE … WHERE <col> = <value>` per row — each its own
 * `prisma.write`, i.e. its own entry on the serialized write queue plus a
 * throttled WAL checkpoint — and the heal is AWAITED in `openSqliteAgentDatabase`
 * ahead of the stale-session and retention sweeps, so a large legacy OTel
 * history stalled boot behind it. (Two of the three are also unindexed, making
 * each of those statements a full table scan, but the queue-entry count is the
 * half an index cannot fix.)
 *
 * So the contract these cases pin is not "the values end up canonical" — the
 * value-keyed path did that too — it is that the COST is bounded by the number
 * of PAGES rather than by the number of distinct values. `makeRecordingQueue`
 * counts write-queue entries, and only `prisma.write` routes through it
 * (`prisma.client` reads do not), so `queue.runs` is exactly the number of
 * boot-blocking write-queue turns — each one the queue serialization plus its
 * throttled WAL-checkpoint turn.
 *
 * `queue.runs` is deliberately NOT a count of SQLite transactions (review):
 * `prisma.write` serializes its callback but opens no transaction of its own,
 * and `rewritePage` issues each `$executeRawUnsafe` without `$transaction`, so
 * a page still autocommits one UPDATE at a time. The boot cost this change
 * bounds is the queue-and-checkpoint turn, which is what these assertions
 * measure; the per-statement autocommit count is unchanged and is not claimed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isCanonicalUtcTimestamp } from "../src/main/database/session-timestamp-form.js";
import {
  normalizeStoredTimestampFormats,
  ROW_HEAL_PAGE_SIZE,
} from "../src/main/database/timestamp-format-maintenance.js";
import { makeRecordingQueue, openTestPrisma } from "./prisma-test-utils.js";

const HEAL_NOW = "2026-06-23T00:00:00.000Z";

/** Canonical throughout, so the session rows contribute no writes of their own. */
const CANONICAL = "2026-06-22T08:00:00.000Z";

const SEED_SESSION_SQL =
  "INSERT INTO sessions (id, status, updated_at, last_activity_at, started_at, data_revision) VALUES ($1, 'active', $2, $2, $2, 1)";

const SEED_SPAN_SQL = `INSERT INTO codex_trace_span
  (trace_id, span_id, session_id, name, start_time, end_time, duration_ms,
   status, received_at)
  VALUES ($1, $2, $3, 'tool', $4, $5, 1000, 'ok', $6)`;

const SEED_USAGE_SQL =
  "INSERT INTO token_usage (session_id, model, created_at) VALUES ($1, $2, $3)";

/**
 * `2026-06-22T05:MM:SS-05:00` — an offset form, so it is a heal candidate, and
 * distinct per index so N rows carry N distinct values. Each re-expresses as
 * `2026-06-22T10:MM:SS.000Z`, the same instant. Valid for `i < 3600`.
 */
function offsetFormAt(i: number): string {
  return `2026-06-22T05:${clockPartsAt(i)}-05:00`;
}

function canonicalFormAt(i: number): string {
  return `2026-06-22T10:${clockPartsAt(i)}.000Z`;
}

function clockPartsAt(i: number): string {
  const mm = String(Math.floor(i / 60)).padStart(2, "0");
  const ss = String(i % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// One row past a full page, so the sweep must take a SECOND page to converge.
// Sizing the fixture off the production constant is what makes this a paging
// assertion rather than a single-batch one: a fixture that fits in one page
// stays green even if the `LIMIT` is dropped entirely, which would restore the
// whole-column hydration the keyset pager exists to prevent.
const SPAN_COUNT = ROW_HEAL_PAGE_SIZE + 1;

test("ISS-5491: distinct codex_trace_span.end_time values cost one write per PAGE, not one per value", async () => {
  const queue = makeRecordingQueue();
  const { db: store, prisma, close } = await openTestPrisma(queue);
  try {
    await store.query(SEED_SESSION_SQL, ["s-spans", CANONICAL]);
    for (let i = 0; i < SPAN_COUNT; i += 1) {
      // `start_time` is seeded CANONICAL so this case isolates `end_time`, the
      // column with no index of its own (`idx_codex_trace_span_start_time`
      // covers only its sibling) and the worst case in the ticket.
      await store.query(SEED_SPAN_SQL, [
        "t-1",
        `span-${i}`,
        "s-spans",
        CANONICAL,
        offsetFormAt(i),
        CANONICAL,
      ]);
    }
    assert.equal(isCanonicalUtcTimestamp(offsetFormAt(0)), false);

    const result = await normalizeStoredTimestampFormats(
      prisma,
      () => undefined,
      () => HEAL_NOW
    );

    assert.equal(result.rewritten, SPAN_COUNT);
    assert.equal(
      queue.runs,
      2,
      `${SPAN_COUNT} distinct values spanning two pages must cost exactly two write-queue turns; the value-keyed path spent ${SPAN_COUNT}`
    );
    const spans = await prisma.client.$queryRawUnsafe<
      { span_id: string; start_time: string; end_time: string }[]
    >(
      "SELECT span_id, start_time, end_time FROM codex_trace_span ORDER BY span_id"
    );
    assert.equal(spans.length, SPAN_COUNT);
    for (const span of spans) {
      const i = Number(span.span_id.slice("span-".length));
      assert.equal(
        span.end_time,
        canonicalFormAt(i),
        `span-${i} keeps its own instant — a rowid-keyed rewrite must not smear one page's values together`
      );
      assert.equal(span.start_time, CANONICAL);
    }
  } finally {
    await close();
  }
});

test("ISS-5491: token_usage.created_at heals on rowid, and a converged column writes nothing", async () => {
  const queue = makeRecordingQueue();
  const { db: store, prisma, close } = await openTestPrisma(queue);
  try {
    await store.query(SEED_SESSION_SQL, ["s-usage", CANONICAL]);
    const models = ["m-0", "m-1", "m-2", "m-3", "m-4"];
    for (const [i, model] of models.entries()) {
      await store.query(SEED_USAGE_SQL, ["s-usage", model, offsetFormAt(i)]);
    }

    const result = await normalizeStoredTimestampFormats(
      prisma,
      () => undefined,
      () => HEAL_NOW
    );

    assert.equal(result.rewritten, models.length);
    assert.equal(queue.runs, 1);
    const rows = await prisma.client.$queryRawUnsafe<
      { model: string; created_at: string }[]
    >("SELECT model, created_at FROM token_usage ORDER BY model");
    for (const [i, row] of rows.entries()) {
      assert.equal(row.created_at, canonicalFormAt(i));
    }

    // The heal does NOT bump the owning session's sync cursor, and does not
    // need to: `selectTokenUsageRows` reads `created_at` only for the local
    // `resolveTokenUsageCostUsd` pricing pick — `SyncedAgentSessionTokenUsage`
    // carries no timestamp, so no re-spelled text is stranded in the cloud.
    // Pinned so a future owner-bump arm cannot be added here by accident.
    const owner = await prisma.client.$queryRawUnsafe<{ updated_at: string }[]>(
      "SELECT updated_at FROM sessions WHERE id = 's-usage'"
    );
    assert.equal(owner[0].updated_at, CANONICAL);

    // Steady state: a converged column must cost ZERO write-queue turns, so a
    // re-boot never re-enters the write queue at all.
    const runsBefore = queue.runs;
    const second = await normalizeStoredTimestampFormats(
      prisma,
      () => undefined,
      () => HEAL_NOW
    );
    assert.equal(second.rewritten, 0);
    assert.equal(queue.runs, runsBefore);
  } finally {
    await close();
  }
});

// Enough distinct values that the value-keyed path is unambiguously separable
// from the row-keyed one (N queue turns vs 1), and small enough that this case
// stays a KEYING assertion — the page-boundary crossing is `end_time`'s job
// above, and repeating it here would only re-pay its seed cost.
const START_TIME_SPAN_COUNT = 5;

// The `end_time` case above cannot catch this one: it seeds `start_time`
// canonical, so dropping `healByRowId` from the `codex_trace_span.start_time`
// registry entry leaves it green. `start_time` is near-unique per row exactly
// like its sibling, and having an index (`idx_codex_trace_span_start_time`) is
// not a reason to key it by value — the index removes the scan, not the
// per-distinct-value queue turn (see the ISS-5491 note on `healByRowId`).
test("ISS-5491: codex_trace_span.start_time heals on rowid too, despite its index", async () => {
  const queue = makeRecordingQueue();
  const { db: store, prisma, close } = await openTestPrisma(queue);
  try {
    await store.query(SEED_SESSION_SQL, ["s-starts", CANONICAL]);
    for (let i = 0; i < START_TIME_SPAN_COUNT; i += 1) {
      // Mirror of the `end_time` case: the offending column is seeded
      // offset-form and its sibling canonical, so only `start_time` heals.
      await store.query(SEED_SPAN_SQL, [
        "t-2",
        `span-${i}`,
        "s-starts",
        offsetFormAt(i),
        CANONICAL,
        CANONICAL,
      ]);
    }

    const result = await normalizeStoredTimestampFormats(
      prisma,
      () => undefined,
      () => HEAL_NOW
    );

    assert.equal(result.rewritten, START_TIME_SPAN_COUNT);
    assert.equal(
      queue.runs,
      1,
      `${START_TIME_SPAN_COUNT} distinct start_time values fitting one page must cost exactly one write-queue turn; the value-keyed path spends ${START_TIME_SPAN_COUNT}`
    );
    const spans = await prisma.client.$queryRawUnsafe<
      { span_id: string; start_time: string; end_time: string }[]
    >(
      "SELECT span_id, start_time, end_time FROM codex_trace_span ORDER BY span_id"
    );
    assert.equal(spans.length, START_TIME_SPAN_COUNT);
    for (const span of spans) {
      const i = Number(span.span_id.slice("span-".length));
      assert.equal(
        span.start_time,
        canonicalFormAt(i),
        `span-${i} keeps its own instant — a rowid-keyed rewrite must not smear one page's values together`
      );
      assert.equal(span.end_time, CANONICAL);
    }
  } finally {
    await close();
  }
});
