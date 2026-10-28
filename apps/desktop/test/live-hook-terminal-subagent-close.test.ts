/**
 * @file live-hook-terminal-subagent-close.test.ts
 * @description ISS-6902: a live hook that declares a session terminal must leave
 * no agent of that session still running.
 *
 * `Stop(stop_reason=error)` used to close the main agent only.
 * `sweepStaleActiveSessions` selects `status = 'active'` rows, so the session the
 * Stop just moved to `error` is outside every later sweep — a subagent left
 * `working` was stranded there permanently, and `sync-source.ts` reads
 * `agents.status` straight onto the wire, so the cloud was told `working` too.
 *
 * Status values below are written as literals on purpose: they are the persisted
 * column values and the wire values the cloud reads, so asserting them through
 * the same const the production statement interpolates would stay green if that
 * const's value changed.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { createSqliteLifecycle } from "../src/main/database/live-hook.js";
import { createSqliteTokenUsageStore } from "../src/main/database/read-stores.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import { emptyAttributionCache } from "./attribution-test-helpers.js";
import type { OpenTestPrisma } from "./prisma-test-utils.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import { getAgent, getSession, NOW } from "./session-sweep-fixtures.js";

const SESSION_ID = "iss6902-session";
const MAIN_AGENT_ID = `${SESSION_ID}-main`;
/** Strictly before {@link NOW}, so an end stamped here is distinguishable. */
const SUBAGENT_STOP_AT = "2026-06-22T11:00:00.000Z";
/** Strictly AFTER {@link NOW}: a SubagentStop that lands past the terminal Stop. */
const LATE_SUBAGENT_STOP_AT = "2026-06-22T13:00:00.000Z";
const FIRST_SUBAGENT = "first subagent";
const SECOND_SUBAGENT = "second subagent";
/** Matches no spawned subagent's name, type, or task. */
const UNKNOWN_SUBAGENT = "a subagent this session never spawned";

type AgentRow = { id: string; name: string; status: string; ended_at: string };

type Lifecycle = ReturnType<typeof createSqliteLifecycle>;

/**
 * A lifecycle whose clock the caller moves, so two hooks in one run stamp two
 * distinguishable instants. Without that, "the SubagentStop's own end survived"
 * and "the terminal close overwrote it" are the same string.
 */
function lifecycleWithMovableClock(prisma: OpenTestPrisma["prisma"]): {
  lifecycle: Lifecycle;
  setNow: (value: string) => void;
} {
  let clock = NOW;
  const lifecycle = createSqliteLifecycle(
    prisma,
    createSqliteTokenUsageStore(prisma),
    {
      detectBillingMode: () => "unknown",
      log: () => undefined,
      now: () => clock,
    }
  );
  return {
    lifecycle,
    setNow: (value: string) => {
      clock = value;
    },
  };
}

async function selectSubagents(
  store: OpenTestPrisma["db"]
): Promise<AgentRow[]> {
  const result = await store.query<AgentRow>(
    "SELECT id, name, status, ended_at FROM agents WHERE session_id = $1 AND type = 'subagent' ORDER BY name",
    [SESSION_ID]
  );
  return result.rows;
}

async function startSessionWithSubagent(
  lifecycle: Lifecycle,
  description: string
): Promise<void> {
  await lifecycle.processEvent(
    "PreToolUse",
    {
      session_id: SESSION_ID,
      tool_name: "Task",
      tool_input: { description, subagent_type: "worker" },
    },
    "claude"
  );
}

/**
 * The `agent_id` each recorded `SubagentStop` event carries, oldest first.
 *
 * This is the observable the attribution contract is written on: an unmatched
 * stop is still INSERTED, just with a null agent, so "the event exists" proves
 * nothing and only the column distinguishes matched from unattributed.
 */
