/**
 * @file maintenance-write-txs.test.ts
 * @description Electron-free coverage for the standalone maintenance write
 * transactions `sweepOrphanedSessions` and `sweepExpiredSessions`, which run on
 * `prisma.write((client) => client.$transaction(...))` on the single client,
 * plus the shared transaction BODY they and the live `SessionStart` lane both
 * drive, `sweepStaleActiveSessions` (ISS-5182). Built over the shared
 * {@link openTestPrisma} harness so it runs locally as well as in CI.
 * (`deleteSessionRow` — the other maintenance tx — is an inline db method
 * validated end-to-end, incl. the agents FK cascade, by
 * data-revision-rebuild.test.ts test 12.)
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SessionListCursorSortKey } from "../src/main/agent-sync/agent-session-read-model.js";
import {
  sweepExpiredSessions,
  sweepOrphanedSessions,
} from "../src/main/database/session-maintenance.js";
import { chunkWatermark } from "../src/main/database/session-sync-watermark.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import { healSessionLastActivityAtFloor } from "../src/main/database/token-cost-maintenance.js";
import { openTestPrisma } from "./prisma-test-utils.js";

import {
  FRESH_UPDATED_AT,
  getAgent,
  getSession,
  NOW,
  STALE_UPDATED_AT,
  type Store,
  seedAgent,
  seedAgentEvent,
  seedSession,
} from "./session-sweep-fixtures.js";

test("sweepOrphanedSessions declares stale active sessions inactive and completes their running agents", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, "stale", "active", STALE_UPDATED_AT);
    // stale-running has a started_at but no events; FEA-3266 floors its swept
    // ended_at to started_at (its only activity anchor), never the sweep time.
    await seedAgent(
      store,
      "stale-running",
      "stale",
      "running",
      STALE_UPDATED_AT
    );
    await seedAgent(store, "stale-done", "stale", "completed");
    await seedSession(store, "fresh", "active", FRESH_UPDATED_AT);
    await seedAgent(store, "fresh-running", "fresh", "running");
    await seedSession(store, "terminal", "inactive", STALE_UPDATED_AT);

    const { swept } = await sweepOrphanedSessions(prisma, NOW);
    assert.equal(swept, 1);

    // Stale active session with no error flag → inactive (ISS-4586). FEA-3580:
    // ended_at is the session's true LAST ACTIVITY (last_activity_at, which
    // defaulted to STALE_UPDATED_AT here), NOT the sweep time NOW — so its
    // derived duration reflects real work, not the idle gap. updated_at still
    // reflects the sweep write.
    const stale = await getSession(store, "stale");
    assert.equal(stale?.status, "inactive");
    assert.equal(stale?.ended_at, STALE_UPDATED_AT);
    assert.notEqual(stale?.ended_at, NOW);
    assert.equal(stale?.updated_at, NOW);

    // Its running agent → completed; FEA-3266: ended_at is the agent's true last
    // activity (floored to started_at with no events), NOT the sweep time NOW.
    const staleRunning = await getAgent(store, "stale-running");
    assert.equal(staleRunning?.status, "completed");
    assert.equal(staleRunning?.ended_at, STALE_UPDATED_AT);
    assert.notEqual(staleRunning?.ended_at, NOW);
    const staleDone = await getAgent(store, "stale-done");
    assert.equal(staleDone?.status, "completed");
    assert.equal(staleDone?.ended_at, null); // untouched (NOT IN guard)

    // Fresh active session (updated after cutoff) is untouched.
    const fresh = await getSession(store, "fresh");
    assert.equal(fresh?.status, "active");
    const freshRunning = await getAgent(store, "fresh-running");
    assert.equal(freshRunning?.status, "running");

    // A terminal session is never a sweep target regardless of staleness.
    const terminal = await getSession(store, "terminal");
    assert.equal(terminal?.status, "inactive");
  } finally {
    await close();
  }
});

test("sweepOrphanedSessions declares an error-ending stale session error and fails its main agent (ISS-4586)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // A stale active session whose last import stamped ends_with_error = 1 — the
    // run ended on an unrecovered error before it was orphaned. The reaper reads
    // the durable flag (no transcript re-parse) and declares it `error`.
    await seedSession(
      store,
      "errored",
      "active",
      STALE_UPDATED_AT,
      STALE_UPDATED_AT,
      null,
      1
    );
    await seedAgent(
      store,
      "errored-main",
      "errored",
      "working",
      STALE_UPDATED_AT,
      "main"
    );
    await seedAgent(
      store,
      "errored-sub",
      "errored",
      "running",
      STALE_UPDATED_AT
    );
    // A sibling stale session with the flag unset → inactive + main completed,
    // proving the error classification is scoped by the flag, not the sweep.
    await seedSession(store, "quiet", "active", STALE_UPDATED_AT);
    await seedAgent(
      store,
      "quiet-main",
      "quiet",
      "working",
      STALE_UPDATED_AT,
      "main"
    );

    const { swept } = await sweepOrphanedSessions(prisma, NOW);
    assert.equal(swept, 2);

    // Error-flagged session → error; its MAIN agent is failed, but its subagent
    // still individually completed.
    assert.equal((await getSession(store, "errored"))?.status, "error");
    assert.equal((await getAgent(store, "errored-main"))?.status, "error");
    assert.equal((await getAgent(store, "errored-sub"))?.status, "completed");

    // The no-flag sibling is inactive with a completed main agent.
    assert.equal((await getSession(store, "quiet"))?.status, "inactive");
    assert.equal((await getAgent(store, "quiet-main"))?.status, "completed");
  } finally {
    await close();
  }
});

test("sweepOrphanedSessions stamps ended_at = last activity, not the sweep time N hours later (FEA-3580)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // A session that started, did ~2 minutes of real work, then was abandoned
    // (laptop closed / process killed → no SessionEnd hook). The sweep runs
    // hours later at NOW. Mirrors the live repro: startedAt 14:55, last activity
    // 14:57, swept at 12:00 next-window — endedAt must be the last activity.
    const STARTED_AT = "2026-06-22T05:00:00.000Z";
    const LAST_ACTIVITY = "2026-06-22T05:02:00.000Z"; // 2 min of real work
    // updated_at is stale (before the 09:00 cutoff) so the session is a target;
    // in production updated_at trails the last write, near last_activity_at.
    await seedSession(
      store,
      "abandoned",
      "active",
      STALE_UPDATED_AT,
      LAST_ACTIVITY,
      STARTED_AT
    );

    // Swept ~7h after the real last activity.
    const { swept } = await sweepOrphanedSessions(prisma, NOW);
    assert.equal(swept, 1);

    const session = await getSession(store, "abandoned");
    assert.equal(session?.status, "inactive");
    // ended_at is the true last activity, NOT the sweep time.
    assert.equal(session?.ended_at, LAST_ACTIVITY);
    assert.notEqual(session?.ended_at, NOW);

    // Derived duration = ended_at - started_at reflects the 2 minutes of real
    // work, NOT the ~7h abandonment gap (sweep_time - started).
    const realDurationMs =
      new Date(LAST_ACTIVITY).valueOf() - new Date(STARTED_AT).valueOf();
    const inflatedDurationMs =
      new Date(NOW).valueOf() - new Date(STARTED_AT).valueOf();
    const derivedDurationMs =
      new Date(session?.ended_at ?? 0).valueOf() -
      new Date(session?.started_at ?? 0).valueOf();
    assert.equal(derivedDurationMs, realDurationMs);
    assert.equal(derivedDurationMs, 2 * 60_000); // 2 minutes
    assert.notEqual(derivedDurationMs, inflatedDurationMs);
    // Sanity: the pre-fix bug would have produced this ~7h inflated tail.
    assert.equal(inflatedDurationMs, 7 * 60 * 60_000);
  } finally {
    await close();
  }
});

test("sweepOrphanedSessions stamps a swept AGENT's ended_at = its last event time, not the sweep time (FEA-3266)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // Same phantom-idle-tail repro as FEA-3580 but for the agent arm: an agent
    // started, did ~2 minutes of real work (its last event), then its session
    // was abandoned; the sweep runs ~7h later at NOW. Agents have no
    // last_activity_at column, so ended_at is derived from MAX(events.created_at)
    // over the agent's own events.
    const STARTED_AT = "2026-06-22T05:00:00.000Z";
    const LAST_EVENT = "2026-06-22T05:02:00.000Z"; // 2 min of real work
    await seedSession(store, "abandoned", "active", STALE_UPDATED_AT);
    await seedAgent(store, "worker", "abandoned", "running", STARTED_AT);
    // An earlier event then the real last event — MAX picks the later one.
    await seedAgentEvent(store, "ev-1", "abandoned", "worker", STARTED_AT);
    await seedAgentEvent(store, "ev-2", "abandoned", "worker", LAST_EVENT);

    const { swept } = await sweepOrphanedSessions(prisma, NOW);
    assert.equal(swept, 1);

    const agent = await getAgent(store, "worker");
    assert.equal(agent?.status, "completed");
    // ended_at is the agent's true last activity (its last event), NOT the sweep
    // time — so the subagent-type avg_duration in local-insights stops inflating.
    assert.equal(agent?.ended_at, LAST_EVENT);
    assert.notEqual(agent?.ended_at, NOW);
    // updated_at still reflects the sweep write.
    assert.equal(agent?.updated_at, NOW);

    const realDurationMs =
      new Date(LAST_EVENT).valueOf() - new Date(STARTED_AT).valueOf();
    const derivedDurationMs =
      new Date(agent?.ended_at ?? 0).valueOf() - new Date(STARTED_AT).valueOf();
    assert.equal(derivedDurationMs, realDurationMs);
    assert.equal(derivedDurationMs, 2 * 60_000); // 2 minutes, not the ~7h tail
  } finally {
    await close();
  }
});

test("sweepOrphanedSessions returns 0 and writes nothing when no session is stale", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, "fresh", "active", FRESH_UPDATED_AT);
    await seedAgent(store, "fresh-running", "fresh", "running");

    const { swept } = await sweepOrphanedSessions(prisma, NOW);
    assert.equal(swept, 0);

    const fresh = await getSession(store, "fresh");
    assert.equal(fresh?.status, "active");
    const freshRunning = await getAgent(store, "fresh-running");
    assert.equal(freshRunning?.status, "running");
  } finally {
    await close();
  }
});

// Retention sweep: default window is 90 days, so anchor activity timestamps
// relative to NOW to land clearly inside/outside that window.
const EXPIRED_ACTIVITY = "2026-01-01T00:00:00.000Z"; // ~176d before NOW → expired
const RECENT_ACTIVITY = "2026-06-20T00:00:00.000Z"; // ~6d before NOW → retained

async function seedSessionWithActivity(
  store: Store,
  id: string,
  status: string,
  lastActivityAt: string
): Promise<void> {
  await store.query(
    "INSERT INTO sessions (id, status, last_activity_at, data_revision) VALUES ($1, $2, $3, $4)",
    [id, status, lastActivityAt, 1]
  );
}

async function seedEvent(
  store: Store,
  id: string,
  sessionId: string
): Promise<void> {
  await store.query(
    "INSERT INTO events (id, session_id, event_type, data) VALUES ($1, $2, $3, $4)",
    [id, sessionId, "UserPromptSubmit", "secret transcript"]
  );
}

async function seedTokenUsage(store: Store, sessionId: string): Promise<void> {
  await store.query(
    "INSERT INTO token_usage (session_id, model) VALUES ($1, $2)",
    [sessionId, "claude-opus-4-8"]
  );
}

async function seedTokenEvent(store: Store, sessionId: string): Promise<void> {
  await store.query(
    "INSERT INTO token_events (session_id, model, created_at) VALUES ($1, $2, $3)",
    [sessionId, "claude-opus-4-8", EXPIRED_ACTIVITY]
  );
}

async function seedSessionAnalytics(
  store: Store,
  sessionId: string
): Promise<void> {
  await store.query(
    "INSERT INTO session_analytics (session_id, started_at, est_cost) VALUES ($1, $2, $3)",
    [sessionId, EXPIRED_ACTIVITY, 1.23]
  );
  await store.query(
    "INSERT INTO session_tool_analytics (session_id, tool_name, invocations) VALUES ($1, $2, $3)",
    [sessionId, "Bash", 5]
  );
  // FEA-2347: agent_component_session_usage is the third orphan-prone rollup.
  await store.query(
    "INSERT INTO agent_component_session_usage (session_id, component_kind, component_key) VALUES ($1, $2, $3)",
    [sessionId, "tool", "Bash"]
  );
  // FEA-2273: session_activity_metrics is the fourth no-FK derived rollup.
  await store.query(
    "INSERT INTO session_activity_metrics (session_id, autonomy_band, length_band, version) VALUES ($1, $2, $3, $4)",
    [sessionId, "mixed", "short", 4]
  );
}

async function seedTurnBucket(store: Store, sessionId: string): Promise<void> {
  await store.query(
    "INSERT INTO session_turn_bucket (session_id, ts, turn_kind, turn_count) VALUES ($1, $2, $3, $4)",
    [sessionId, EXPIRED_ACTIVITY, "human", 3]
  );
}

async function seedPullRequest(
  store: Store,
  id: string,
  sessionId: string
): Promise<void> {
  await store.query(
    "INSERT INTO pull_requests (id, session_id, pr_url, repo_full_name) VALUES ($1, $2, $3, $4)",
    [id, sessionId, "https://github.com/acme/repo/pull/1", "acme/repo"]
  );
  await store.query(
    "INSERT INTO pr_backfill_seen (session_id, scanned_at) VALUES ($1, $2)",
    [sessionId, EXPIRED_ACTIVITY]
  );
}

async function countBySession(
  store: Store,
  table: string,
  sessionId: string
): Promise<number> {
  const result = await store.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE session_id = $1`,
    [sessionId]
  );
  return Number(result.rows[0]?.n ?? 0);
}

test("sweepExpiredSessions purges terminal sessions past the retention window and their child rows", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // Expired terminal session with a full child fan-out.
    await seedSessionWithActivity(store, "old", "inactive", EXPIRED_ACTIVITY);
    await seedAgent(store, "old-agent", "old", "completed");
    await seedEvent(store, "old-event", "old");
    await seedTokenUsage(store, "old");
    await seedTokenEvent(store, "old");
    await seedSessionAnalytics(store, "old");
    await seedTurnBucket(store, "old");
    await seedPullRequest(store, "old-pr", "old");

    // Expired but still active → must survive (only terminal sessions purge).
    await seedSessionWithActivity(
      store,
      "old-active",
      "active",
      EXPIRED_ACTIVITY
    );
    // Terminal but recent → inside the window, must survive.
    await seedSessionWithActivity(store, "recent", "error", RECENT_ACTIVITY);
    await seedEvent(store, "recent-event", "recent");

    const { purged } = await sweepExpiredSessions(prisma, NOW);
    assert.equal(purged, 1);

    // The expired terminal session and every child row are gone.
    assert.equal(await getSession(store, "old"), undefined);
    assert.equal(await getAgent(store, "old-agent"), undefined);
    assert.equal(await countBySession(store, "events", "old"), 0);
    assert.equal(await countBySession(store, "token_usage", "old"), 0);
    assert.equal(await countBySession(store, "token_events", "old"), 0);
    assert.equal(await countBySession(store, "session_analytics", "old"), 0);
    assert.equal(
      await countBySession(store, "session_tool_analytics", "old"),
      0
    );
    // FEA-2347: the third rollup must be purged too (previously missed).
    assert.equal(
      await countBySession(store, "agent_component_session_usage", "old"),
      0
    );
    // FEA-2273: the cohort-metrics rollup must be purged too (no-FK derived row).
    assert.equal(
      await countBySession(store, "session_activity_metrics", "old"),
      0
    );
    assert.equal(await countBySession(store, "session_turn_bucket", "old"), 0);
    assert.equal(await countBySession(store, "pull_requests", "old"), 0);
    assert.equal(await countBySession(store, "pr_backfill_seen", "old"), 0);

    // Active-but-old and terminal-but-recent sessions are untouched.
    assert.equal((await getSession(store, "old-active"))?.status, "active");
    assert.equal((await getSession(store, "recent"))?.status, "error");
    assert.equal(await countBySession(store, "events", "recent"), 1);
  } finally {
    await close();
  }
});

test("sweepExpiredSessions returns 0 and writes nothing when no session is past the window", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSessionWithActivity(store, "recent", "inactive", RECENT_ACTIVITY);
    await seedEvent(store, "recent-event", "recent");

    const { purged } = await sweepExpiredSessions(prisma, NOW);
    assert.equal(purged, 0);

    assert.equal((await getSession(store, "recent"))?.status, "inactive");
    assert.equal(await countBySession(store, "events", "recent"), 1);
  } finally {
    await close();
  }
});

test("sweepExpiredSessions honors a custom retention window", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // ~6 days old: retained at 90d, purged at a 1-day window.
    await seedSessionWithActivity(store, "recent", "inactive", RECENT_ACTIVITY);

    assert.equal((await sweepExpiredSessions(prisma, NOW, 90)).purged, 0);
    assert.equal((await getSession(store, "recent"))?.status, "inactive");

    assert.equal((await sweepExpiredSessions(prisma, NOW, 1)).purged, 1);
    assert.equal(await getSession(store, "recent"), undefined);
  } finally {
    await close();
  }
});

// ── FEA-3591: healSessionLastActivityAtFloor ─────────────────────────────────
// The convergent boot heal for rows violating `last_activity_at >= started_at`.
// Runs AWAITED before both sweeps above, so these tests also pin the interplay:
// the orphan sweep must stamp HEALED values into ended_at, the retention sweep
// must evaluate HEALED values, and the heal must never lift a stale active out
// of the orphan sweep's `updatedAt < cutoff` predicate.

// The resume-bug shape from the FEA-3591 curation sweep: a continuation session
// whose started_at is the resume time while its inherited activity lands ~2h
// earlier.
const HEAL_STARTED_AT = "2026-06-22T01:00:00.000Z";
const HEAL_BAD_ACTIVITY = "2026-06-21T23:00:00.000Z";
const noopLog = () => {
  /* no chunk failures expected */
};
// ISO 'T'-form shape the sync cursor sorts correctly (the watermark contract).
const ISO_T_FORM_RE = /^\d{4}-\d{2}-\d{2}T.*Z$/;

