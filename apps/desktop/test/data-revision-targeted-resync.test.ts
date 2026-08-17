/**
 * @file data-revision-targeted-resync.test.ts
 * @description FEA-3659 — targeted re-sync on a DATA_REVISION bump. Proves the
 * split change-gate (write-core) and the explicit rebuilt-and-changed enqueue
 * (data-revision-rebuild) make a revision bump propagate ONLY genuinely-changed
 * sessions to the cloud instead of re-uploading the whole corpus:
 *
 *  (a) a revision-only bump with a byte-identical payload does NOT bump
 *      updated_at and does NOT land in the changed set (no re-enqueue);
 *  (b) a genuine content change DOES bump updated_at and IS in the changed set;
 *  (c) the rebuilt-and-changed ids are explicitly enqueued into the durable sync
 *      outbox (no stranding), and only those ids;
 *  (d) the durable cursor survives a revision bump (loadSyncState no longer
 *      discards it);
 *  (e) the enqueue is crash-safe / idempotent (re-enqueue of the same id is a
 *      no-op upsert that never resurrects a dead-lettered row).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { DATA_REVISION } from "../src/main/collectors/engine/data-revision.js";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { ACTIVITY_PHASE } from "../src/main/collectors/parsing/activity-taxonomy.js";
import { resolveRebuildSyncComputeTargetId } from "../src/main/dashboard/rebuild-sync-compute-target.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  fakeCollector,
  makePopulatedSession as makeSession,
} from "./normalized-session-test-utils.js";

const STALE_REVISION = 1;
// ISS-5086: the import stamps updated_at = the injected import clock (the
// local→cloud sync watermark), NOT session.endedAt. The rebuild content-change
// path also stamps updated_at = now(), so a row imported under the rebuild clock
// would leave "did the watermark advance?" undecidable. Each test therefore
// stamps the watermark back to STALE_WATERMARK alongside the stale revision —
// exactly how a row imported on an earlier boot looks — so a bump is an
// unambiguous move to REBUILD_CLOCK and a true no-op leaves STALE_WATERMARK in
// place. IMPORT_ENDED_AT remains the session's ACTIVITY time (it flows into
// ended_at / last_activity_at) and never reaches the watermark.
const IMPORT_ENDED_AT = "2026-06-07T10:05:00.000Z";
const STALE_WATERMARK = "2026-06-07T11:00:00.000Z";
const REBUILD_CLOCK = "2026-06-07T12:00:00.000Z";

async function readSessionRow(
  db: Awaited<ReturnType<typeof openTestDb>>,
  id: string
): Promise<{ data_revision: number; updated_at: string }> {
  const [row] = await db.prisma.client.$queryRawUnsafe<
    { data_revision: number; updated_at: string }[]
  >("SELECT data_revision, updated_at FROM sessions WHERE id = $1", id);
  return row;
}

describe("FEA-3659 Part 1 — split change-gate (rebuild is a true no-op when unchanged)", () => {
  test("(a) revision-only bump with byte-identical payload does NOT bump updated_at and is not in the changed set", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea3659-noop-"));
    const db = await openTestDb(dir, { now: () => REBUILD_CLOCK });
    try {
      const session = makeSession({
        sessionId: "noop-session",
        endedAt: IMPORT_ENDED_AT,
      });
      await db.importer.importSession(session, "claude");
      await db.run(
        "UPDATE sessions SET data_revision = $1, updated_at = $2 WHERE id = $3",
        STALE_REVISION,
        STALE_WATERMARK,
        "noop-session"
      );
      const before = await readSessionRow(db, "noop-session");
      assert.equal(before.data_revision, STALE_REVISION);
      assert.equal(before.updated_at, STALE_WATERMARK);

      // Rebuild (now() = REBUILD_CLOCK) parses to the IDENTICAL session →
      // byte-identical metadata blob. A spurious updated_at bump would move it to
      // REBUILD_CLOCK, which the assert catches.
      const collector = fakeCollector("claude", {
        sources: ["/fake/noop.jsonl"],
        parse: () => Promise.resolve([session]),
        sessionIdForSource: () => "noop-session",
      });
      const summary = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });

      assert.equal(summary.rebuilt, 1, "row was re-derived");
      // The changed set is empty — nothing to (re-)sync.
      assert.deepEqual(summary.changedSessionIds, []);

      const after = await readSessionRow(db, "noop-session");
      // data_revision was healed to current (so it is not re-rebuilt next boot)...
      assert.equal(after.data_revision, DATA_REVISION);
      // ...but the sync watermark (updated_at) was NOT bumped.
      assert.equal(after.updated_at, before.updated_at);
      assert.equal(after.updated_at, STALE_WATERMARK);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("(b) a genuine content change bumps updated_at and IS in the changed set", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea3659-changed-"));
    const db = await openTestDb(dir, { now: () => REBUILD_CLOCK });
    try {
      const original = makeSession({
        sessionId: "changed-session",
        endedAt: IMPORT_ENDED_AT,
        userMessages: 1,
      });
      await db.importer.importSession(original, "claude");
      await db.run(
        "UPDATE sessions SET data_revision = $1, updated_at = $2 WHERE id = $3",
        STALE_REVISION,
        STALE_WATERMARK,
        "changed-session"
      );
      const before = await readSessionRow(db, "changed-session");
      assert.equal(before.updated_at, STALE_WATERMARK);

      // Rebuild parses to a session whose DERIVED payload differs (userMessages is
      // part of the metadata blob), so buildImportMetadata differs → contentChanged.
      const rederived = makeSession({
        sessionId: "changed-session",
        endedAt: IMPORT_ENDED_AT,
        userMessages: 7,
      });
      const collector = fakeCollector("claude", {
        sources: ["/fake/changed.jsonl"],
        parse: () => Promise.resolve([rederived]),
        sessionIdForSource: () => "changed-session",
      });
      const summary = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });

      assert.equal(summary.rebuilt, 1);
      assert.deepEqual(summary.changedSessionIds, ["changed-session"]);

      const after = await readSessionRow(db, "changed-session");
      assert.equal(after.data_revision, DATA_REVISION);
      // updated_at advanced to the rebuild clock — the row must re-sync.
      assert.notEqual(after.updated_at, before.updated_at);
      assert.equal(after.updated_at, REBUILD_CLOCK);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("(f) a child-projection change with a byte-identical metadata blob bumps updated_at and IS in the changed set", async () => {
    // Guards the metadata-blob-completeness gap: the synced payload includes
    // child-table projections (agents/subagents, events, token_events, links,
    // PRs, component-usage) that `sessions.metadata` does NOT fingerprint. A
    // DATA_REVISION bump that re-derives a DIFFERENT child projection from an
    // unchanged transcript (e.g. a subagent-classification / tool-ownership fix)
    // must reach the cloud even though the metadata blob is byte-identical.
    // Simulated by tampering a synced child row after import so the rebuild's
    // clean re-derivation differs from it while the parsed session (hence the
    // metadata blob) is unchanged.
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea3659-childchg-"));
    const db = await openTestDb(dir, { now: () => REBUILD_CLOCK });
    try {
      const session = makeSession({
        sessionId: "child-changed-session",
        endedAt: IMPORT_ENDED_AT,
        userMessages: 1,
      });
      await db.importer.importSession(session, "claude");
      // Tamper a synced child row (the main agent's metadata) so the CURRENT
      // stored projection differs from what a clean re-parse re-derives. The
      // metadata BLOB on `sessions` is untouched, so contentChanged from the
      // metadata gate alone would be false.
      await db.run(
        "UPDATE agents SET metadata = $1 WHERE session_id = $2",
        JSON.stringify({ tamperedProjection: true }),
        "child-changed-session"
      );
      await db.run(
        "UPDATE sessions SET data_revision = $1, updated_at = $2 WHERE id = $3",
        STALE_REVISION,
        STALE_WATERMARK,
        "child-changed-session"
      );
      const before = await readSessionRow(db, "child-changed-session");
      assert.equal(before.updated_at, STALE_WATERMARK);

      // Rebuild parses to the IDENTICAL session → byte-identical metadata blob,
      // but its clean child rows differ from the tampered ones.
      const collector = fakeCollector("claude", {
        sources: ["/fake/child.jsonl"],
        parse: () => Promise.resolve([session]),
        sessionIdForSource: () => "child-changed-session",
      });
      const summary = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });

      assert.equal(summary.rebuilt, 1);
      // The child-projection change is detected even though metadata is stable —
      // the row is enqueued and its watermark advances so it re-syncs.
      assert.deepEqual(summary.changedSessionIds, ["child-changed-session"]);

      const after = await readSessionRow(db, "child-changed-session");
      assert.equal(after.data_revision, DATA_REVISION);
      assert.equal(after.updated_at, REBUILD_CLOCK);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("(g) a re-tiled activity segment with a byte-identical metadata blob bumps updated_at and IS in the changed set", async () => {
    // FEA-4010: the activity tiling rides in the synced payload but was missing
    // from the child-row fingerprint, so an ACTIVITY_CLASSIFIER_VERSION bump —
    // which re-tiles and changes NOTHING else — produced an identical
    // fingerprint and stranded the corrected tiling under the preserved cursor.
    // Same tampering strategy as (f), applied to the segment projection.
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea4010-segchg-"));
    const db = await openTestDb(dir, { now: () => REBUILD_CLOCK });
    try {
      const session = makeSession({
        sessionId: "segment-changed-session",
        endedAt: IMPORT_ENDED_AT,
        userMessages: 1,
      });
      await db.importer.importSession(session, "claude");
      // Tamper the stored tiling so a clean re-derivation differs from it, while
      // the parsed session — hence the metadata blob — is unchanged.
      await db.run(
        "UPDATE session_activity_segments SET phase = $1, version = $2 WHERE session_id = $3",
        ACTIVITY_PHASE.Implement,
        1,
        "segment-changed-session"
      );
      await db.run(
        "UPDATE sessions SET data_revision = $1, updated_at = $2 WHERE id = $3",
        STALE_REVISION,
        STALE_WATERMARK,
        "segment-changed-session"
      );
      const before = await readSessionRow(db, "segment-changed-session");
      assert.equal(before.updated_at, STALE_WATERMARK);

      const collector = fakeCollector("claude", {
        sources: ["/fake/segment.jsonl"],
        parse: () => Promise.resolve([session]),
        sessionIdForSource: () => "segment-changed-session",
      });
      const summary = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });

      assert.equal(summary.rebuilt, 1);
      assert.deepEqual(summary.changedSessionIds, ["segment-changed-session"]);

      const after = await readSessionRow(db, "segment-changed-session");
      assert.equal(after.data_revision, DATA_REVISION);
      assert.equal(after.updated_at, REBUILD_CLOCK);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("(h) an EQUAL-LENGTH work_item_ref swap bumps updated_at and IS in the changed set", async () => {
    // FEA-4010 (AA-10): the child-row fingerprint sums row LENGTHS and samples
    // only the first character of the concatenation (which belongs to `phase`),
    // so a same-width slug substitution was invisible to it — and AA-10 makes
    // those its normal output. Golden `019ef60d` moves PLN-1095 → FEA-2108 on
    // both segments with the fingerprint frozen at `128:2:212`. The
    // activity-segment backfill cannot rescue it (gated on
    // ACTIVITY_CLASSIFIER_VERSION, which AA-10 does not bump), so this rebuild is
    // the only path that re-stamps such a session. Both refs below are 8
    // characters, so ONLY the ref checksum can tell them apart.
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea4010-refswap-"));
    const db = await openTestDb(dir, { now: () => REBUILD_CLOCK });
    const sessionId = "ref-swap-session";
    try {
      // The mention gives the linker a candidate, so the rebuild re-derives a
      // NON-NULL ref. That matters: a ref reverting to NULL changes the summed
      // row length and the old fingerprint already caught it — only a non-null
      // to non-null swap of the same width is invisible.
      const session = makeSession({
        sessionId,
        endedAt: IMPORT_ENDED_AT,
        userMessages: 1,
        messages: [
          {
            role: "human",
            timestamp: "2026-06-07T10:00:30.000Z",
            text: "work on FEA-2108",
          },
        ],
      });
      await db.importer.importSession(session, "claude");
      const [imported] = await db.prisma.client.$queryRawUnsafe<
        { work_item_ref: string | null }[]
      >(
        "SELECT work_item_ref FROM session_activity_segments WHERE session_id = $1",
        sessionId
      );
      assert.equal(
        imported?.work_item_ref,
        "FEA-2108",
        "precondition: the import must resolve a non-null ref"
      );
      // Tamper ONLY the ref, to a value of identical width. Every other synced
      // column — phase, span, confidence, layers, version, subagent — is
      // untouched, so the pre-AA-10 fingerprint is byte-identical across it.
      await db.run(
        "UPDATE session_activity_segments SET work_item_ref = $1 WHERE session_id = $2",
        "PLN-1095",
        sessionId
      );
      await db.run(
        "UPDATE sessions SET data_revision = $1, updated_at = $2 WHERE id = $3",
        STALE_REVISION,
        STALE_WATERMARK,
        sessionId
      );
      const before = await readSessionRow(db, sessionId);
      assert.equal(before.updated_at, STALE_WATERMARK);

      const collector = fakeCollector("claude", {
        sources: ["/fake/ref-swap.jsonl"],
        parse: () => Promise.resolve([session]),
        sessionIdForSource: () => sessionId,
      });
      const summary = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });

      assert.equal(summary.rebuilt, 1);
      assert.deepEqual(
        summary.changedSessionIds,
        [sessionId],
        "an equal-length ref swap must reach the cloud"
      );
      const after = await readSessionRow(db, sessionId);
      assert.equal(after.updated_at, REBUILD_CLOCK);
      const [restamped] = await db.prisma.client.$queryRawUnsafe<
        { work_item_ref: string | null }[]
      >(
        "SELECT work_item_ref FROM session_activity_segments WHERE session_id = $1",
        sessionId
      );
      assert.equal(restamped?.work_item_ref, "FEA-2108");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("(i) an EQUAL-LENGTH segment-boundary change bumps updated_at and IS in the changed set", async () => {
    // ISS-4591: AA-10 patched the equal-length blind spot for ONE column
    // (`work_item_ref`, via the ref checksum). It was never the only one — a
    // spike over the frozen golden corpus recorded 971 BLIND observations across
    // 53 of 56 synced columns. `end_ms` is the sharpest case the point fix does
    // not cover: epoch-millisecond boundaries are uniformly 13 digits, so a
    // re-tile that MOVES a boundary leaves the summed row length, the row count,
    // and the first sampled character (which belongs to `phase`) all identical,
    // and the ref checksum reads a different column entirely. The row digest is
    // what makes this visible.
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss4591-boundary-"));
    const db = await openTestDb(dir, { now: () => REBUILD_CLOCK });
    const sessionId = "boundary-swap-session";
    try {
      const session = makeSession({
        sessionId,
        endedAt: IMPORT_ENDED_AT,
        userMessages: 1,
      });
      await db.importer.importSession(session, "claude");
      const [imported] = await db.prisma.client.$queryRawUnsafe<
        { rowid: number; end_ms: number | bigint }[]
      >(
        "SELECT rowid, end_ms FROM session_activity_segments WHERE session_id = $1 ORDER BY rowid LIMIT 1",
        sessionId
      );
      assert.ok(imported, "precondition: the import produced a segment");
      const originalEndMs = String(imported.end_ms);
      // Move the boundary by exactly one digit so the value's WIDTH is unchanged
      // — the whole point is that only a content-sensitive digest can see it.
      const tamperedEndMs = `${originalEndMs.slice(0, -1)}${
        originalEndMs.endsWith("7") ? "3" : "7"
      }`;
      assert.equal(
        tamperedEndMs.length,
        originalEndMs.length,
        "precondition: the tampered boundary must be the same width"
      );
      assert.notEqual(tamperedEndMs, originalEndMs);
      await db.run(
        "UPDATE session_activity_segments SET end_ms = $1 WHERE rowid = $2",
        Number(tamperedEndMs),
        imported.rowid
      );
      await db.run(
        "UPDATE sessions SET data_revision = $1, updated_at = $2 WHERE id = $3",
        STALE_REVISION,
        STALE_WATERMARK,
        sessionId
      );
      const before = await readSessionRow(db, sessionId);
      assert.equal(before.updated_at, STALE_WATERMARK);

      const collector = fakeCollector("claude", {
        sources: ["/fake/boundary.jsonl"],
        parse: () => Promise.resolve([session]),
        sessionIdForSource: () => sessionId,
      });
      const summary = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });

      assert.equal(summary.rebuilt, 1);
      assert.deepEqual(
        summary.changedSessionIds,
        [sessionId],
        "an equal-length segment-boundary change must reach the cloud"
      );
      const after = await readSessionRow(db, sessionId);
      assert.equal(after.updated_at, REBUILD_CLOCK);
      const [restamped] = await db.prisma.client.$queryRawUnsafe<
        { end_ms: number | bigint }[]
      >(
        "SELECT end_ms FROM session_activity_segments WHERE rowid = $1",
        imported.rowid
      );
      assert.equal(
        String(restamped?.end_ms),
        originalEndMs,
        "the rebuild restored the correctly-derived boundary"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("FEA-3419 stale rows rebuild to typed TTL cost once and expose an ISO sync watermark", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea3419-revision-"));
    const db = await openTestDb(dir, { now: () => REBUILD_CLOCK });
    const sessionId = "ttl-revision-session";
    const oneHourTokens = 90_091;
    type UsageRow = {
      cache_write_5m_tokens: number | bigint | null;
      cache_write_1h_tokens: number | bigint | null;
      cost_usd_estimated: number | null;
    };
    const readUsage = async (): Promise<UsageRow> => {
      const [row] = await db.prisma.client.$queryRawUnsafe<UsageRow[]>(
        `SELECT cache_write_5m_tokens, cache_write_1h_tokens,
                cost_usd_estimated
         FROM token_usage WHERE session_id = $1`,
        sessionId
      );
      assert.ok(row);
      return row;
    };
    const session = (withTtl: boolean) =>
      makeSession({
        sessionId,
        model: "claude-fable-5",
        endedAt: IMPORT_ENDED_AT,
        tokensByModel: {
          "claude-fable-5": {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: oneHourTokens,
            ...(withTtl
              ? { cacheWriteTtl: { fiveM: 0, oneH: oneHourTokens } }
              : {}),
          },
        },
        tokenSeries: [],
      });

    try {
      // Simulate the pre-FEA-3419 row: the aggregate exists, provenance is
      // absent, and the library's five-minute rate is persisted.
      await db.importer.importSession(session(false), "claude");
      const before = await readUsage();
      assert.equal(before.cache_write_5m_tokens, null);
      assert.equal(before.cache_write_1h_tokens, null);
      assert.ok(
        Math.abs(Number(before.cost_usd_estimated) - 1.126_137_5) < 1e-9
      );
      await db.run(
        "UPDATE sessions SET data_revision = $1, updated_at = $2 WHERE id = $3",
        DATA_REVISION - 1,
        STALE_WATERMARK,
        sessionId
      );

      const collector = fakeCollector("claude", {
        sources: ["/fake/ttl-revision.jsonl"],
        parse: () => Promise.resolve([session(true)]),
        sessionIdForSource: () => sessionId,
      });
      const first = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });
      assert.equal(first.rebuilt, 1);
      assert.deepEqual(first.changedSessionIds, [sessionId]);

      const after = await readUsage();
      assert.equal(Number(after.cache_write_5m_tokens), 0);
      assert.equal(Number(after.cache_write_1h_tokens), oneHourTokens);
      assert.ok(Math.abs(Number(after.cost_usd_estimated) - 1.801_82) < 1e-9);
      const rebuiltSession = await readSessionRow(db, sessionId);
      assert.equal(rebuiltSession.data_revision, DATA_REVISION);
      assert.equal(rebuiltSession.updated_at, REBUILD_CLOCK);

      const visibleToSync = await db.syncSource.listUpdatedSessionCursorRows(
        REBUILD_CLOCK,
        []
      );
      assert.deepEqual(visibleToSync, [
        { id: sessionId, updated_at: REBUILD_CLOCK },
      ]);

      // A second pass has no stale candidate and cannot rewrite the ISO cursor
      // or accumulate the premium.
      const second = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });
      assert.equal(second.staleTotal, 0);
      assert.equal(second.rebuilt, 0);
      assert.deepEqual(second.changedSessionIds, []);
      assert.deepEqual(await readUsage(), after);
      assert.deepEqual(await readSessionRow(db, sessionId), rebuiltSession);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("(j) a corrected last_activity_at with a byte-identical metadata blob bumps updated_at and IS in the changed set", async () => {
    // ISS-5497 (review): `sessions.last_activity_at` is in NEITHER fingerprint —
    // it is not a `buildImportMetadata` key and it is not a child row — and until
    // this ticket it could not change on its own during a rebuild, so its absence
    // cost nothing. Revision 75 re-derives exactly that column and nothing else
    // for a session whose events fold to a different winner, so without folding
    // it into the change signal the rebuild would score the correction as
    // unchanged, skip the watermark bump, and strand the corrected sort key
    // locally under the preserved cursor. Same tampering strategy as (f)/(g),
    // applied to the `sessions` column itself.
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss5497-lastact-"));
    const db = await openTestDb(dir, { now: () => REBUILD_CLOCK });
    const sessionId = "last-activity-changed-session";
    try {
      const session = makeSession({
        sessionId,
        endedAt: IMPORT_ENDED_AT,
        userMessages: 1,
      });
      await db.importer.importSession(session, "claude");
      // Tamper the stored cursor so the clean re-derivation differs from it,
      // while the parsed session — hence the metadata blob AND every child row —
      // is unchanged.
      await db.run(
        "UPDATE sessions SET last_activity_at = $1 WHERE id = $2",
        "2026-06-01T00:00:00.000Z",
        sessionId
      );
      await db.run(
        "UPDATE sessions SET data_revision = $1, updated_at = $2 WHERE id = $3",
        STALE_REVISION,
        STALE_WATERMARK,
        sessionId
      );
      const before = await readSessionRow(db, sessionId);
      assert.equal(before.updated_at, STALE_WATERMARK);

      const collector = fakeCollector("claude", {
        sources: ["/fake/last-activity.jsonl"],
        parse: () => Promise.resolve([session]),
        sessionIdForSource: () => sessionId,
      });
      const summary = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });

      assert.equal(summary.rebuilt, 1);
      assert.deepEqual(summary.changedSessionIds, [sessionId]);

      const after = await readSessionRow(db, sessionId);
      assert.equal(after.data_revision, DATA_REVISION);
      assert.equal(after.updated_at, REBUILD_CLOCK);
      const [row] = await db.prisma.client.$queryRawUnsafe<
        { last_activity_at: string }[]
      >("SELECT last_activity_at FROM sessions WHERE id = $1", sessionId);
      assert.notEqual(row.last_activity_at, "2026-06-01T00:00:00.000Z");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("FEA-3659 Part 2 — targeted enqueue + cursor survival (no stranding, no corpus re-walk)", () => {
  test("(c)+(d) mixed corpus: only genuinely-changed rows enqueue; cursor survives the bump", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea3659-e2e-"));
    const db = await openTestDb(dir, { now: () => REBUILD_CLOCK });
    const computeTargetId = "org:user:target-e2e";
    const sourceKey = buildAgentSessionSyncSourceKey(computeTargetId);
    try {
      // Seed 4 sessions, all stamped at the stale revision.
      const ids = [
        "s-unchanged-1",
        "s-unchanged-2",
        "s-changed-1",
        "s-changed-2",
      ];
      for (const id of ids) {
        await db.importer.importSession(
          makeSession({
            sessionId: id,
            endedAt: IMPORT_ENDED_AT,
            userMessages: 1,
          }),
          "claude"
        );
      }
      await db.run(
        "UPDATE sessions SET data_revision = $1, updated_at = $2 WHERE id IN ($3, $4, $5, $6)",
        STALE_REVISION,
        STALE_WATERMARK,
        ...ids
      );

      // Persist a durable cursor stamped under the STALE revision — the FEA-3659
      // relaxation must load it (not discard it) despite the revision mismatch.
      const persistedState = {
        observedTopUpdatedAt: "2026-06-07T09:00:00.000Z",
        observedIdsAtTopUpdatedAt: ["s-unchanged-1"],
        deadLetteredIds: [] as string[],
      };
      await db.syncSource.advanceSyncState?.(sourceKey, persistedState);
      await db.run(
        "UPDATE sync_state SET data_revision = $1 WHERE source_key = $2",
        STALE_REVISION,
        sourceKey
      );

      // (d) cursor survives the bump.
      const loaded = await db.syncSource.loadSyncState?.(sourceKey);
      assert.deepEqual(loaded, persistedState, "cursor survives revision bump");

      // Two sessions re-derive to an identical payload (no-op), two to a changed
      // payload (userMessages differs).
      const collector = fakeCollector("claude", {
        sources: ids.map((id) => `/fake/${id}.jsonl`),
        parse: (source) => {
          const id = path.basename(source, ".jsonl");
          const changed = id.startsWith("s-changed");
          return Promise.resolve([
            makeSession({
              sessionId: id,
              endedAt: IMPORT_ENDED_AT,
              userMessages: changed ? 9 : 1,
            }),
          ]);
        },
        sessionIdForSource: (source) => path.basename(source, ".jsonl"),
      });
      const summary = await runDataRevisionRebuild({
        collectors: [collector],
        db,
      });

      assert.equal(summary.rebuilt, 4, "all four re-derived");
      // (c) exactly the two changed ids are in the changed set; none stranded, no
      // over-collection of the byte-identical rows.
      assert.deepEqual(summary.changedSessionIds.toSorted(), [
        "s-changed-1",
        "s-changed-2",
      ]);

      // Simulate the runtime's explicit enqueue of the changed set into the outbox.
      await db.syncSource.enqueueOutboxEntries?.(
        sourceKey,
        summary.changedSessionIds.map((externalSessionId) => ({
          externalSessionId,
          syncClass: "backfill" as const,
        }))
      );

      const pending = await db.syncSource.loadPendingOutboxIds?.(sourceKey);
      assert.deepEqual(
        pending?.toSorted(),
        ["s-changed-1", "s-changed-2"],
        "only the changed ids are durably enqueued for sync"
      );

      // The unchanged rows kept their original watermark; the changed rows advanced.
      for (const id of ids) {
        const row = await readSessionRow(db, id);
        assert.equal(row.data_revision, DATA_REVISION);
        if (id.startsWith("s-changed")) {
          assert.equal(row.updated_at, REBUILD_CLOCK);
        } else {
          assert.equal(row.updated_at, STALE_WATERMARK);
        }
      }
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("(e) enqueue is idempotent and crash-safe: re-enqueue is a no-op upsert and never resurrects a dead-lettered row", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fea3659-idem-"));
    const db = await openTestDb(dir);
    const sourceKey = buildAgentSessionSyncSourceKey("org:user:target-idem");
    try {
      const changed = ["c-1", "c-2"];
      const entries = changed.map((externalSessionId) => ({
        externalSessionId,
        syncClass: "backfill" as const,
      }));

      // First enqueue.
      await db.syncSource.enqueueOutboxEntries?.(sourceKey, entries);
      // Mark one row dead_lettered (simulating an abandoned session).
      await db.run(
        "UPDATE agent_session_sync_outbox SET status = $1 WHERE source_key = $2 AND external_session_id = $3",
        OutboxStatus.DeadLettered,
        sourceKey,
        "c-1"
      );

      // Re-enqueue the SAME set (a crash/retry after rebuild re-runs the enqueue).
      await db.syncSource.enqueueOutboxEntries?.(sourceKey, entries);

      // c-2 is still pending exactly once; c-1 stays dead_lettered (not resurrected).
      const pending = await db.syncSource.loadPendingOutboxIds?.(sourceKey);
      assert.deepEqual(
        pending,
        ["c-2"],
        "re-enqueue does not duplicate or resurrect"
      );

      const [deadRow] = await db.prisma.client.$queryRawUnsafe<
        { status: string }[]
      >(
        "SELECT status FROM agent_session_sync_outbox WHERE source_key = $1 AND external_session_id = $2",
        sourceKey,
        "c-1"
      );
      assert.equal(deadRow.status, OutboxStatus.DeadLettered);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("FEA-3659 Part 3 — offline → no enqueue (honor the offline/no-op contract)", () => {
  // Fix 1: the runtime's data-revision enqueue must use the ONLINE-AWARE compute
  // target. `resolveRebuildSyncComputeTargetId` is the extracted decision the
  // enqueue guard keys on: null (offline/unauthenticated) → the guard no-ops, so
  // no outbox rows are written under a stale `lastComputeTargetId` that would
  // strand them under the wrong source key across an account switch.
  test("offline (getSyncComputeTargetId → null) resolves to null even when the stale getComputeTargetId still has a value", () => {
    const resolved = resolveRebuildSyncComputeTargetId({
      // ONLINE-AWARE getter: null while offline.
      getSyncComputeTargetId: () => null,
      // Stale fallback still carries the last-known target (offline
      // trace-comment/component reads need it) — but it must NOT be used here.
      getComputeTargetId: () => "org:user:stale-last-known",
    });
    assert.equal(
      resolved,
      null,
      "offline must resolve to null, never the stale lastComputeTargetId"
    );
  });

  test("online (getSyncComputeTargetId → id) resolves to the live target so the enqueue keys the same source as the sync service reads", () => {
    const resolved = resolveRebuildSyncComputeTargetId({
      getSyncComputeTargetId: () => "org:user:live-target",
      getComputeTargetId: () => "org:user:stale-last-known",
    });
    assert.equal(resolved, "org:user:live-target");
    // Same source key the sync service's resolveSyncSourceKey builds, so the
    // enqueued rows are actually read back when online.
    assert.equal(
      buildAgentSessionSyncSourceKey(resolved as string),
      buildAgentSessionSyncSourceKey("org:user:live-target")
    );
  });

  test("legacy caller (no online-aware getter wired) falls back to getComputeTargetId", () => {
    const resolved = resolveRebuildSyncComputeTargetId({
      getComputeTargetId: () => "org:user:legacy",
    });
    assert.equal(resolved, "org:user:legacy");
  });
});