async function subagentStopAgentIds(
  store: OpenTestPrisma["db"]
): Promise<(string | null)[]> {
  const result = await store.query<{ agent_id: string | null }>(
    "SELECT agent_id FROM events WHERE session_id = $1 AND event_type = 'SubagentStop' ORDER BY created_at",
    [SESSION_ID]
  );
  return result.rows.map((row) => row.agent_id);
}

/** SessionStart + a user turn, after which the main agent is `working`. */
async function openSession(lifecycle: Lifecycle): Promise<void> {
  await lifecycle.processEvent(
    "SessionStart",
    { session_id: SESSION_ID, cwd: "/tmp/iss6902" },
    "claude"
  );
  await lifecycle.processEvent(
    "UserPromptSubmit",
    { session_id: SESSION_ID },
    "claude"
  );
}

test("ISS-6902: Stop(error) closes the session's subagents, not just the main agent", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const { lifecycle } = lifecycleWithMovableClock(prisma);
    await openSession(lifecycle);
    await startSessionWithSubagent(lifecycle, FIRST_SUBAGENT);

    // Proves the fixture really strands something: "nothing is stuck at
    // working" is vacuously true of a session that never spawned a subagent.
    const before = await selectSubagents(store);
    assert.equal(before.length, 1, "the fixture spawned exactly one subagent");
    assert.equal(
      before[0].status,
      "working",
      "the subagent is working when the terminal Stop lands"
    );

    const processed = await lifecycle.processEvent(
      "Stop",
      { session_id: SESSION_ID, stop_reason: "error" },
      "claude"
    );
    assert.equal(processed, true, "the Stop hook transaction committed");

    // The terminal declaration this hook is responsible for still happens.
    assert.equal((await getSession(store, SESSION_ID))?.status, "error");
    assert.equal(
      (await getAgent(store, MAIN_AGENT_ID))?.status,
      "error",
      "the main agent still carries the run's failure"
    );

    const subagent = await getAgent(store, before[0].id);
    assert.ok(subagent, "the subagent row survives the Stop");
    assert.notEqual(
      subagent.status,
      "working",
      "no agent of a terminal session may still be running"
    );
    // `completed`, not `error`: the run failed, this subagent did not — the same
    // call `sweepStaleChunk` makes for the subagents of an error-ending session.
    assert.equal(subagent.status, "completed");
    assert.equal(
      subagent.ended_at,
      NOW,
      "the closed subagent gets an end, so its duration is derivable"
    );
  } finally {
    await close();
  }
});

/*
 * The half the ticket is actually about: "and they sync that way". The payload is
 * hydrated from `agents` at drain time, so a session already sitting in the
 * outbox picks the corrected row up — but only if the row was corrected at all.
 */
test("ISS-6902: the cloud payload for an errored session carries no working agent", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const { lifecycle } = lifecycleWithMovableClock(prisma);
    await openSession(lifecycle);
    await startSessionWithSubagent(lifecycle, FIRST_SUBAGENT);
    const before = await selectSubagents(store);
    assert.equal(
      before[0]?.status,
      "working",
      "the subagent is working when the terminal Stop lands"
    );
    await lifecycle.processEvent(
      "Stop",
      { session_id: SESSION_ID, stop_reason: "error" },
      "claude"
    );

    const [session] = await createSqliteSessionSyncSource(
      prisma
    ).loadSyncedSessions([SESSION_ID], emptyAttributionCache());
    assert.ok(session, "the errored session hydrated for sync");

    const syncedSubagent = session.agents?.find(
      (row) => row.externalAgentId === before[0].id
    );
    assert.ok(syncedSubagent, "the subagent is in the payload");
    assert.notEqual(
      syncedSubagent.status,
      "working",
      "the cloud is never told a finished subagent is still working"
    );
    assert.equal(syncedSubagent.status, "completed");

    const syncedMain = session.agents?.find(
      (row) => row.externalAgentId === MAIN_AGENT_ID
    );
    assert.equal(
      syncedMain?.status,
      "error",
      "the main agent still syncs error"
    );
  } finally {
    await close();
  }
});

