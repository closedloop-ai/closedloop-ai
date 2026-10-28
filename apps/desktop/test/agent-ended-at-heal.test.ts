/**
 * @file agent-ended-at-heal.test.ts
 * @description ISS-7069: WHAT the repair computes, for agents the PRE-ISS-6893
 * sweep ended EARLIER than their own last event.
 *
 * ISS-6893 fixed the forward path only. Agents swept by an earlier release keep
 * the byte-wise value, and it is ALREADY exported to the cloud, so a local-only
 * repair is not a repair. Ordinary reimport does not reach the population at
 * all: `advanceTerminalEndedAt` updates `WHERE id = mainId` and only advances to
 * the session's parsed end, touching no subagent and never re-deriving from
 * events. The live sweep excludes terminal agents by construction.
 *
 * This file owns the VALUE: which agents are discovered, and what they are
 * re-derived to. Its two siblings own the other halves —
 * `agent-ended-at-heal-scope.test.ts` (the rows the pass declines to judge) and
 * `agent-ended-at-heal-delivery.test.ts` (how the correction is delivered to the
 * cloud and executed). The corpus shapes all three share, and why each one
 * exists, live in `agent-ended-at-heal-fixtures.ts`.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { healSweptAgentEndedAt } from "../src/main/database/agent-ended-at-heal.js";
import { DESKTOP_AGENT_STATUS } from "../src/main/database/db-constants.js";
import { chunkWatermark } from "../src/main/database/session-sync-watermark.js";
import {
  AGENT_STARTED_AT,
  BYTE_WISE_ENDED_AT,
  CHRONOLOGICAL_ENDED_AT,
  LATER_CANONICAL_EVENT,
  noopLog,
  OFFSET_STORED_ENDED_AT,
  OLD_UPDATED_AT,
  seedInactiveSession,
  seedMixedEncodingEvents,
  seedSweptRun,
} from "./agent-ended-at-heal-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import {
  getAgent,
  getSession,
  NOW,
  seedAgent,
  seedAgentEvent,
} from "./session-sweep-fixtures.js";

test("ISS-7069: an already-swept MAIN agent is re-derived to the chronological end", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSweptRun(store);

    const result = await healSweptAgentEndedAt(prisma, NOW, noopLog);
    assert.deepEqual(result, {
      healed: 2,
      failedChunks: 0,
      unreadable: 0,
      legacy: 0,
    });

    const main = await getAgent(store, "main-agent");
    assert.equal(main?.ended_at, CHRONOLOGICAL_ENDED_AT);
    // The byte-wise winner is the EARLIER instant, and is never the answer.
    assert.notEqual(main?.ended_at, BYTE_WISE_ENDED_AT);
    // The user-visible half: the derived duration stops being 4.5h short.
    assert.equal(
      new Date(main?.ended_at ?? 0).valueOf() -
        new Date(AGENT_STARTED_AT).valueOf(),
      9.5 * 60 * 60 * 1000
    );
  } finally {
    await close();
  }
});

/*
 * THE LOAD-BEARING CASE. A subagent is unreachable by reimport: a DATA_REVISION
 * rebuild's `advanceTerminalEndedAt` updates `WHERE id = mainId`, so no bump can
 * ever correct this row. If this repair only walked `type = 'main'` — the shape
 * that mirrors the existing reimport path — the assertion below is the one that
 * fails, and the main-agent test above still passes.
 */
test("ISS-7069: an already-swept SUBAGENT is re-derived too — the population reimport cannot reach", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSweptRun(store);

    await healSweptAgentEndedAt(prisma, NOW, noopLog);

    const sub = await getAgent(store, "sub-agent");
    assert.equal(
      sub?.ended_at,
      CHRONOLOGICAL_ENDED_AT,
      "the subagent is re-derived from its OWN events"
    );
    assert.notEqual(sub?.ended_at, BYTE_WISE_ENDED_AT);
  } finally {
    await close();
  }
});

/*
 * Idempotency asserted as an EFFECT, not as "it did not throw": the second run
 * must heal NOTHING and must leave both the corrected value and the session's
 * sync watermark byte-identical, so a re-boot cannot churn the sync cursor.
 */
