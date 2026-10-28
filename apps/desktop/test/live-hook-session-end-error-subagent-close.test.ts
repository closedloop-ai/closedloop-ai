/**
 * @file live-hook-session-end-error-subagent-close.test.ts
 * @description ISS-7658: the forward path that was still MINTING the population
 * ISS-7474 heals.
 *
 * ISS-6902 stopped `Stop(error)` closing a session's in-flight subagents at
 * `error`. `SessionEnd`'s error arm still did it. A subagent closed at `error`
 * sits outside BOTH of `matchSubagent`'s candidate sets (`working` and
 * `completed`), so a late `SubagentStop` resolves to a NULL agent — the event
 * loses its attribution and the `if (agentId && data.transcript_path)` guard
 * skips the whole sidecar-transcript ingest. Silent data loss, and a heal
 * running against a source that keeps re-emitting it never converges.
 *
 * Every pre-existing `SessionEnd` suite drives a subagent that already reached
 * `completed` via its own `SubagentStop`, and the one `working` -> terminal case
 * (`live-hook-terminal-subagent-close.test.ts`) lands on the INACTIVE arm. None
 * of them observes a subagent crossing into a terminal status on the ERROR arm,
 * which is the arm that was wrong — so every fixture here spawns a subagent and
 * asserts it is still `working` at the instant `SessionEnd` lands.
 *
 * Status values are written as literals on purpose: they are the persisted
 * column values and the wire values the cloud reads, so asserting them through
 * the same const the production statement interpolates would stay green if that
 * const's value changed.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { createSqliteLifecycle } from "../src/main/database/live-hook.js";
import { createSqliteTokenUsageStore } from "../src/main/database/read-stores.js";
import type { OpenTestPrisma } from "./prisma-test-utils.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import { getAgent, getSession, NOW } from "./session-sweep-fixtures.js";

const SESSION_ID = "iss7658-session";
const MAIN_AGENT_ID = `${SESSION_ID}-main`;
const TRANSCRIPT_PATH = "/fake/iss7658.jsonl";
/** Strictly before {@link NOW}, so an end stamped here is distinguishable. */
const SUBAGENT_STOP_AT = "2026-06-22T11:00:00.000Z";
/** Strictly AFTER {@link NOW}: a SubagentStop that lands past the SessionEnd. */
const LATE_SUBAGENT_STOP_AT = "2026-06-22T13:00:00.000Z";
const FIRST_SUBAGENT = "first subagent";
const SECOND_SUBAGENT = "second subagent";

type AgentRow = { id: string; name: string; status: string; ended_at: string };

type Lifecycle = ReturnType<typeof createSqliteLifecycle>;

/**
 * A lifecycle whose transcript extract reports a trailing unrecovered API error,
 * which is what drives `SessionEnd` down its ERROR arm, and whose clock the
 * caller moves so two hooks in one run stamp two distinguishable instants.
 */