/*
 * The inverse failure, and the reason the close carries a `NOT IN` guard: a
 * subagent that reported its OWN outcome must keep it. Without the guard the
 * broom would overwrite that subagent's real end with the Stop's clock — the
 * same wrong-value-on-the-wire defect this ticket exists to remove, inverted.
 */
test("ISS-6902: a subagent that already stopped keeps its own end when Stop(error) lands", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const { lifecycle, setNow } = lifecycleWithMovableClock(prisma);
    await openSession(lifecycle);
    await startSessionWithSubagent(lifecycle, FIRST_SUBAGENT);
    await startSessionWithSubagent(lifecycle, SECOND_SUBAGENT);

    // Only the SECOND one reports its own stop, at its own instant.
    setNow(SUBAGENT_STOP_AT);
    await lifecycle.processEvent(
      "SubagentStop",
      { session_id: SESSION_ID, description: SECOND_SUBAGENT },
      "claude"
    );
    setNow(NOW);

    const before = await selectSubagents(store);
    assert.equal(before.length, 2, "the fixture spawned two subagents");
    const [firstBefore, secondBefore] = before;
    assert.equal(firstBefore.name, FIRST_SUBAGENT);
    assert.equal(
      firstBefore.status,
      "working",
      "the first subagent is still running when the Stop lands"
    );
    assert.equal(secondBefore.name, SECOND_SUBAGENT);
    assert.equal(
      secondBefore.status,
      "completed",
      "the second subagent reported its own outcome before the Stop"
    );

    await lifecycle.processEvent(
      "Stop",
      { session_id: SESSION_ID, stop_reason: "error" },
      "claude"
    );

    // The positive half: the still-running one IS closed, at the Stop's clock.
    const first = await getAgent(store, firstBefore.id);
    assert.equal(first?.status, "completed");
    assert.equal(first?.ended_at, NOW, "the stranded subagent is closed now");

    // The guarded half: the self-reported one is untouched. Asserting its END
    // rather than its status is what makes this test kill the mutation — both
    // rows read `completed`, so only the timestamp distinguishes them.
    const second = await getAgent(store, secondBefore.id);
    assert.equal(second?.status, "completed");
    assert.equal(
      second?.ended_at,
      SUBAGENT_STOP_AT,
      "its own end survives the terminal broom"
    );
    assert.notEqual(second?.ended_at, NOW);
  } finally {
    await close();
  }
});

/*
 * The arm the shared helper was extracted FROM. Every pre-existing SessionEnd
 * suite drives a subagent that already reached `completed` via SubagentStop, so
 * none of them observes a subagent crossing from `working` to terminal inside
 * SessionEnd — the extraction would be unproven without this.
 */
test("ISS-6902: SessionEnd still closes a running subagent after the shared extraction", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const { lifecycle } = lifecycleWithMovableClock(prisma);
    await openSession(lifecycle);
    await startSessionWithSubagent(lifecycle, FIRST_SUBAGENT);
    const before = await selectSubagents(store);
    assert.equal(
      before[0]?.status,
      "working",
      "the subagent is working when SessionEnd lands"
    );

    await lifecycle.processEvent(
      "SessionEnd",
      { session_id: SESSION_ID },
      "claude"
    );

    assert.equal((await getSession(store, SESSION_ID))?.status, "inactive");
    const subagent = await getAgent(store, before[0].id);
    assert.notEqual(subagent?.status, "working");
    assert.equal(subagent?.status, "completed");
    assert.equal(subagent?.ended_at, NOW);
    assert.equal(
      (await getAgent(store, MAIN_AGENT_ID))?.status,
      "completed",
      "the main agent is closed by the same statement"
    );
  } finally {
    await close();
  }
});