test("healSessionLastActivityAtFloor floors violations, bumps every non-active row, and converges (FEA-3591)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const OLD_UPDATED = "2026-06-20T00:00:00.000Z";
    for (const [id, status] of [
      ["bad-inactive", "inactive"],
      ["bad-error", "error"],
      ["bad-active", "active"],
      ["bad-waiting", "waiting"],
    ] as const) {
      await seedSession(
        store,
        id,
        status,
        OLD_UPDATED,
        HEAL_BAD_ACTIVITY,
        HEAL_STARTED_AT
      );
    }
    await seedSession(
      store,
      "clean-inactive",
      "inactive",
      OLD_UPDATED,
      "2026-06-22T02:00:00.000Z",
      HEAL_STARTED_AT
    );

    const logs: string[] = [];
    const result = await healSessionLastActivityAtFloor(prisma, NOW, (m) =>
      logs.push(m)
    );
    assert.deepEqual(result, { healed: 4, failedChunks: 0 });
    assert.equal(logs.length, 0);

    // Every violating row is floored to started_at (no events → floor value).
    for (const id of [
      "bad-inactive",
      "bad-error",
      "bad-active",
      "bad-waiting",
    ]) {
      const row = await getSession(store, id);
      assert.equal(row?.last_activity_at, HEAL_STARTED_AT, id);
    }
    // Clean row untouched.
    const clean = await getSession(store, "clean-inactive");
    assert.equal(clean?.last_activity_at, "2026-06-22T02:00:00.000Z");
    assert.equal(clean?.updated_at, OLD_UPDATED);

    // Sync visibility: every healed row EXCEPT `active` gets the ISO 'T'
    // watermark bump — terminal rows have no other lane, and a waiting row can
    // park forever without another ingest event (PR #3334 review, P2). Only
    // `active` is exempt, because it is the one status the orphan sweep's
    // `updatedAt < cutoff` predicate watches.
    const watermark = chunkWatermark(NOW, 0);
    for (const id of ["bad-inactive", "bad-error", "bad-waiting"]) {
      const row = await getSession(store, id);
      assert.equal(row?.updated_at, watermark, id);
    }
    assert.equal(
      (await getSession(store, "bad-active"))?.updated_at,
      OLD_UPDATED
    );

    // The real sync cursor read picks up exactly the bumped rows. PRD-536 E1:
    // the read excludes the observed-id set at the top timestamp; passing an
    // EMPTY observed set (nothing seen yet at `updated_at = NOW`) selects every
    // row at that timestamp, matching the prior `updated_at >= NOW` behavior for
    // this heal assertion.
    const source = createSqliteSessionSyncSource(prisma);
    const cursorIds = (await source.listUpdatedSessionCursorRows(NOW, [])).map(
      (r) => r.id
    );
    assert.deepEqual([...cursorIds].sort(), [
      "bad-error",
      "bad-inactive",
      "bad-waiting",
    ]);

    // PRD-536 E1 (real-DB NOT IN path): passing a NON-empty observed-id set at
    // the top timestamp excludes exactly those ids via the parameterized
    // `id NOT IN (...)` clause — proving the placeholder-expanded SQL executes
    // against libSQL and the tied-top exclusion works end-to-end (the fake-source
    // tests only cover the JS mirror).
    const excludedTwo = (
      await source.listUpdatedSessionCursorRows(NOW, [
        "bad-inactive",
        "bad-waiting",
      ])
    )
      .map((r) => r.id)
      .sort();
    assert.deepEqual(
      excludedTwo,
      ["bad-error"],
      "observed ids at the top timestamp are excluded; the rest are still selected"
    );

    // Convergence: a second run finds nothing and causes zero updated_at churn.
    const again = await healSessionLastActivityAtFloor(prisma, NOW, (m) =>
      logs.push(m)
    );
    assert.deepEqual(again, { healed: 0, failedChunks: 0 });
    assert.equal(
      (await getSession(store, "bad-inactive"))?.updated_at,
      watermark
    );
    assert.equal(
      (await getSession(store, "bad-active"))?.updated_at,
      OLD_UPDATED
    );
  } finally {
    await close();
  }
});