test("ISS-7069: the heal converges — a second run heals nothing and re-emits nothing", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSweptRun(store);

    const first = await healSweptAgentEndedAt(prisma, NOW, noopLog);
    assert.equal(first.healed, 2);
    const healedValue = (await getAgent(store, "main-agent"))?.ended_at;
    const bumped = (await getSession(store, "run"))?.updated_at;
    assert.equal(bumped, chunkWatermark(NOW, 0));

    const later = "2026-06-23T12:00:00.000Z";
    const second = await healSweptAgentEndedAt(prisma, later, noopLog);
    assert.deepEqual(second, {
      healed: 0,
      failedChunks: 0,
      unreadable: 0,
      legacy: 0,
    });
    assert.equal(
      (await getAgent(store, "main-agent"))?.ended_at,
      healedValue,
      "the corrected value is untouched by the second run"
    );
    assert.equal(
      (await getSession(store, "run"))?.updated_at,
      bumped,
      "the session is NOT re-queued to the cloud a second time"
    );
  } finally {
    await close();
  }
});

/*
 * An agent whose stored value is ALREADY the chronological end must not be
 * re-emitted — its session must keep its old `updated_at`, or every boot after
 * an upgrade re-uploads a corpus that never changed. This is also the post-heal
 * state, so it is the convergence proof from the other direction.
 */
test("ISS-7069: an already-correct agent is neither rewritten nor re-queued", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedInactiveSession(store, "run");
    // Mixed encodings, so the cheap suspect gate DOES fire and the fold really
    // is evaluated — the row is skipped on the comparison, not on the gate.
    await seedAgent(
      store,
      "worker",
      "run",
      DESKTOP_AGENT_STATUS.COMPLETED,
      AGENT_STARTED_AT,
      "main",
      CHRONOLOGICAL_ENDED_AT
    );
    await seedMixedEncodingEvents(store, "run", "worker");

    const result = await healSweptAgentEndedAt(prisma, NOW, noopLog);
    assert.deepEqual(result, {
      healed: 0,
      failedChunks: 0,
      unreadable: 0,
      legacy: 0,
    });
    assert.equal(
      (await getSession(store, "run"))?.updated_at,
      OLD_UPDATED_AT,
      "a correct row is not re-emitted to the cloud"
    );
  } finally {
    await close();
  }
});

/*
 * The repair is a monotone ADVANCE, and that is what makes it safe on a
 * population nothing durably marks as "swept". An agent closed by the importer
 * from the session's own end, LATER than any of its own events, must keep that
 * value — re-deriving it would DESTROY a good stamp.
 */
test("ISS-7069: an agent ended LATER than its own last event is never moved backward", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const importerEnd = "2026-06-22T20:00:00.000Z";
    await seedInactiveSession(store, "run");
    await seedAgent(
      store,
      "worker",
      "run",
      DESKTOP_AGENT_STATUS.COMPLETED,
      AGENT_STARTED_AT,
      "main",
      importerEnd
    );
    await seedMixedEncodingEvents(store, "run", "worker");

    const result = await healSweptAgentEndedAt(prisma, NOW, noopLog);
    assert.equal(result.healed, 0);
    assert.equal(
      (await getAgent(store, "worker"))?.ended_at,
      importerEnd,
      "a good later stamp survives the heal"
    );
  } finally {
    await close();
  }
});

/*
 * ISS-5182's floor, preserved through the repair. Every event predates the
 * agent's own `started_at`, and the pre-fix sweep left a PRE-START `ended_at`.
 * The corrected value is the canonicalized start, never an earlier event.
 */
test("ISS-7069: the ended_at >= started_at floor is preserved by the repair", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedInactiveSession(store, "run");
    await seedAgent(
      store,
      "worker",
      "run",
      DESKTOP_AGENT_STATUS.COMPLETED,
      AGENT_STARTED_AT,
      "main",
      "2026-06-22T01:00:00.000Z"
    );
    // Both events predate the 05:00Z start, and their TEXTUAL and CHRONOLOGICAL
    // maxima are still DIFFERENT ROWS: `…T04:00:00+05:30` sorts highest but is
    // 2026-06-21T22:30Z, while `…T01:00:00.000Z` is the later instant. So the
    // floor is proved against the canonical arm, not against a pair that both
    // folds would rank identically.
    await seedAgentEvent(
      store,
      "ev-0",
      "run",
      "worker",
      "2026-06-22T01:00:00.000Z"
    );
    await seedAgentEvent(
      store,
      "ev-1",
      "run",
      "worker",
      "2026-06-22T04:00:00+05:30"
    );

    const result = await healSweptAgentEndedAt(prisma, NOW, noopLog);
    assert.equal(result.healed, 1);
    assert.equal(
      (await getAgent(store, "worker"))?.ended_at,
      AGENT_STARTED_AT,
      "floored to the agent's own start, not moved to an earlier event"
    );
    assert.ok(
      new Date((await getAgent(store, "worker"))?.ended_at ?? 0).valueOf() >=
        new Date(AGENT_STARTED_AT).valueOf(),
      "duration is never negative"
    );
  } finally {
    await close();
  }
});

