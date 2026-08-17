/**
 * @file session-sweep-shared-body.test.ts
 * @description ISS-5182: coverage for `sweepStaleActiveSessions`, the single
 * sweep body that the boot reaper and the live `SessionStart` hook now share.
 * It replaced two near-identical copies whose `ended_at` handling had already
 * drifted — FEA-3580/FEA-3266 corrected the boot copy and left the live one
 * stamping the sweep wall clock. Split out of `maintenance-write-txs.test.ts`
 * (which owns the standalone maintenance transactions) so neither file grows
 * past the size ceiling.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  DESKTOP_AGENT_STATUS,
  EVENT_INSERT_PARAM_CAP,
} from "../src/main/database/db-constants.js";
import { createSqliteLifecycle } from "../src/main/database/live-hook.js";
import { createSqliteTokenUsageStore } from "../src/main/database/read-stores.js";
import {
  SWEEP_ID_CHUNK,
  sweepOrphanedSessions,
  sweepStaleActiveSessions,
} from "../src/main/database/session-maintenance.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import {
  countByStatus,
  countMissingEndedAt,
  getAgent,
  getSession,
  NOW,
  recordBoundParams,
  type SeedAgentRow,
  type SeedSessionRow,
  STALE_UPDATED_AT,
  seedAgent,
  seedAgentEvent,
  seedAgents,
  seedSession,
  seedSessions,
} from "./session-sweep-fixtures.js";

/*
 * ISS-5182: the live `SessionStart` sweep used to be a separate near-copy
 * (`sweepStaleSessions` in write-core.ts) that stamped `ended_at` with the sweep
 * wall clock — the phantom idle tail FEA-3580 had already removed from the boot
 * reaper. Both entry points now share this body, so the two cases below pin the
 * ONLY thing the live path does differently (excluding its in-flight session)
 * and the thing the copy got wrong (the end anchor).
 */
test("sweepStaleActiveSessions excludes the in-flight session and anchors ended_at to last activity (ISS-5182)", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const LAST_ACTIVITY = "2026-06-22T07:30:00.000Z";
    // The session whose SessionStart hook is running: stale by the clock, but
    // mid-write, so its own hook must never declare it terminal.
    await seedSession(store, "in-flight", "active", STALE_UPDATED_AT);
    // A genuinely abandoned peer, swept during that same hook.
    await seedSession(store, "peer", "active", STALE_UPDATED_AT, LAST_ACTIVITY);

    const result = await prisma.write((client) =>
      client.$transaction((tx) =>
        sweepStaleActiveSessions(tx, {
          excludeSessionId: "in-flight",
          now: NOW,
        })
      )
    );
    assert.equal(result.swept, 1, "only the peer is swept");
    assert.equal(result.heldBack, 0, "both rows are canonical");

    const inFlight = await getSession(store, "in-flight");
    assert.equal(inFlight?.status, "active", "the in-flight session survives");
    assert.equal(inFlight?.ended_at, null);

    // The fix: the swept peer's end is its own last activity, not the moment
    // the sweep happened to run. The old copy wrote NOW here, giving every
    // live-swept session a phantom tail of at least the 180-minute window.
    const peer = await getSession(store, "peer");
    assert.equal(peer?.status, "inactive");
    assert.equal(peer?.ended_at, LAST_ACTIVITY);
    assert.notEqual(peer?.ended_at, NOW);
    assert.equal(peer?.updated_at, NOW, "updated_at still marks the sweep");
  } finally {
    await close();
  }
});

