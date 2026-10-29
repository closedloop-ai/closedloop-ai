/**
 * @file legacy-message-agent-turn-bucket-heal.test.ts
 * @description ISS-8259 — `recomputeLegacyMessageAgentTurnBuckets`, the boot
 * pass that carries the restored legacy `$.messages` Agent fallback onto an
 * ALREADY-imported corpus.
 *
 * The derivation change alone is inert on an existing install, and the gap is
 * not obvious: `backfillSessionTurnBuckets` selects only sessions with NO
 * buckets, and a token-event-less session that is not headless already has its
 * `human` rows, so it is skipped; `recomputeHeadlessTurnBuckets` selects only
 * HEADLESS sessions carrying a stale `human` bucket, which is the complementary
 * half. Between them a `codex-tui`-class session with one assistant message and
 * no round-trip series would keep reporting zero Agent turns forever — the
 * desktop half of the cross-surface fork this ticket closes — because nothing
 * reprocesses a finished session.
 *
 * Pinned here: the pass HEALS that shape, LEAVES a session with a populated
 * `$.tokenSeries` alone, CONVERGES, and is actually WIRED into the boot chain.
 *
 * ISS-8398 gave the pass two more shapes, both of them a session whose
 * assistant timestamp is ZONE-LESS — which that ticket began reading as UTC
 * instead of rejecting. The derivation change is likewise inert on an
 * already-imported corpus without this pass, so both are pinned here:
 *  - ALL-zone-less, which has no agent bucket and the original selector found;
 *  - MIXED (one canonical row, one zone-less), which already HAS an agent
 *    bucket and the original selector therefore skipped (whitlockk review). Closing
 *    it replaced the `NOT EXISTS (… turn_kind='agent')` clause with a
 *    derived-vs-stored comparison, so convergence is now a property of the ROWS
 *    rather than of the selector — which is why every case here asserts a
 *    second pass writes nothing.
 * The wiring is asserted on the resolved AST rather than the raw source text,
 * per AGENTS.md → "Test Practices".
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path, { join } from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status.js";
import ts from "typescript6";
import { test } from "vitest";
import { recomputeLegacyMessageAgentTurnBuckets } from "../src/main/database/session-analytics-maintenance.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-06-21T12:00:00.000Z";
const TS = "2026-06-20T08:00:00.000Z";
const ASSISTANT_TS = "2026-06-20T08:01:00.000Z";

const BOOT_MAINTENANCE_PATH = join(
  import.meta.dirname,
  "../src/main/database/boot-maintenance.ts"
);

const HEAL_FN = "recomputeLegacyMessageAgentTurnBuckets";

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8259-legacy-heal-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  return { db, dir };
}

async function bucketsFor(
  db: SqliteDb,
  id: string
): Promise<{ turn_kind: string; turn_count: number }[]> {
  return await db.prisma.client.$queryRawUnsafe<
    { turn_kind: string; turn_count: number }[]
  >(
    `SELECT turn_kind, turn_count FROM session_turn_bucket
      WHERE session_id = $1 ORDER BY turn_kind`,
    id
  );
}

test("ISS-8259: the heal reaches a no-series session that already has human buckets", async () => {
  const { db, dir } = await openTempDb();
  try {
    // Quiesce the boot chain BEFORE seeding — it runs this same pass, and if it
    // lands after the seeds it heals them first, leaving the direct call below
    // nothing to do and no "complete" log to assert on.
    await db.whenBootMaintenanceSettled();
    await db.run("DELETE FROM session_turn_bucket");

    // The 7da87bc7 shape: interactive `codex-tui`, one assistant + one human
    // message, and NO round-trip series. The cloud's agentLegacyMessageRowsSql
    // counts the assistant row; before this ticket the desktop counted nothing.
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-legacy', 'completed', 'codex', $1, $1, $2)`,
      TS,
      `{"entrypoint":"codex-tui","messages":[{"role":"assistant","timestamp":"${ASSISTANT_TS}"},{"role":"human","timestamp":"${TS}"}],"tokenSeries":[]}`
    );
    // A session that DID sync round-trips. Its agent rows come from the series,
    // so the fallback must never run for it — and neither must this pass, whose
    // predicate is the same token-event gate.
    //
    // The `token_events` row is what makes this the shape the IMPORTER produces:
    // it writes one row per `$.tokenSeries` entry, so a series-bearing session
    // always has token events. Seeding the metadata without them would describe
    // a partial store and would now (correctly, per the ISS-8259 review) be
    // healed from `$.messages` — see the mixed-series/no-event case below, which
    // pins exactly that.
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-series', 'completed', 'claude_code', $1, $1, $2)`,
      TS,
      `{"entrypoint":"cli","messages":[{"role":"assistant","timestamp":"${ASSISTANT_TS}"},{"role":"human","timestamp":"${TS}"}],"tokenSeries":[{"timestamp":"${ASSISTANT_TS}","model":"m","input":1,"output":1}]}`
    );
    await db.run(
      `INSERT INTO token_events
         (session_id, model, created_at, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens)
       VALUES ('sess-series', 'm', $1, 1, 1, 0, 0)`,
      ASSISTANT_TS
    );

    // The pre-ISS-8259 materialized state: `sess-legacy` has only its human row
    // (which is exactly why backfillSessionTurnBuckets skips it), and
    // `sess-series` is deliberately left with NO agent bucket so a pass that
    // ignored the tokenSeries gate would visibly rewrite it.
    await db.run(
      `INSERT INTO session_turn_bucket (session_id, ts, turn_kind, turn_count)
       VALUES ('sess-legacy', $1, 'human', 1), ('sess-series', $1, 'human', 1)`,
      TS
    );

    const logs: string[] = [];
    await recomputeLegacyMessageAgentTurnBuckets(db.prisma, (m) =>
      logs.push(m)
    );

    // Healed: the assistant message is now an Agent turn, and the human row it
    // already had survives the rebuild.
    assert.deepEqual(await bucketsFor(db, "sess-legacy"), [
      { turn_kind: "agent", turn_count: 1 },
      { turn_kind: "human", turn_count: 1 },
    ]);
    // Untouched: a session that synced token events is outside the predicate, so
    // its (deliberately incomplete) bucket set is left exactly as seeded.
    assert.deepEqual(await bucketsFor(db, "sess-series"), [
      { turn_kind: "human", turn_count: 1 },
    ]);
    assert.ok(
      logs.some((m) =>
        m.includes("legacy-message agent turn-bucket recompute complete")
      ),
      "the pass must report what it healed"
    );

    // Convergent: `sess-legacy`'s stored rows now equal its derived ones, so a
    // second pass writes nothing and logs nothing. It is still SELECTED — the
    // agent-bucket exclusion that used to carry this is gone (ISS-8398).
    const logs2: string[] = [];
    await recomputeLegacyMessageAgentTurnBuckets(db.prisma, (m) =>
      logs2.push(m)
    );
    assert.equal(logs2.length, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-8398: the heal carries the zone-less reading onto an already-imported session", async () => {
  // ISS-8398 is INERT on an existing install without this pass, and that is the
  // only thing making it non-inert — so the claim is pinned here rather than
  // asserted in a docstring. The selector this rests on (no token events, plus
  // a derived-vs-stored difference) is one predicate edit away from silently
  // not covering this shape.
  //
  // The shape: a finished, already-imported session whose ONLY assistant message
  // carries a zone-less timestamp, already holding its `human` bucket — which is
  // precisely why `backfillSessionTurnBuckets` (no buckets at all) skips it and
  // `recomputeHeadlessTurnBuckets` (headless only) skips it too.
  const { db, dir } = await openTempDb();
  try {
    await db.whenBootMaintenanceSettled();
    await db.run("DELETE FROM session_turn_bucket");

    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-zoneless', 'completed', 'codex', $1, $1, $2)`,
      TS,
      '{"entrypoint":"codex-tui","messages":[{"role":"assistant","timestamp":"2026-06-20T08:01:00"},{"role":"human","timestamp":"2026-06-20T08:00:00.000Z"}],"tokenSeries":[]}'
    );
    await db.run(
      `INSERT INTO session_turn_bucket (session_id, ts, turn_kind, turn_count)
       VALUES ('sess-zoneless', $1, 'human', 1)`,
      TS
    );

    await recomputeLegacyMessageAgentTurnBuckets(db.prisma, () => {
      // intentionally unread — this case asserts the rows, not the log
    });

    assert.deepEqual(
      await bucketsFor(db, "sess-zoneless"),
      [
        { turn_kind: "agent", turn_count: 1 },
        { turn_kind: "human", turn_count: 1 },
      ],
      "the zone-less assistant row heals into an Agent bucket"
    );
    // And at the UTC instant the text names, not the host's reading of it. This
    // suite does NOT pin a TZ, so a host-local parse would make the stored value
    // depend on whichever machine ran the heal — the exact non-determinism
    // ISS-8398 removed.
    const [row] = await db.prisma.client.$queryRawUnsafe<{ ts: string }[]>(
      `SELECT ts FROM session_turn_bucket
        WHERE session_id = 'sess-zoneless' AND turn_kind = 'agent'`
    );
    assert.equal(row?.ts, "2026-06-20T08:01:00.000Z");

    // Convergent on the new shape too. The session is still SELECTED on the
    // second pass — the agent-bucket clause that used to exclude it is gone —
    // but its stored rows now equal its derived rows, so nothing is written and
    // nothing is logged.
    const logs2: string[] = [];
    await recomputeLegacyMessageAgentTurnBuckets(db.prisma, (m) =>
      logs2.push(m)
    );
    assert.equal(logs2.length, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-8398: the heal reaches a MIXED session that already holds an agent bucket", async () => {
  // whitlockk review. The shape the old selector could not see: one CANONICAL
  // assistant row and one ZONE-LESS one in the same session. The canonical row
  // had already produced an `agent` bucket at import, so the old
  // `NOT EXISTS (… turn_kind='agent')` clause read that bucket as proof the
  // session was current and skipped it — leaving the zone-less turn uncounted
  // on an upgraded install forever, while a fresh import of the identical
  // session counted both. That is a cross-surface fork against the cloud, which
  // counts both from `$.messages`.
  //
  // What replaced the clause is a comparison of DERIVED against STORED rows, so
  // this pins both halves: the repair happens, AND it converges without a
  // `*_backfill_seen` marker.
  const { db, dir } = await openTempDb();
  try {
    await db.whenBootMaintenanceSettled();
    await db.run("DELETE FROM session_turn_bucket");

    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-mixed', 'completed', 'codex', $1, $1, $2)`,
      TS,
      '{"entrypoint":"codex-tui","messages":[{"role":"assistant","timestamp":"2026-06-20T08:01:00.000Z"},{"role":"assistant","timestamp":"2026-06-20T09:02:00"},{"role":"human","timestamp":"2026-06-20T08:00:00.000Z"}],"tokenSeries":[]}'
    );
    // The pre-upgrade state: the canonical assistant row is bucketed, the
    // zone-less one is not. This is what an install that ran the ISS-8259 heal
    // before ISS-8398 shipped actually holds.
    await db.run(
      `INSERT INTO session_turn_bucket (session_id, ts, turn_kind, turn_count)
       VALUES ('sess-mixed', $1, 'human', 1), ('sess-mixed', $2, 'agent', 1)`,
      TS,
      ASSISTANT_TS
    );

    await recomputeLegacyMessageAgentTurnBuckets(db.prisma, () => {
      // intentionally unread — this case asserts the rows, not the log
    });

    assert.deepEqual(
      await db.prisma.client.$queryRawUnsafe<
        { ts: string; turn_kind: string }[]
      >(
        `SELECT ts, turn_kind FROM session_turn_bucket
          WHERE session_id = 'sess-mixed' ORDER BY turn_kind, ts`
      ),
      [
        { ts: "2026-06-20T08:01:00.000Z", turn_kind: "agent" },
        { ts: "2026-06-20T09:02:00.000Z", turn_kind: "agent" },
        { ts: TS, turn_kind: "human" },
      ],
      "the zone-less assistant row is added WITHOUT losing the canonical one"
    );

    // Convergence, which is the whole reason this needs no marker table: the
    // session still matches the selector, but its rows now equal the derivation
    // so the second pass writes nothing and logs nothing. A non-convergent
    // implementation would DELETE-and-INSERT these same rows on every boot.
    const logs: string[] = [];
    await recomputeLegacyMessageAgentTurnBuckets(db.prisma, (m) =>
      logs.push(m)
    );
    assert.equal(logs.length, 0, "a healed mixed session is not rewritten");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-9864: the heal carries a >100-message session past the old 100-row window", async () => {
  // The shape the ruling names: a session that synced NO token events and holds
  // more than `MAX_METADATA_MESSAGES` assistant rows. An install that ran the
  // ISS-8259 heal before ISS-9864 shipped bucketed it at 100 (the window the
  // derivation used to apply to match the cloud). There is no DATA_REVISION
  // bump — the metadata is unchanged, only the derivation reading it — so this
  // pass is the ONLY thing that carries the correction onto an existing store.
  const { db, dir } = await openTempDb();
  try {
    await db.whenBootMaintenanceSettled();
    await db.run("DELETE FROM session_turn_bucket");

    const messages = Array.from({ length: 150 }, (_, i) => ({
      role: "assistant",
      timestamp: `2026-06-20T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
    }));
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-long-legacy', $1, 'codex', $2, $2, $3)`,
      SESSION_STATUS.INACTIVE,
      TS,
      JSON.stringify({ entrypoint: "codex-tui", messages, tokenSeries: [] })
    );
    // The pre-upgrade state: the first 100 rows bucketed (each at its own
    // minute-distinct instant, so 100 rows of count 1), rows 101-150 absent.
    for (const row of messages.slice(0, 100)) {
      await db.run(
        `INSERT INTO session_turn_bucket (session_id, ts, turn_kind, turn_count)
         VALUES ('sess-long-legacy', $1, 'agent', 1)`,
        row.timestamp
      );
    }

    await recomputeLegacyMessageAgentTurnBuckets(db.prisma, () => {
      // intentionally unread — this case asserts the rows, not the log
    });

    const total = (
      await db.prisma.client.$queryRawUnsafe<{ total: number | bigint }[]>(
        `SELECT COALESCE(SUM(turn_count), 0) AS total FROM session_turn_bucket
          WHERE session_id = 'sess-long-legacy' AND turn_kind = 'agent'`
      )
    )[0];
    assert.equal(Number(total.total), 150, "every assistant row is bucketed");

    // Convergence: the second pass sees derived == stored and writes nothing.
    const logs: string[] = [];
    await recomputeLegacyMessageAgentTurnBuckets(db.prisma, (m) =>
      logs.push(m)
    );
    assert.equal(logs.length, 0, "a healed long session is not rewritten");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-8259: one malformed metadata row does not abort the whole heal", async () => {
  const { db, dir } = await openTempDb();
  try {
    await db.whenBootMaintenanceSettled();
    await db.run("DELETE FROM session_turn_bucket");

    // `json_extract` RAISES on invalid JSON, so an unguarded selector would throw
    // on this row and heal NOTHING — and the boot chain's `.catch` would swallow
    // it, leaving every other target stale with no signal. The healable session is
    // inserted AFTER it so a row-order-dependent abort is caught too.
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-bad', 'completed', 'claude_code', $1, $1, '{not valid json')`,
      TS
    );
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-ok', 'completed', 'codex', $1, $1, $2)`,
      TS,
      `{"entrypoint":"codex-tui","messages":[{"role":"assistant","timestamp":"${ASSISTANT_TS}"}],"tokenSeries":[]}`
    );

    const logs: string[] = [];
    await recomputeLegacyMessageAgentTurnBuckets(db.prisma, (m) =>
      logs.push(m)
    );

    assert.deepEqual(
      await bucketsFor(db, "sess-ok"),
      [{ turn_kind: "agent", turn_count: 1 }],
      "the valid session must heal despite the malformed neighbour"
    );
    assert.deepEqual(await bucketsFor(db, "sess-bad"), []);
    assert.ok(
      logs.every((m) => !m.includes("failed")),
      `the pass must not report a failure: ${logs.join(" | ")}`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-8259: a human-only session is never REWRITTEN, boot after boot", async () => {
  const { db, dir } = await openTempDb();
  try {
    await db.whenBootMaintenanceSettled();
    await db.run("DELETE FROM session_turn_bucket");

    // Satisfies every SQL clause — messages, no series, no token events, no agent
    // bucket — but derives no agent row, so it can never stop matching. Rebuild is
    // DELETE-then-INSERT, so selecting it would rewrite its existing human rows on
    // every boot for the life of the install. It must be filtered before the write.
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-humanonly', 'completed', 'claude_code', $1, $1, $2)`,
      TS,
      `{"entrypoint":"cli","messages":[{"role":"human","timestamp":"${TS}"}],"tokenSeries":[]}`
    );
    await db.run(
      `INSERT INTO session_turn_bucket (session_id, ts, turn_kind, turn_count)
       VALUES ('sess-humanonly', $1, 'human', 1)`,
      TS
    );

    for (const pass of [1, 2]) {
      const logs: string[] = [];
      await recomputeLegacyMessageAgentTurnBuckets(db.prisma, (m) =>
        logs.push(m)
      );
      assert.equal(
        logs.length,
        0,
        `pass ${pass}: nothing to write, so nothing is written or logged`
      );
    }
    assert.deepEqual(
      await bucketsFor(db, "sess-humanonly"),
      [{ turn_kind: "human", turn_count: 1 }],
      "its existing human bucket is left exactly as it was"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-8259: a populated series with NO token events is healed from $.messages", async () => {
  // The mixed-series/no-event parity case (ISS-8259 review, davetho).
  //
  // The cloud splits on token-event presence ALONE: `agentLegacyMessageRowsSql`
  // fires whenever `NOT EXISTS (… agent_session_token_events …)`, whatever
  // `$.tokenSeries` holds. An earlier revision of this pass ANDed an
  // empty-series clause onto the gate, so a session in this state was skipped
  // here and read its series in `deriveSessionTurnBuckets` — two surfaces, two
  // sources, on the one population this ticket exists to reconcile.
  //
  // The importer cannot produce this state (it writes one token event per series
  // entry), but a partial or interrupted import can, and in that state the cloud
  // has no token events either — so `$.messages` is what BOTH sides count.
  const { db, dir } = await openTempDb();
  try {
    await db.whenBootMaintenanceSettled();
    await db.run("DELETE FROM session_turn_bucket");

    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-mixed', 'completed', 'claude_code', $1, $1, $2)`,
      TS,
      `{"entrypoint":"cli","messages":[{"role":"assistant","timestamp":"${ASSISTANT_TS}"}],"tokenSeries":[{"timestamp":"${ASSISTANT_TS}","model":"m","input":1,"output":1}]}`
    );

    await recomputeLegacyMessageAgentTurnBuckets(db.prisma, () => {
      // no-op
    });

    // One agent turn, from the ASSISTANT MESSAGE — the same basis and the same
    // count the cloud reports for a session with no token-event rows.
    assert.deepEqual(await bucketsFor(db, "sess-mixed"), [
      { turn_kind: "agent", turn_count: 1 },
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** A query that materializes the metadata VALUE, as opposed to the id-only
 * selector or the packer's `length(CAST(metadata AS BLOB))` size probe. */