function errorEndingLifecycle(prisma: OpenTestPrisma["prisma"]): {
  lifecycle: Lifecycle;
  setNow: (value: string) => void;
} {
  let clock = NOW;
  const lifecycle = createSqliteLifecycle(
    prisma,
    createSqliteTokenUsageStore(prisma),
    {
      detectBillingMode: () => "unknown",
      extractTranscript: () => ({
        tokensByModel: new Map(),
        latestModel: null,
        compactionCount: 0,
        records: [],
        hasTrailingApiError: true,
      }),
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

/**
 * The `agent_id` each recorded `SubagentStop` event carries, oldest first. An
 * unmatched stop is still INSERTED, just with a null agent, so "the event
 * exists" proves nothing and only this column separates matched from lost.
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
    {
      session_id: SESSION_ID,
      cwd: "/tmp/iss7658",
      transcript_path: TRANSCRIPT_PATH,
    },
    "claude"
  );
  await lifecycle.processEvent(
    "UserPromptSubmit",
    { session_id: SESSION_ID, transcript_path: TRANSCRIPT_PATH },
    "claude"
  );
}

async function spawnSubagent(
  lifecycle: Lifecycle,
  description: string
): Promise<void> {
  await lifecycle.processEvent(
    "PreToolUse",
    {
      session_id: SESSION_ID,
      tool_name: "Task",
      tool_input: { description, subagent_type: "worker" },
      transcript_path: TRANSCRIPT_PATH,
    },
    "claude"
  );
}

async function endSession(lifecycle: Lifecycle): Promise<boolean> {
  return await lifecycle.processEvent(
    "SessionEnd",
    { session_id: SESSION_ID, transcript_path: TRANSCRIPT_PATH },
    "claude"
  );
}

test("ISS-7658: SessionEnd's error arm closes a running subagent `completed`, not `error`", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const { lifecycle } = errorEndingLifecycle(prisma);
    await openSession(lifecycle);
    await spawnSubagent(lifecycle, FIRST_SUBAGENT);

    // Proves the fixture strands something on the arm under test: the pre-existing
    // SessionEnd suites all drive an already-`completed` subagent, which crosses
    // nothing, and the one that does cross lands on the INACTIVE arm.
    const before = await selectSubagents(store);
    assert.equal(before.length, 1, "the fixture spawned exactly one subagent");
    assert.equal(
      before[0].status,
      "working",
      "the subagent is working when SessionEnd lands"
    );
    assert.notEqual(
      (await getSession(store, SESSION_ID))?.status,
      "error",
      "the session is non-terminal, so SessionEnd performs the error transition itself"
    );

    assert.equal(await endSession(lifecycle), true, "the SessionEnd committed");

    // The terminal declaration this hook is responsible for still happens.
    assert.equal(
      (await getSession(store, SESSION_ID))?.status,
      "error",
      "the trailing API error still ends the session in error"
    );
    assert.equal(
      (await getAgent(store, MAIN_AGENT_ID))?.status,
      "error",
      "the main agent still carries the run's failure"
    );

    const subagent = await getAgent(store, before[0].id);
    assert.ok(subagent, "the subagent row survives the SessionEnd");
    assert.notEqual(
      subagent.status,
      "working",
      "no agent of a terminal session may still be running"
    );
    // The defect: `error` here is outside both `matchSubagent` candidate sets.
    // The RUN failed; this subagent individually did not.
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
 * The consequence the status value actually buys, and the reason `error` is a
 * defect rather than a labelling preference. `matchSubagent`'s non-native search
 * admits `working` and `completed` only, so a subagent closed at `error` cannot
 * be found by a late stop: the event is recorded against a NULL agent and the
 * `if (agentId && data.transcript_path)` guard skips the sidecar ingest with it.
 */
test("ISS-7658: a late SubagentStop still resolves after SessionEnd's error arm closed its row", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const { lifecycle, setNow } = errorEndingLifecycle(prisma);
    await openSession(lifecycle);
    await spawnSubagent(lifecycle, FIRST_SUBAGENT);
    assert.equal(
      (await selectSubagents(store))[0]?.status,
      "working",
      "the subagent is working when SessionEnd lands"
    );

    await endSession(lifecycle);

    // Stops this passing for the boring reason: if the close ever stopped
    // touching subagents, the stop below would match a still-`working` row and
    // the terminal-status question would never be exercised at all.
    const [subagent] = await selectSubagents(store);
    assert.equal(
      subagent?.status,
      "completed",
      "SessionEnd closed the subagent into the set matchSubagent admits"
    );

    // No native id anywhere in the payload, so this takes the non-native path.
    setNow(LATE_SUBAGENT_STOP_AT);
    assert.equal(
      await lifecycle.processEvent(
        "SubagentStop",
        {
          session_id: SESSION_ID,
          description: FIRST_SUBAGENT,
          transcript_path: TRANSCRIPT_PATH,
        },
        "claude"
      ),
      true,
      "the late SubagentStop committed"
    );

    assert.deepEqual(
      await subagentStopAgentIds(store),
      [subagent.id],
      "the late stop is attributed to the subagent it names, not recorded against a null agent"
    );
    assert.equal(
      (await getAgent(store, subagent.id))?.ended_at,
      LATE_SUBAGENT_STOP_AT,
      "the matched row took the stop's own end, so the match really landed"
    );
  } finally {
    await close();
  }
});

/*
 * The inverse failure, and the reason the close carries a `NOT IN` guard: a
 * subagent that reported its OWN outcome keeps it. Without the guard the broom
 * would overwrite that subagent's real end with the SessionEnd's clock — the
 * same wrong-value-on-the-wire defect, inverted. The ISS-6902 counterfactual for
 * this on the Stop arm was `+ actual '…T12:00:00.000Z' / - expected
 * '…T11:00:00.000Z'`.
 */
test("ISS-7658: a subagent that already stopped keeps its own end across an error SessionEnd", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const { lifecycle, setNow } = errorEndingLifecycle(prisma);
    await openSession(lifecycle);
    await spawnSubagent(lifecycle, FIRST_SUBAGENT);
    await spawnSubagent(lifecycle, SECOND_SUBAGENT);

    // Only the SECOND one reports its own stop, at its own instant.
    setNow(SUBAGENT_STOP_AT);
    await lifecycle.processEvent(
      "SubagentStop",
      {
        session_id: SESSION_ID,
        description: SECOND_SUBAGENT,
        transcript_path: TRANSCRIPT_PATH,
      },
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
      "the first subagent is still running when SessionEnd lands"
    );
    assert.equal(secondBefore.name, SECOND_SUBAGENT);
    assert.equal(
      secondBefore.status,
      "completed",
      "the second subagent reported its own outcome before SessionEnd"
    );

    await endSession(lifecycle);

    // The positive half: the still-running one IS closed, at SessionEnd's clock.
    const first = await getAgent(store, firstBefore.id);
    assert.equal(first?.status, "completed");
    assert.equal(first?.ended_at, NOW, "the stranded subagent is closed now");

    // The guarded half. Asserting its END rather than its status is what makes
    // this kill the mutation — both rows read `completed`, so only the
    // timestamp distinguishes them.
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
 * The main agent is the one row whose status DOES follow the run's outcome, and
 * the shared close is what keeps that split. Without this positive sibling,
 * "a subagent is never closed `error`" would be satisfiable by a close that
 * stopped writing `error` anywhere at all — including onto the main spine, where
 * the importer and `sweepStaleChunk` both expect to find it.
 *
 * The session reaches SessionEnd already `error`, so this also covers the OTHER
 * route into the error arm: `session.status === error` rather than a trailing
 * API error in the transcript.
 */
test("ISS-7658: an error SessionEnd splits `error` onto the main agent and `completed` onto its subagent", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const { lifecycle, setNow } = errorEndingLifecycle(prisma);
    await openSession(lifecycle);

    // Stop(error) declares the run failed, then a user turn revives the session
    // — which promotes the main agent back to `working`, so SessionEnd finds a
    // running main AND a running subagent to split between.
    setNow(SUBAGENT_STOP_AT);
    await lifecycle.processEvent(
      "Stop",
      {
        session_id: SESSION_ID,
        stop_reason: "error",
        transcript_path: TRANSCRIPT_PATH,
      },
      "claude"
    );
    setNow(NOW);
    await spawnSubagent(lifecycle, SECOND_SUBAGENT);

    const mainBefore = await getAgent(store, MAIN_AGENT_ID);
    assert.equal(
      mainBefore?.status,
      "working",
      "the user turn revived the main agent, so SessionEnd must close it"
    );
    const [stranded] = await selectSubagents(store);
    assert.equal(
      stranded?.status,
      "working",
      "the subagent is working when SessionEnd lands"
    );

    await endSession(lifecycle);

    assert.equal((await getSession(store, SESSION_ID))?.status, "error");
    const main = await getAgent(store, MAIN_AGENT_ID);
    assert.equal(
      main?.status,
      "error",
      "the run's failure still lands on the main spine"
    );
    assert.equal(main?.ended_at, NOW);
    assert.equal(
      (await getAgent(store, stranded.id))?.status,
      "completed",
      "the same statement pair closes the subagent completed, not error"
    );
  } finally {
    await close();
  }
});