/*
 * ISS-5182: pins the LIVE call site, not just the shared body.
 *
 * The unit test above drives `sweepStaleActiveSessions` directly, so deleting
 * `live-hook.ts`'s call would leave it green — and the live lane is the entire
 * subject of this issue (it was the copy that stamped the sweep wall clock for
 * however long FEA-3580 had been "fixed"). This drives the real
 * `processEvent("SessionStart", …)` path instead.
 *
 * Note what this can and cannot pin: `handleHook` bumps the in-flight session's
 * `updated_at` to `now` BEFORE sweeping, so that row can never satisfy
 * `updated_at < cutoff` and the `excludeSessionId` argument is redundant in
 * production. The exclusion itself is pinned by the unit test; what this pins
 * is that the hook invokes the sweep at all, and that a peer it sweeps gets its
 * own last activity rather than the hook's clock.
 */
test("ISS-5182: the live SessionStart hook sweeps a stale peer to its last activity", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const PEER_STARTED = "2026-06-22T07:00:00.000Z";
    const PEER_LAST_ACTIVITY = "2026-06-22T07:30:00.000Z";
    await seedSession(
      store,
      "peer",
      "active",
      STALE_UPDATED_AT,
      PEER_LAST_ACTIVITY,
      PEER_STARTED
    );
    await seedAgent(
      store,
      "peer-main",
      "peer",
      "working",
      PEER_STARTED,
      "main"
    );

    const lifecycle = createSqliteLifecycle(
      prisma,
      createSqliteTokenUsageStore(prisma),
      {
        detectBillingMode: () => "unknown",
        log: () => undefined,
        now: () => NOW,
      }
    );
    const processed = await lifecycle.processEvent(
      "SessionStart",
      { session_id: "in-flight", cwd: "/tmp/iss5182" },
      "claude"
    );
    assert.equal(processed, true, "the hook transaction committed");

    // The hook reached the shared sweep body.
    const peer = await getSession(store, "peer");
    assert.equal(peer?.status, "inactive");
    // The fix: the peer's end is its OWN last activity, not the hook's clock.
    // Before ISS-5182 the live copy wrote NOW here.
    assert.equal(peer?.ended_at, PEER_LAST_ACTIVITY);
    assert.notEqual(peer?.ended_at, NOW);

    // The session whose hook is running is never swept by its own hook.
    const inFlight = await getSession(store, "in-flight");
    assert.equal(inFlight?.status, "active");
    assert.equal(inFlight?.ended_at, null);
  } finally {
    await close();
  }
});

/*
 * ISS-5182: the swept `ended_at` is FLOORED to `started_at`, on both arms.
 *
 * The boot chain refuses to sweep when `healSessionLastActivityAtFloor` fails
 * (sqlite.ts) precisely because "sweeping unhealed rows could stamp pre-start
 * ended_at values" — but that refusal is local to the boot path and cannot gate
 * the live `SessionStart` lane, which now runs the same body. So a row whose
 * `last_activity_at` still sits below `started_at` (floor heal pending, or the
 * NOT NULL 1970 epoch default) must not produce a negative duration. The old
 * live copy never needed this: it stamped `now`, which is always >= started_at.
 *
 * The agent arm has the same hazard for a different reason — its expression was
 * a COALESCE fallback, not a floor, so an agent WITH events that all predate
 * its own `started_at` took the earlier value.
 */
test("ISS-5182: a swept row with pre-start activity is floored to started_at, not back-dated", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const STARTED = "2026-06-22T07:00:00.000Z";
    const PRE_START_ACTIVITY = "2026-06-22T06:00:00.000Z"; // floor heal pending
    await seedSession(
      store,
      "unhealed",
      "active",
      STALE_UPDATED_AT,
      PRE_START_ACTIVITY,
      STARTED
    );
    await seedAgent(store, "unhealed-main", "unhealed", "running", STARTED);
    await seedAgentEvent(
      store,
      "ev-pre",
      "unhealed",
      "unhealed-main",
      PRE_START_ACTIVITY
    );

    await prisma.write((client) =>
      client.$transaction((tx) => sweepStaleActiveSessions(tx, { now: NOW }))
    );

    const session = await getSession(store, "unhealed");
    assert.equal(
      session?.ended_at,
      STARTED,
      "session ended_at is floored, so runtime_ms cannot go negative"
    );
    assert.notEqual(session?.ended_at, PRE_START_ACTIVITY);

    const agent = await getAgent(store, "unhealed-main");
    assert.equal(
      agent?.ended_at,
      STARTED,
      "agent ended_at is floored even though it HAS an earlier event"
    );
    assert.notEqual(agent?.ended_at, PRE_START_ACTIVITY);
  } finally {
    await close();
  }
});