test("heal leaves a stale active sweep-eligible; the orphan sweep then stamps the HEALED ended_at (FEA-3591)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // updated_at before the 180-min cutoff → a genuine orphan. A bump during
    // the heal would shield it from the sweep (the round-1 challenge finding).
    await seedSession(
      store,
      "stale-bad-active",
      "active",
      STALE_UPDATED_AT,
      HEAL_BAD_ACTIVITY,
      HEAL_STARTED_AT
    );

    const { healed } = await healSessionLastActivityAtFloor(
      prisma,
      NOW,
      noopLog
    );
    assert.equal(healed, 1);
    const afterHeal = await getSession(store, "stale-bad-active");
    assert.equal(afterHeal?.last_activity_at, HEAL_STARTED_AT);
    assert.equal(afterHeal?.updated_at, STALE_UPDATED_AT);

    const { swept } = await sweepOrphanedSessions(prisma, NOW);
    assert.equal(swept, 1);
    const afterSweep = await getSession(store, "stale-bad-active");
    assert.equal(afterSweep?.status, "inactive");
    // ended_at is the HEALED last activity — never the pre-start value, never
    // the sweep time — so the derived duration is non-negative and real.
    assert.equal(afterSweep?.ended_at, HEAL_STARTED_AT);
    assert.ok(
      (afterSweep?.ended_at ?? "") >= (afterSweep?.started_at ?? ""),
      "swept ended_at must not precede started_at"
    );
    // The sweep's own bump provides the sync visibility for this row.
    assert.equal(afterSweep?.updated_at, NOW);
  } finally {
    await close();
  }
});