/*
 * ISS-7658 AC4, stated as an observable rather than as a structural claim: the
 * two terminal arms must not be able to disagree about a subagent again. They
 * now share one close that does not take a subagent status at all, so no arm can
 * pass a different one — this drives BOTH arms over the identical fixture and
 * asserts they land on the same value.
 */
test("ISS-7658: Stop(error) and SessionEnd's error arm close a running subagent identically", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const { lifecycle } = errorEndingLifecycle(prisma);
    await openSession(lifecycle);
    await spawnSubagent(lifecycle, FIRST_SUBAGENT);
    assert.equal((await selectSubagents(store))[0]?.status, "working");
    await lifecycle.processEvent(
      "Stop",
      {
        session_id: SESSION_ID,
        stop_reason: "error",
        transcript_path: TRANSCRIPT_PATH,
      },
      "claude"
    );
    const viaStop = (await selectSubagents(store))[0]?.status;

    // A second session, same fixture, ended down the other terminal arm.
    const other = "iss7658-session-b";
    await lifecycle.processEvent(
      "SessionStart",
      {
        session_id: other,
        cwd: "/tmp/iss7658",
        transcript_path: "/fake/b.jsonl",
      },
      "claude"
    );
    await lifecycle.processEvent(
      "UserPromptSubmit",
      { session_id: other, transcript_path: "/fake/b.jsonl" },
      "claude"
    );
    await lifecycle.processEvent(
      "PreToolUse",
      {
        session_id: other,
        tool_name: "Task",
        tool_input: { description: FIRST_SUBAGENT, subagent_type: "worker" },
        transcript_path: "/fake/b.jsonl",
      },
      "claude"
    );
    const otherBefore = await store.query<AgentRow>(
      "SELECT id, name, status, ended_at FROM agents WHERE session_id = $1 AND type = 'subagent'",
      [other]
    );
    assert.equal(otherBefore.rows[0]?.status, "working");
    await lifecycle.processEvent(
      "SessionEnd",
      { session_id: other, transcript_path: "/fake/b.jsonl" },
      "claude"
    );
    assert.equal(
      (await getSession(store, other))?.status,
      "error",
      "the second session took the error arm too, so the arms are comparable"
    );
    const viaSessionEnd = (await getAgent(store, otherBefore.rows[0].id))
      ?.status;

    assert.equal(viaStop, "completed");
    assert.equal(
      viaSessionEnd,
      viaStop,
      "the two terminal arms close a running subagent at the same status"
    );
  } finally {
    await close();
  }
});