/*
 * ISS-5182 (review): the floor is only a floor when text order IS time order.
 *
 * `started_at` / `last_activity_at` are TEXT columns, so the session arm's
 * `MAX(started_at-floor, last_activity_at)` is SQLite's SCALAR `max`, which
 * compares BYTE-WISE. The legacy offset form below is chronologically 12:00Z
 * but sorts BELOW the canonical 10:00Z activity value, so an unguarded MAX
 * returns the EARLIER instant and stamps `ended_at` three hours before the
 * session started — a negative duration, exactly what the floor exists to stop.
 *
 * ISS-5429: the LIVE lane still holds such a row back — it runs behind no heal,
 * and flooring it here would win the race against the next boot and replace a
 * real duration with zero. What changes is that the hold-back is now REPORTED
 * instead of silent, and reported only after the hook transaction commits.
 *
 * Driven through the real `processEvent("SessionStart", …)` because that is the
 * lane ISS-5182 routed through the shared body and the one ISS-5429's report
 * had to reach.
 */
test("ISS-5429: the live SessionStart sweep holds back a non-canonical row and reports it", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // 07:00-05:00 is 12:00Z — AFTER the canonical activity value below, but it
    // sorts before it byte-wise.
    const OFFSET_FORM_STARTED = "2026-06-22T07:00:00-05:00";
    const CANONICAL_ACTIVITY = "2026-06-22T10:00:00.000Z";
    await seedSession(
      store,
      "offset-form",
      SESSION_STATUS.ACTIVE,
      STALE_UPDATED_AT,
      CANONICAL_ACTIVITY,
      OFFSET_FORM_STARTED
    );
    // Same sweep, canonical timestamps: must still be swept normally.
    await seedSession(
      store,
      "canonical",
      SESSION_STATUS.ACTIVE,
      STALE_UPDATED_AT,
      CANONICAL_ACTIVITY,
      "2026-06-22T07:00:00.000Z"
    );

    const logged: string[] = [];
    const lifecycle = createSqliteLifecycle(
      prisma,
      createSqliteTokenUsageStore(prisma),
      {
        detectBillingMode: () => "unknown",
        log: (message: string) => logged.push(message),
        now: () => NOW,
      }
    );
    const processed = await lifecycle.processEvent(
      "SessionStart",
      { session_id: "in-flight", cwd: "/tmp/iss5182" },
      "claude"
    );
    assert.equal(processed, true, "the hook transaction committed");

    const offsetForm = await getSession(store, "offset-form");
    assert.equal(
      offsetForm?.status,
      SESSION_STATUS.ACTIVE,
      "the live lane leaves the row for the next boot's heal rather than zeroing its duration"
    );
    assert.equal(
      offsetForm?.ended_at,
      null,
      "no ended_at is written, so none can precede started_at"
    );

    const canonical = await getSession(store, "canonical");
    assert.equal(canonical?.status, SESSION_STATUS.INACTIVE);
    assert.equal(canonical?.ended_at, CANONICAL_ACTIVITY);

    // The hold-back is REPORTED, not absorbed — the whole point of the issue
    // was that nothing counted or logged these rows.
    assert.ok(
      logged.some((message) => message.includes("held back 1 stale session")),
      `the live lane reports the held-back row, got ${JSON.stringify(logged)}`
    );
  } finally {
    await close();
  }
});