test("heal before the retention sweep rescues a row whose corrupted activity looked purge-eligible (FEA-3591)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // 90d window from NOW (2026-06-22) → cutoff 2026-03-24. Corrupted activity
    // sits BEFORE the cutoff (would purge); the true start sits inside the
    // window (must survive).
    await seedSession(
      store,
      "purge-race",
      "inactive",
      "2026-04-15T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      "2026-04-15T10:00:00.000Z"
    );

    const { healed } = await healSessionLastActivityAtFloor(
      prisma,
      NOW,
      noopLog
    );
    assert.equal(healed, 1);

    const { purged } = await sweepExpiredSessions(prisma, NOW);
    assert.equal(purged, 0);
    const row = await getSession(store, "purge-race");
    assert.equal(row?.status, "inactive");
    assert.equal(row?.last_activity_at, "2026-04-15T10:00:00.000Z");
  } finally {
    await close();
  }
});

test("multi-chunk heal stamps strictly-increasing per-chunk watermarks (FEA-3591/FEA-3485)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    for (const id of ["chunk-a", "chunk-b", "chunk-c"]) {
      await seedSession(
        store,
        id,
        "inactive",
        "2026-06-20T00:00:00.000Z",
        HEAL_BAD_ACTIVITY,
        HEAL_STARTED_AT
      );
    }

    const { healed } = await healSessionLastActivityAtFloor(
      prisma,
      NOW,
      noopLog,
      1
    );
    assert.equal(healed, 3);

    const stamps: string[] = [];
    for (const id of ["chunk-a", "chunk-b", "chunk-c"]) {
      const row = await getSession(store, id);
      assert.equal(row?.last_activity_at, HEAL_STARTED_AT, id);
      stamps.push(row?.updated_at ?? "");
    }
    // One watermark per chunk, all distinct, all ISO 'T'-form (cursor-visible),
    // collapsing onto no single top timestamp.
    assert.deepEqual([...stamps].sort(), [
      chunkWatermark(NOW, 0),
      chunkWatermark(NOW, 1),
      chunkWatermark(NOW, 2),
    ]);
    for (const stamp of stamps) {
      assert.match(stamp, ISO_T_FORM_RE);
    }
  } finally {
    await close();
  }
});