const MATERIALIZES_METADATA_RE = /SELECT\s+(?:s\.)?id,\s*(?:s\.)?metadata/i;

test("ISS-8259: metadata is read per chunk, never for every candidate at once", async () => {
  // The heal's candidates are, by construction, sessions carrying a $.messages
  // array — and the LOCAL blob is not truncated, so on an upgraded install with
  // a large legacy history "select id and metadata for every candidate" is a
  // corpus-sized allocation made BEFORE the byte budget has bounded anything.
  // That is the invariant in src/main/database/AGENTS.md and the shape that OOMs
  // the db-host process; a budget can only hold if the read it governs comes
  // after it.
  const { db, dir } = await openTempDb();
  try {
    await db.whenBootMaintenanceSettled();
    await db.run("DELETE FROM session_turn_bucket");

    for (const n of [1, 2, 3]) {
      await db.run(
        `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
         VALUES ($1, 'completed', 'codex', $2, $2, $3)`,
        `sess-chunk-${n}`,
        TS,
        `{"entrypoint":"codex-tui","messages":[{"role":"assistant","timestamp":"${ASSISTANT_TS}"}],"tokenSeries":[]}`
      );
    }

    const reads: { sql: string; params: unknown[] }[] = [];
    const client = new Proxy(db.prisma.client, {
      get(target, prop, receiver) {
        if (prop !== "$queryRawUnsafe") {
          return Reflect.get(target, prop, receiver);
        }
        return (sql: string, ...params: unknown[]) => {
          reads.push({ sql, params });
          return target.$queryRawUnsafe(sql, ...params);
        };
      },
    });
    const recording = new Proxy(db.prisma, {
      get(target, prop, receiver) {
        if (prop === "client") {
          return client;
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    // One session per chunk, so "per chunk" and "all at once" are distinguishable.
    await recomputeLegacyMessageAgentTurnBuckets(
      recording,
      () => {
        // no-op
      },
      1
    );

    const metadataReads = reads.filter((r) =>
      MATERIALIZES_METADATA_RE.test(r.sql)
    );
    assert.equal(metadataReads.length, 3, "one metadata read per chunk");
    for (const read of metadataReads) {
      // The load-bearing half: an UNPARAMETERIZED metadata select is unbounded
      // by definition — it is the whole candidate set. Each read here is
      // restricted to its chunk's ids, so it is bounded by the packer's budget.
      assert.ok(
        read.params.length >= 1 && read.params.length <= 1,
        `metadata read must be restricted to its chunk, got ${read.params.length} id(s)`
      );
    }

    // ...and the pass still did its job.
    for (const n of [1, 2, 3]) {
      assert.deepEqual(await bucketsFor(db, `sess-chunk-${n}`), [
        { turn_kind: "agent", turn_count: 1 },
      ]);
    }
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-8259: a session with synthesized token events is never selected", async () => {
  const { db, dir } = await openTempDb();
  try {
    await db.whenBootMaintenanceSettled();
    await db.run("DELETE FROM session_turn_bucket");

    // Empty `$.tokenSeries` but a real `token_events` row — the shape the
    // importer produces from `$.tokensByModel`. Those rows sync, so the CLOUD
    // takes its round-trip arm, not its `$.messages` fallback. Selecting this
    // session would over-count the desktop, and because the rebuild correctly
    // emits no agent row it would also be re-scanned on every boot forever.
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-synth', 'completed', 'claude_code', $1, $1, $2)`,
      TS,
      `{"entrypoint":"cli","messages":[{"role":"assistant","timestamp":"${ASSISTANT_TS}"}],"tokenSeries":[]}`
    );
    await db.run(
      `INSERT INTO token_events
         (session_id, model, created_at, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens)
       VALUES ('sess-synth', 'm', $1, 1, 1, 0, 0)`,
      ASSISTANT_TS
    );

    const logs: string[] = [];
    await recomputeLegacyMessageAgentTurnBuckets(db.prisma, (m) =>
      logs.push(m)
    );
    assert.equal(logs.length, 0, "no selection, so no work and no log");
    assert.deepEqual(await bucketsFor(db, "sess-synth"), []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-8259: a session with no messages at all is never selected", async () => {
  const { db, dir } = await openTempDb();
  try {
    await db.whenBootMaintenanceSettled();
    await db.run("DELETE FROM session_turn_bucket");

    // The KNOWN LIMIT population: an OTel-only Codex row carries neither
    // `$.messages` nor `$.tokenSeries`, so it has nothing to derive from. The
    // `$.messages` length pre-filter must keep it out of the selection entirely
    // — otherwise it would be re-scanned and re-rebuilt on EVERY boot forever.
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-otel', 'completed', 'codex', $1, $1, $2)`,
      TS,
      '{"source":"codex_otel"}'
    );

    const logs: string[] = [];
    await recomputeLegacyMessageAgentTurnBuckets(db.prisma, (m) =>
      logs.push(m)
    );
    assert.equal(logs.length, 0, "no selection, so no work and no log");
    assert.deepEqual(await bucketsFor(db, "sess-otel"), []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-8259: the boot-maintenance chain WIRES the heal pass", () => {
  const source = parseTypeScriptFile(BOOT_MAINTENANCE_PATH);
  let imported = false;
  let called = false;
  forEachNode(source, (node) => {
    if (ts.isImportSpecifier(node) && node.name.text === HEAL_FN) {
      imported = true;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === HEAL_FN
    ) {
      called = true;
    }
  });
  assert.ok(imported, `${HEAL_FN} must be imported by boot-maintenance.ts`);
  assert.ok(
    called,
    `${HEAL_FN} must be CALLED in the boot chain — the derivation fix is inert on an existing install without it`
  );
});

test("ISS-8659: the legacy agent fallback skips a fork's replayed messages", async () => {
  const { db, dir } = await openTempDb();
  try {
    await db.whenBootMaintenanceSettled();
    await db.run("DELETE FROM session_turn_bucket");

    // A `/fork` child observed before it produced anything of its own. This is
    // not a hypothetical shape: the ISS-8659 `replayedStartedAt` fallback exists
    // so such a session still ingests, and a session with no own record has no
    // own token events BY CONSTRUCTION -- which is precisely this arm's
    // predicate. Two inherited assistant turns from the parent, one own.
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-fork', 'completed', 'claude_code', $1, $1, $2)`,
      TS,
      `{"entrypoint":"cli","messages":[{"role":"assistant","timestamp":"${TS}","isForkReplayed":true},{"role":"assistant","timestamp":"${TS}","isForkReplayed":true},{"role":"assistant","timestamp":"${ASSISTANT_TS}"}],"tokenSeries":[]}`
    );

    await recomputeLegacyMessageAgentTurnBuckets(db.prisma, () => {
      // The log is not the contract here; the bucket rows are.
    });

    // ONE agent turn, not three. Unfiltered, the fork's whole inherited
    // conversation bucketed as its own work, on the parent's timestamps, in both
    // the desktop autonomy trend and the cloud utilization heatmap.
    assert.deepEqual(await bucketsFor(db, "sess-fork"), [
      { turn_kind: "agent", turn_count: 1 },
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