/*
 * ISS-5330 (wongk): the offset form is not the only way byte order stops being
 * time order — MIXED PRECISION does it too, and the pre-ISS-5330
 * `isCanonicalUtcTimestamp` accepted both sides of it.
 *
 * `2026-06-22T10:00:00Z` and `2026-06-22T10:00:00.999Z` are the same second, and
 * the second one is the LATER instant. Byte-wise they diverge at `Z` (0x5A) vs
 * `.` (0x2E), so the whole-second value sorts HIGHER and the last-activity arm's
 * `MAX(started_at-floor, last_activity_at)` returns it — stamping `ended_at`
 * 999ms before the row's own last activity. The guard is a guard only if it
 * pins the WIDTH, so the row must be held back exactly like the offset one.
 *
 * ISS-5429: what changes is that the hold-back is COUNTED.
 */
test("ISS-5330: the sweep holds back a row mixing second and millisecond precision, and counts it", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const WHOLE_SECOND_STARTED = "2026-06-22T10:00:00Z";
    const LATER_ACTIVITY = "2026-06-22T10:00:00.999Z";
    await seedSession(
      store,
      "mixed-precision",
      SESSION_STATUS.ACTIVE,
      STALE_UPDATED_AT,
      LATER_ACTIVITY,
      WHOLE_SECOND_STARTED
    );

    const result = await prisma.write((client) =>
      client.$transaction((tx) => sweepStaleActiveSessions(tx, { now: NOW }))
    );
    assert.equal(result.swept, 0, "a mixed-precision row is not swept");
    assert.equal(result.heldBack, 1, "but it IS counted, which it never was");

    const row = await getSession(store, "mixed-precision");
    assert.equal(row?.status, SESSION_STATUS.ACTIVE);
    assert.equal(
      row?.ended_at,
      null,
      "no ended_at is written, so none can precede the row's true last activity"
    );
  } finally {
    await close();
  }
});

/*
 * ISS-5429 (review): the guard tests the FLOOR's value, not the raw column.
 *
 * A `started_at` the floor's date-prefix GLOB rejects never reaches the
 * byte-wise MAX — the CASE substitutes the canonical 1970 literal — so the
 * comparison against a canonical `last_activity_at` is perfectly sound and the
 * row is sweepable. Testing the raw column instead would hold the row back and
 * count it as bad data when nothing about it is unsound.
 */
test("ISS-5429: a non-date-shaped started_at with canonical activity is still swept", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const ACTIVITY = "2026-06-22T07:30:00.000Z";
    await seedSession(
      store,
      "junk-start",
      SESSION_STATUS.ACTIVE,
      STALE_UPDATED_AT,
      ACTIVITY,
      ""
    );

    const result = await sweepOrphanedSessions(prisma, NOW);
    assert.equal(result.swept, 1);
    assert.equal(
      result.heldBack,
      0,
      "nothing is unsound here — the floor is the canonical epoch literal"
    );

    const row = await getSession(store, "junk-start");
    assert.equal(row?.status, SESSION_STATUS.INACTIVE);
    assert.equal(
      row?.ended_at,
      ACTIVITY,
      "ended_at is the real last activity, not the 1970 epoch"
    );
  } finally {
    await close();
  }
});

/*
 * ISS-5182 (review): the chunk loop's SECOND and FINAL-PARTIAL iterations.
 *
 * `SWEEP_ID_CHUNK` exists because sharing the boot body made an unbounded
 * `IN (…)` list reachable from `SessionStart`. Every other case in this file
 * sweeps one or two peers, so the loop never iterates and the bound is
 * unproven. This one seeds `SWEEP_ID_CHUNK + 3` stale sessions: chunk 1 is
 * full, chunk 2 is a 3-row partial.
 *
 * `findMany` has no ORDER BY, so which rows land in the partial chunk is not
 * guaranteed. The fixture makes the property hold under ANY row order instead
 * of relying on scan order: only TWO rows are non-error, so the 3-row final
 * chunk MUST contain at least one error-ending row. That is what pins the
 * error-arm override (`errorIds`) to later iterations rather than only the
 * first — it runs per chunk, and a chunk-2 error session whose main agent is
 * still `completed` means it did not.
 */