test("heal repairs epoch defaults and derives from events when they exist (FEA-3591)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // Epoch default (the OTel-minimal / crashed-import shape): no events, so
    // the recompute floors to started_at.
    await seedSession(
      store,
      "epoch-default",
      "inactive",
      "2026-06-20T00:00:00.000Z",
      "1970-01-01T00:00:00.000Z",
      HEAL_STARTED_AT
    );
    // Violating row WITH a post-start event: the heal must produce the real
    // MAX(events.created_at), not just the floor — proving it reuses the
    // production recompute rather than clamping.
    await seedSession(
      store,
      "with-events",
      "inactive",
      "2026-06-20T00:00:00.000Z",
      HEAL_BAD_ACTIVITY,
      HEAL_STARTED_AT
    );
    await store.query(
      "INSERT INTO events (id, session_id, event_type, created_at) VALUES ($1, $2, $3, $4)",
      ["ev-post-start", "with-events", "ToolUse", "2026-06-22T03:00:00.000Z"]
    );

    const { healed } = await healSessionLastActivityAtFloor(
      prisma,
      NOW,
      noopLog
    );
    assert.equal(healed, 2);
    assert.equal(
      (await getSession(store, "epoch-default"))?.last_activity_at,
      HEAL_STARTED_AT
    );
    assert.equal(
      (await getSession(store, "with-events"))?.last_activity_at,
      "2026-06-22T03:00:00.000Z"
    );
  } finally {
    await close();
  }
});