/*
 * The cost of closing the subagents, and the reason `matchSubagent` had to widen
 * with them. Before this ticket a late `SubagentStop` carrying no native
 * subagent id found its row in `matchSubagent`'s non-native candidate set,
 * because that set is `working`-only and the Stop had left the subagent there.
 * Closing the subagent empties that set, so the same stop would resolve to a
 * NULL agent — losing the event's attribution and, with it, the whole
 * `if (agentId && data.transcript_path)` sidecar-transcript ingest below it.
 *
 * The fix searches the `completed` rows too — the set the native-id path has
 * always searched — so the close no longer costs the match.
 */
test("ISS-6902: a late non-native SubagentStop still resolves after Stop(error) closed its row", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const { lifecycle, setNow } = lifecycleWithMovableClock(prisma);
    await openSession(lifecycle);
    await startSessionWithSubagent(lifecycle, FIRST_SUBAGENT);

    await lifecycle.processEvent(
      "Stop",
      { session_id: SESSION_ID, stop_reason: "error" },
      "claude"
    );

    // The precondition the match now has to survive. Asserting it here is what
    // stops this test passing for the boring reason: if the broom ever stopped
    // closing subagents, the stop below would match a `working` row and the
    // widened search would never be exercised at all.
    const [subagent] = await selectSubagents(store);
    assert.equal(
      subagent?.status,
      "completed",
      "the terminal Stop closed the subagent, emptying the working candidate set"
    );

    // No native id anywhere in the payload, so `extractNativeSubagentId`
    // returns null and this takes the non-native path under test.
    setNow(LATE_SUBAGENT_STOP_AT);
    const processed = await lifecycle.processEvent(
      "SubagentStop",
      { session_id: SESSION_ID, description: FIRST_SUBAGENT },
      "claude"
    );
    assert.equal(processed, true, "the late SubagentStop committed");

    assert.deepEqual(
      await subagentStopAgentIds(store),
      [subagent.id],
      "the late stop is attributed to the subagent it names, not recorded against a null agent"
    );
    // The same `agentId` gates sidecar ingest, and it is the only thing that
    // does — so a null there is not a cosmetic attribution loss.
    assert.equal(
      (await getAgent(store, subagent.id))?.ended_at,
      LATE_SUBAGENT_STOP_AT,
      "the matched row took the stop's own end, as the native-id path already does"
    );
  } finally {
    await close();
  }
});

/*
 * The other half of "narrow". Widening the candidate set without also pinning
 * the positional last resort would let an unidentifiable stop be charged to
 * whichever closed subagent happened to start most recently. A guess among
 * `working` rows is a fallback; a guess among finished ones is a misattribution,
 * so this stop must stay unattributed.
 */
test("ISS-6902: an unidentifiable stop is not charged to an arbitrary closed subagent", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const { lifecycle, setNow } = lifecycleWithMovableClock(prisma);
    await openSession(lifecycle);
    await startSessionWithSubagent(lifecycle, FIRST_SUBAGENT);
    await startSessionWithSubagent(lifecycle, SECOND_SUBAGENT);

    await lifecycle.processEvent(
      "Stop",
      { session_id: SESSION_ID, stop_reason: "error" },
      "claude"
    );
    const closed = await selectSubagents(store);
    assert.equal(
      closed.length,
      2,
      "two closed subagents are available to guess at"
    );
    assert.ok(
      closed.every((row) => row.status === "completed"),
      "both are closed, so any match must come from the widened set"
    );

    setNow(LATE_SUBAGENT_STOP_AT);
    await lifecycle.processEvent(
      "SubagentStop",
      { session_id: SESSION_ID, description: UNKNOWN_SUBAGENT },
      "claude"
    );

    assert.deepEqual(
      await subagentStopAgentIds(store),
      [null],
      "a stop naming no known subagent stays unattributed"
    );
    for (const row of closed) {
      assert.equal(
        (await getAgent(store, row.id))?.ended_at,
        NOW,
        "no closed subagent had its end rewritten by a stop that did not name it"
      );
    }
  } finally {
    await close();
  }
});
