/**
 * @file agent-ended-at-heal-scope.test.ts
 * @description ISS-7069: the rows the repair declines to touch, and WHY.
 *
 * Sibling of `agent-ended-at-heal.test.ts` (what the repair computes) and
 * `agent-ended-at-heal-delivery.test.ts` (how the correction is delivered and
 * executed). This file owns the boundary: two classes the pass cannot JUDGE and
 * must therefore count rather than guess at, and two it must not judge at all
 * because they belong to another writer.
 *
 * The counted classes matter because both may still hold a too-early `ended_at`
 * that is ALREADY exported to cloud — so "this pass could not judge it" must
 * never be reported as the all-zeros "there was nothing to repair".
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { healSweptAgentEndedAt } from "../src/main/database/agent-ended-at-heal.js";
import { DESKTOP_AGENT_STATUS } from "../src/main/database/db-constants.js";
import {
  AGENT_STARTED_AT,
  BYTE_WISE_ENDED_AT,
  EARLIER_CANONICAL_EVENT,
  LEGACY_LOG_RE,
  noopLog,
  OLD_UPDATED_AT,
  seedInactiveSession,
  seedMixedEncodingEvents,
  seedSweptAgentIn,
  UNCANONICALIZABLE,
  UNREADABLE_LOG_RE,
} from "./agent-ended-at-heal-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import {
  getAgent,
  getSession,
  NOW,
  seedAgent,
  seedAgentEvent,
} from "./session-sweep-fixtures.js";

/*
 * LEGACY-MODE agents are deliberately out of scope, and that hole is pinned
 * rather than left to drift. One un-canonicalizable event drops the whole fold
 * to `main`'s byte-wise expression, and judging the row against THAT would be
 * the mixed-form byte comparison that IS the defect.
 */
test("ISS-7069: a legacy-mode agent is left exactly as main stored it", async () => {
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
      BYTE_WISE_ENDED_AT
    );
    await seedAgentEvent(
      store,
      "ev-0",
      "run",
      "worker",
      EARLIER_CANONICAL_EVENT
    );
    await seedAgentEvent(store, "ev-1", "run", "worker", UNCANONICALIZABLE);

    const logs: string[] = [];
    const result = await healSweptAgentEndedAt(prisma, NOW, (m) =>
      logs.push(m)
    );
    // COUNTED, not reported as an all-zeros no-op. This agent's own last event
    // is 15:30Z against a stored 10:00Z — 5.5h short and already exported — so
    // "could not judge" must not be indistinguishable from "nothing to repair".
    assert.deepEqual(result, {
      healed: 0,
      failedChunks: 0,
      unreadable: 0,
      legacy: 1,
    });
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? "", LEGACY_LOG_RE);
    assert.equal(
      (await getAgent(store, "worker"))?.ended_at,
      BYTE_WISE_ENDED_AT,
      "legacy mode keeps main's value verbatim"
    );
  } finally {
    await close();
  }
});

/*
 * ISS-6906's lesson: a row whose stored form cannot be safely interpreted is
 * COUNTED and reported, never re-keyed on a guess. The events here fold fine —
 * it is the STORED `ended_at` that SQLite cannot canonicalize, so no sound
 * comparison exists and the row must be reported rather than overwritten.
 */
test("ISS-7069: an un-canonicalizable stored ended_at is counted and reported, never rewritten", async () => {
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
      UNCANONICALIZABLE
    );
    await seedMixedEncodingEvents(store, "run", "worker");

    const logs: string[] = [];
    const result = await healSweptAgentEndedAt(prisma, NOW, (m) =>
      logs.push(m)
    );
    assert.deepEqual(result, {
      healed: 0,
      failedChunks: 0,
      unreadable: 1,
      legacy: 0,
    });
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? "", UNREADABLE_LOG_RE);
    assert.equal(
      (await getAgent(store, "worker"))?.ended_at,
      UNCANONICALIZABLE,
      "the unreadable value is left as stored, not guessed at"
    );
  } finally {
    await close();
  }
});

/*
 * The status boundary against the live sweep. `running`/`working` agents are the
 * sweep's population, not this pass's — the two partition the status space
 * exactly. A non-terminal agent carrying a stale `ended_at` and mixed-encoding
 * events must be left for the sweep, or this pass would hand a live agent a
 * terminal end.
 */
test("ISS-7069: a non-terminal agent is left to the live sweep", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    for (const [agentId, status] of [
      ["running-agent", DESKTOP_AGENT_STATUS.RUNNING],
      ["working-agent", DESKTOP_AGENT_STATUS.WORKING],
    ] as const) {
      await seedSweptAgentIn(store, "run", agentId, status, BYTE_WISE_ENDED_AT);
    }

    const result = await healSweptAgentEndedAt(prisma, NOW, noopLog);
    assert.deepEqual(result, {
      healed: 0,
      failedChunks: 0,
      unreadable: 0,
      legacy: 0,
    });
    for (const agentId of ["running-agent", "working-agent"]) {
      assert.equal(
        (await getAgent(store, agentId))?.ended_at,
        BYTE_WISE_ENDED_AT,
        `${agentId} is not this pass's population`
      );
    }
  } finally {
    await close();
  }
});

/*
 * The empty-population edge, pinned as behavior rather than left as an accident
 * of the suspect gate. An agent with NO events has nothing to re-derive from, so
 * its stored end is the only evidence there is and must survive untouched.
 */
test("ISS-7069: an agent with no events at all is never touched", async () => {
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
      BYTE_WISE_ENDED_AT
    );

    const result = await healSweptAgentEndedAt(prisma, NOW, noopLog);
    assert.deepEqual(result, {
      healed: 0,
      failedChunks: 0,
      unreadable: 0,
      legacy: 0,
    });
    assert.equal(
      (await getAgent(store, "worker"))?.ended_at,
      BYTE_WISE_ENDED_AT,
      "an event-less agent keeps its only evidence"
    );
    assert.equal((await getSession(store, "run"))?.updated_at, OLD_UPDATED_AT);
  } finally {
    await close();
  }
});