test("heal now repairs a not-yet-normalized offset-form started_at, and still defers a legacy-mode one (ISS-5497)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // FEA-3743 used to DEFER this row: the floor heal's discovery `<` is a
    // byte-wise TEXT comparison, so with a still-offset started_at (the format
    // heal is best-effort) it could select or skip the wrong rows, and the
    // canonical-'Z' guards on both operands kept it off them until a boot whose
    // format heal won. ISS-5497 added a SECOND discovery arm that does not
    // compare bytes at all — it asks whether the stored value equals the exact
    // value the write path would derive — so a row whose every operand
    // CANONICALIZES no longer has to wait. 10:00+02:00 is 08:00Z, and with no
    // events that canonicalized floor IS the answer.
    await seedSession(
      store,
      "offset-form",
      "inactive",
      "2026-06-20T00:00:00.000Z",
      "2026-06-17T00:00:00.000Z",
      "2026-06-18T10:00:00+02:00"
    );
    // ...and the deferral survives exactly where the reason for it does: the
    // SQLite space form cannot be canonicalized (the FEA-3743 heal declines it
    // too), so the fold falls to LEGACY mode — `main`'s byte-wise expression
    // verbatim — and the ISS-5497 arm refuses to judge it. The original arm's
    // canonical-'Z' guard keeps refusing it as well.
    await seedSession(
      store,
      "space-form",
      "inactive",
      "2026-06-20T00:00:00.000Z",
      "2026-06-17T00:00:00.000Z",
      "2026-06-18 10:00:00"
    );

    const { healed } = await healSessionLastActivityAtFloor(
      prisma,
      NOW,
      noopLog
    );
    assert.equal(healed, 1);

    const repaired = await getSession(store, "offset-form");
    assert.equal(repaired?.last_activity_at, "2026-06-18T08:00:00.000Z");
    assert.equal(repaired?.updated_at, chunkWatermark(NOW, 0));

    const deferred = await getSession(store, "space-form");
    assert.equal(deferred?.last_activity_at, "2026-06-17T00:00:00.000Z");
    assert.equal(deferred?.updated_at, "2026-06-20T00:00:00.000Z");
  } finally {
    await close();
  }
});

test("healed activity re-enters the Sessions list date window (FEA-3591 / FEA-2180)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(
      store,
      "window-reentry",
      "inactive",
      "2026-06-20T00:00:00.000Z",
      HEAL_BAD_ACTIVITY,
      HEAL_STARTED_AT
    );
    const source = createSqliteSessionSyncSource(prisma);
    const pageRequest = {
      limit: 10,
      offset: 0,
      sortBy: SessionListCursorSortKey.LastActivity,
      sortDir: "desc" as const,
      // The healed activity day only — the corrupted value (06-21T23:00) sits
      // outside this window, the healed value (06-22T01:00) inside it.
      startDate: new Date("2026-06-22T00:00:00.000Z"),
      endDate: new Date("2026-06-23T00:00:00.000Z"),
    };

    const before = await source.listSessionCursorPage(pageRequest);
    assert.equal(before.rows.length, 0);

    const { healed } = await healSessionLastActivityAtFloor(
      prisma,
      NOW,
      noopLog
    );
    assert.equal(healed, 1);

    const after = await source.listSessionCursorPage(pageRequest);
    assert.deepEqual(
      after.rows.map((r) => r.id),
      ["window-reentry"]
    );
  } finally {
    await close();
  }
});