/*
 * The stored side of the comparison, which a canonical-only corpus never
 * exercises. Every other fixture here stores an already-canonical `ended_at`, so
 * `canonicalizeHealableTimestampSql("ended_at")` is the IDENTITY in all of them
 * and replacing it with a bare `ended_at` column would keep them green. Here the
 * stored value is the raw offset form the pre-fix sweep actually persisted:
 * comparing it byte-wise puts `…T18:00:00.000Z` BELOW `…T20:00:00+05:30`, so the
 * agent is never discovered and stays 3.5h short.
 */
test("ISS-7069: an agent whose STORED ended_at is offset-form is discovered and healed", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedInactiveSession(store, "run");
    await seedAgent(
      store,
      "worker",
      "run",
      DESKTOP_AGENT_STATUS.COMPLETED,
      AGENT_STARTED_AT,
      "subagent",
      OFFSET_STORED_ENDED_AT
    );
    await seedAgentEvent(
      store,
      "ev-0",
      "run",
      "worker",
      OFFSET_STORED_ENDED_AT
    );
    await seedAgentEvent(store, "ev-1", "run", "worker", LATER_CANONICAL_EVENT);

    const result = await healSweptAgentEndedAt(prisma, NOW, noopLog);
    assert.deepEqual(result, {
      healed: 1,
      failedChunks: 0,
      unreadable: 0,
      legacy: 0,
    });
    assert.equal(
      (await getAgent(store, "worker"))?.ended_at,
      LATER_CANONICAL_EVENT,
      "the stored offset form is 14:30Z, so 18:00Z is the real end"
    );
    assert.notEqual(
      (await getAgent(store, "worker"))?.ended_at,
      OFFSET_STORED_ENDED_AT
    );
    assert.equal(
      (await getSession(store, "run"))?.updated_at,
      chunkWatermark(NOW, 0),
      "and the correction is re-queued to the cloud"
    );
  } finally {
    await close();
  }
});

/*
 * The OTHER operand of the fold, which an events-only suspect gate never sees.
 * The pre-fix sweep's `MAX()` folded the raw `started_at` floor TOGETHER with the
 * raw event maximum, so a non-canonical START alone is enough to make the
 * byte-wise winner disagree with the chronological one — every event here is
 * already canonical. `…T20:00:00+05:30` is 14:30Z but sorts ABOVE
 * `…T18:00:00.000Z` (18:00Z), so the old sweep stored the START and ended the
 * agent 3.5h BEFORE its own last event.
 */
test("ISS-7069: an agent whose STARTED_AT is offset-form is discovered though every event is canonical", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedInactiveSession(store, "run");
    await seedAgent(
      store,
      "worker",
      "run",
      DESKTOP_AGENT_STATUS.COMPLETED,
      OFFSET_STORED_ENDED_AT,
      "main",
      OFFSET_STORED_ENDED_AT
    );
    // The ONLY event, and it is canonical — so the events-only `EXISTS` gate is
    // false and this row is invisible to a discovery that looks no further.
    await seedAgentEvent(store, "ev-0", "run", "worker", LATER_CANONICAL_EVENT);

    const result = await healSweptAgentEndedAt(prisma, NOW, noopLog);
    assert.deepEqual(result, {
      healed: 1,
      failedChunks: 0,
      unreadable: 0,
      legacy: 0,
    });
    assert.equal(
      (await getAgent(store, "worker"))?.ended_at,
      LATER_CANONICAL_EVENT,
      "the agent no longer ends 3.5h before its own last event"
    );
    assert.equal(
      (await getSession(store, "run"))?.updated_at,
      chunkWatermark(NOW, 0),
      "and the correction is re-queued to the cloud"
    );
  } finally {
    await close();
  }
});