/*
 * The MAIN-agent half of the `NOT IN ('completed','error')` guard. The refactor
 * split one guarded UPDATE into two, so the fragment now needs a pin on EACH
 * statement — the subagent half is pinned above, and without this case the guard
 * could be deleted from the main-agent statement with every other test green.
 *
 * The surviving regression is the one the module docstring claims to cover: a
 * replayed terminal hook re-stamping an already-terminal main agent's `ended_at`
 * with the replay's clock, inflating the run's derived duration and syncing the
 * wrong end to the cloud. No reviving user turn here, so the main agent is still
 * terminal when SessionEnd lands.
 */
test("ISS-7658: a replayed terminal SessionEnd does not re-stamp an already-closed main agent", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const { lifecycle, setNow } = errorEndingLifecycle(prisma);
    await openSession(lifecycle);

    setNow(SUBAGENT_STOP_AT);
    await lifecycle.processEvent(
      "Stop",
      {
        session_id: SESSION_ID,
        stop_reason: "error",
        transcript_path: TRANSCRIPT_PATH,
      },
      "claude"
    );
    setNow(NOW);
    const before = await getAgent(store, MAIN_AGENT_ID);
    assert.equal(before?.status, "error");
    assert.equal(
      before?.ended_at,
      SUBAGENT_STOP_AT,
      "the main agent reported its own end before the replay"
    );

    await endSession(lifecycle);

    const after = await getAgent(store, MAIN_AGENT_ID);
    assert.equal(after?.status, "error");
    // Asserting the END, not the status, is what makes this kill the mutation:
    // the status reads `error` either way, so only the timestamp separates
    // "left alone" from "re-stamped at the replay's clock".
    assert.equal(
      after?.ended_at,
      SUBAGENT_STOP_AT,
      "an already-terminal main agent keeps the end it reported"
    );
    assert.notEqual(after?.ended_at, NOW);
  } finally {
    await close();
  }
});

/*
 * The `COALESCE(type, '')` discriminator. `agents.type` has been nullable since
 * `0001_init`, and sibling readers (`dashboard-queries.ts`,
 * `local-insights-agents.ts`) fold a NULL-type group, so the store treats such
 * rows as real. A bare `type != 'main'` is NULL for an untyped row, which would
 * match NEITHER statement and leave it `working` on a terminal session — exactly
 * the ISS-6902 stranding this function exists to prevent, and a regression
 * against the single pre-refactor UPDATE that closed it.
 *
 * Seeded directly because no writer in this repo emits a NULL type: the
 * population is legacy, which is precisely why no fixture built from live hooks
 * can cover it.
 */
test("ISS-7658: an untyped agent is still closed by the terminal SessionEnd", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const { lifecycle } = errorEndingLifecycle(prisma);
    await openSession(lifecycle);
    await store.query(
      "INSERT INTO agents (id, session_id, name, type, status, started_at, updated_at) VALUES ($1, $2, 'legacy untyped agent', NULL, 'working', $3, $3)",
      ["iss7658-untyped", SESSION_ID, SUBAGENT_STOP_AT]
    );
    const seeded = await store.query<{ type: string | null; status: string }>(
      "SELECT type, status FROM agents WHERE id = $1",
      ["iss7658-untyped"]
    );
    assert.equal(
      seeded.rows[0]?.type,
      null,
      "the fixture row really is untyped"
    );
    assert.equal(seeded.rows[0]?.status, "working");

    await endSession(lifecycle);

    const after = await getAgent(store, "iss7658-untyped");
    assert.notEqual(
      after?.status,
      "working",
      "no agent of a terminal session may still be running, typed or not"
    );
    assert.equal(
      after?.status,
      "completed",
      "an untyped agent is closed by the non-main statement, not left behind by both"
    );
    assert.equal(after?.ended_at, NOW);
  } finally {
    await close();
  }
});