test("ISS-5182: a stale set larger than SWEEP_ID_CHUNK is swept across chunks, error arm included", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const TOTAL = SWEEP_ID_CHUNK + 3;
    const NON_ERROR = 2;
    const ACTIVITY = "2026-06-22T07:30:00.000Z";
    const STARTED = "2026-06-22T07:00:00.000Z";
    const sessions: SeedSessionRow[] = [];
    const agents: SeedAgentRow[] = [];
    for (let index = 0; index < TOTAL; index += 1) {
      const id = `s${String(index).padStart(4, "0")}`;
      sessions.push({
        id,
        status: SESSION_STATUS.ACTIVE,
        updatedAt: STALE_UPDATED_AT,
        lastActivityAt: ACTIVITY,
        startedAt: STARTED,
        endsWithError: index < NON_ERROR ? null : 1,
      });
      agents.push({
        id: `${id}-main`,
        sessionId: id,
        status: DESKTOP_AGENT_STATUS.RUNNING,
        startedAt: STARTED,
        type: "main",
      });
    }
    await seedSessions(store, sessions);
    await seedAgents(store, agents);

    // The bound-parameter count of every statement the sweep actually issued.
    // Recorded through a pass-through proxy over the real `tx` (so the writes
    // still hit the real DB) and asserted from the test body below.
    const boundParamCounts: number[] = [];
    const result = await prisma.write((client) =>
      client.$transaction((tx) =>
        sweepStaleActiveSessions(recordBoundParams(tx, boundParamCounts), {
          now: NOW,
        })
      )
    );
    assert.equal(
      result.swept,
      TOTAL,
      "every stale session is swept, not just chunk 1"
    );

    // The bound-parameter cap is why the loop exists. It cannot be observed as a
    // failure here — this libSQL build's SQLITE_MAX_VARIABLE_NUMBER is 32766, so
    // an unchunked 900+ id list would execute fine — but the OLD builds the cap
    // is conservative for would reject it, so assert the budget directly.
    assert.ok(
      boundParamCounts.length > 0,
      "the sweep issued at least one raw statement"
    );
    assert.ok(
      Math.max(...boundParamCounts) <= EVENT_INSERT_PARAM_CAP,
      `no statement may bind more than ${EVENT_INSERT_PARAM_CAP} parameters, saw ${Math.max(...boundParamCounts)}`
    );

    const sessionStatuses = await countByStatus(store, "sessions");
    assert.equal(
      sessionStatuses[SESSION_STATUS.ACTIVE],
      undefined,
      "no session is left active past the chunk boundary"
    );
    assert.equal(sessionStatuses[SESSION_STATUS.ERROR], TOTAL - NON_ERROR);
    assert.equal(sessionStatuses[SESSION_STATUS.INACTIVE], NON_ERROR);
    assert.equal(
      await countMissingEndedAt(store, "sessions"),
      0,
      "every swept session got an ended_at, in every chunk"
    );

    // The error-arm override is a THIRD statement issued per chunk. At least one
    // of its targets is in the final partial chunk (see the note above), so a
    // first-chunk-only override leaves that agent `completed`.
    const agentStatuses = await countByStatus(store, "agents");
    assert.equal(
      agentStatuses[DESKTOP_AGENT_STATUS.ERROR],
      TOTAL - NON_ERROR,
      "every error-ending session's main agent is error, past the boundary too"
    );
    assert.equal(agentStatuses[DESKTOP_AGENT_STATUS.COMPLETED], NON_ERROR);
    assert.equal(await countMissingEndedAt(store, "agents"), 0);
  } finally {
    await close();
  }
});
