/**
 * @file sweep-agent-ended-at-canonical.test.ts
 * @description ISS-6893: the stale sweep derives a swept agent's `ended_at`
 * from its own `events.created_at` rows — raw harness transcript text, and the
 * one timestamp column the FEA-3743 heal never repairs. That fold shipped as a
 * byte-wise `MAX()` over TEXT, so on a column holding MIXED encodings it
 * returned the EARLIER instant: `…:00Z` beats `…:00.500Z` (`Z` 0x5A sorts after
 * `.` 0x2E) and a `Z` value beats an offset value that is chronologically later.
 * A too-early `ended_at` SHORTENS the derived agent duration and is exported to
 * the cloud verbatim from the column, so the drift is persisted and replicated.
 *
 * ISS-5497 fixed exactly this for `sessions.last_activity_at` and left the agent
 * arm documented as a known gap; this suite pins the agent arm now reusing that
 * same two-mode expression.
 *
 * EVERY fixture here seeds events whose TEXTUAL max and CHRONOLOGICAL max are
 * DIFFERENT ROWS. That is the only fixture shape that can fail: a single-encoding
 * fixture passes under both the buggy and the fixed fold and proves nothing.
 */
import assert from "node:assert/strict";
import {
  InsightsPeriod,
  InsightsSection,
} from "@closedloop-ai/loops-api/insights";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { test } from "vitest";
import { DESKTOP_AGENT_STATUS } from "../src/main/database/db-constants.js";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import { sweepOrphanedSessions } from "../src/main/database/session-maintenance.js";
import { isCanonicalUtcTimestamp } from "../src/main/database/session-timestamp-form.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import { emptyAttributionCache } from "./attribution-test-helpers.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import {
  getAgent,
  NOW,
  STALE_UPDATED_AT,
  seedAgent,
  seedAgentEvent,
  seedSession,
} from "./session-sweep-fixtures.js";

const AGENT_STARTED_AT = "2026-06-22T05:00:00.000Z";

// SQLite cannot parse the BASIC-format offset even though V8 can, so ONE of
// these among an agent's events drops that agent's whole fold to legacy mode.
const UNCANONICALIZABLE_EVENT = "2026-06-22T21:00:00.000+0530";

/**
 * Seed one stale active session holding one running agent whose events carry the
 * given `created_at` texts, then sweep it. Returns the swept agent row.
 */
async function sweepAgentWithEvents(
  prisma: Awaited<ReturnType<typeof openTestPrisma>>["prisma"],
  store: Awaited<ReturnType<typeof openTestPrisma>>["db"],
  eventCreatedAts: readonly string[],
  startedAt: string = AGENT_STARTED_AT
) {
  await seedSession(
    store,
    "abandoned",
    SESSION_STATUS.ACTIVE,
    STALE_UPDATED_AT
  );
  await seedAgent(
    store,
    "worker",
    "abandoned",
    DESKTOP_AGENT_STATUS.RUNNING,
    startedAt
  );
  for (const [index, createdAt] of eventCreatedAts.entries()) {
    await seedAgentEvent(
      store,
      `ev-${index}`,
      "abandoned",
      "worker",
      createdAt
    );
  }

  const { swept } = await sweepOrphanedSessions(prisma, NOW);
  // Thrown rather than asserted: an assertion in a helper called outside a
  // `test()` body trips Biome's `noMisplacedAssertion`.
  if (swept !== 1) {
    throw new Error(`expected exactly one swept session, got ${swept}`);
  }

  return getAgent(store, "worker");
}

/*
 * The reported reproduction, on the agent arm. Two events a half-second apart,
 * spelled at different precisions. A byte-wise `MAX(e.created_at)` picks the
 * whole-second value — the EARLIER instant — which shortens the agent's derived
 * duration by 500ms.
 */
test("ISS-6893: mixed-precision agent events end at the LATER instant, not the higher bytes", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const agent = await sweepAgentWithEvents(prisma, store, [
      "2026-06-22T10:00:00.500Z",
      "2026-06-22T10:00:00Z",
    ]);

    assert.equal(agent?.status, DESKTOP_AGENT_STATUS.COMPLETED);
    assert.equal(
      agent?.ended_at,
      "2026-06-22T10:00:00.500Z",
      "the half-second-later event is the agent's real last activity"
    );
    // The byte-wise winner, which is the EARLIER instant — never the answer.
    assert.notEqual(agent?.ended_at, "2026-06-22T10:00:00Z");
    // Duration is derived as ended_at - started_at, so the shortening is the
    // user-visible half of the defect.
    assert.equal(
      new Date(agent?.ended_at ?? 0).valueOf() -
        new Date(AGENT_STARTED_AT).valueOf(),
      5 * 60 * 60_000 + 500
    );
  } finally {
    await close();
  }
});

/*
 * The other byte-wise failure on the same column: an offset-form value is a
 * LATER instant than a `Z` value whose text sorts above it. `2026-06-22T09:30`
 * at `-05:00` is 14:30Z — 4.5h AFTER 10:00Z — yet
 * `'2026-06-22T09:30:00-05:00'` sorts BELOW `'2026-06-22T10:00:00.000Z'`.
 */
test("ISS-6893: an offset-form agent event wins when it is the later instant, and lands as canonical UTC", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const agent = await sweepAgentWithEvents(prisma, store, [
      "2026-06-22T10:00:00.000Z",
      "2026-06-22T09:30:00-05:00",
    ]);

    assert.equal(
      agent?.ended_at,
      "2026-06-22T14:30:00.000Z",
      "the offset-form event is 14:30Z, the real last activity"
    );
    assert.ok(
      isCanonicalUtcTimestamp(agent?.ended_at ?? null),
      "the winner is written in canonical UTC form, not its stored offset text"
    );
    assert.notEqual(agent?.ended_at, "2026-06-22T10:00:00.000Z");
  } finally {
    await close();
  }
});

/*
 * ISS-5182's floor, under mixed encodings. Every event predates the agent's own
 * `started_at` (a resumed session whose agent inherits parent-transcript
 * timestamps), so `ended_at` must be floored to `started_at` rather than moved
 * BEFORE it — a negative duration. The events are mixed-encoding so the fixture
 * exercises the canonical arm, and the started_at is offset-form so the floor
 * itself has to be canonicalized before it can be compared.
 */
test("ISS-6893: the started_at floor still holds when the agent's own start is offset-form", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // 07:00 at -05:00 is 12:00Z, chronologically AFTER both events, and its raw
    // text sorts BELOW them — so a byte-wise floor would not fire at all.
    const agent = await sweepAgentWithEvents(
      prisma,
      store,
      ["2026-06-22T10:00:00.500Z", "2026-06-22T10:00:00Z"],
      "2026-06-22T07:00:00-05:00"
    );

    assert.equal(
      agent?.ended_at,
      "2026-06-22T12:00:00.000Z",
      "ended_at is floored to the agent's own start, in canonical form"
    );
    assert.ok(
      new Date(agent?.ended_at ?? 0).valueOf() >=
        new Date("2026-06-22T07:00:00-05:00").valueOf(),
      "duration is never negative"
    );
  } finally {
    await close();
  }
});

/*
 * The two modes are never mixed. One event SQLite cannot canonicalize (the
 * basic-format offset) drops the whole fold to the pre-ISS-5497 expression
 * VERBATIM — the byte-wise winner, stored text unchanged — because
 * canonicalizing only SOME operands lets an un-canonicalizable sibling out-sort
 * the true winner. This is `main`'s behavior, so the worst case of this change
 * is exactly what shipped.
 */
test("ISS-6893: one un-canonicalizable agent event drops the fold to legacy mode verbatim", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const agent = await sweepAgentWithEvents(prisma, store, [
      "2026-06-22T10:00:00.000Z",
      UNCANONICALIZABLE_EVENT,
    ]);

    assert.equal(
      agent?.ended_at,
      UNCANONICALIZABLE_EVENT,
      "legacy mode keeps the byte-wise winner, as stored, exactly as main did"
    );
  } finally {
    await close();
  }
});

/*
 * The half that makes this a data-integrity bug rather than a display one: the
 * corrected value is what the desktop hands the cloud. `loadSyncedSessions` maps
 * `agents.ended_at` straight onto the wire `endedAt`, and `ended_at` is in the
 * agents child-row fingerprint, so the correction is what gets replicated.
 */
test("ISS-6893: the corrected agent ended_at is what the cloud sync payload carries", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const agent = await sweepAgentWithEvents(prisma, store, [
      "2026-06-22T10:00:00.000Z",
      "2026-06-22T09:30:00-05:00",
    ]);
    assert.equal(agent?.ended_at, "2026-06-22T14:30:00.000Z");

    const syncSource = createSqliteSessionSyncSource(prisma);
    const [session] = await syncSource.loadSyncedSessions(
      ["abandoned"],
      emptyAttributionCache()
    );
    assert.ok(session, "the swept session hydrated for sync");

    const syncedAgent = session.agents?.find(
      (row) => row.externalAgentId === "worker"
    );
    assert.ok(syncedAgent, "the swept agent is in the payload");
    assert.equal(
      syncedAgent.endedAt,
      "2026-06-22T14:30:00.000Z",
      "the cloud receives the chronological end, not the byte-wise one"
    );
    assert.notEqual(syncedAgent.endedAt, "2026-06-22T10:00:00.000Z");
  } finally {
    await close();
  }
});

/*
 * Scope guard, CANONICAL arm: the fold is per-AGENT, so a sibling agent's later
 * event must not bleed into this agent's end. Mixed-encoding on the worker so
 * the assertion cannot pass merely because the encodings agree.
 */
test("ISS-6893: a sibling agent's later event does not move this agent's ended_at", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSiblingAgents(store, [
      "2026-06-22T10:00:00.500Z",
      "2026-06-22T10:00:00Z",
    ]);
    // Later than either of the worker's events, and its raw text sorts above
    // them too, so a scope leak would move the worker's end.
    await seedAgentEvent(
      store,
      "ev-sibling",
      "abandoned",
      "sibling",
      "2026-06-22T11:00:00.000Z"
    );

    const { swept } = await sweepOrphanedSessions(prisma, NOW);
    assert.equal(swept, 1);

    const worker = await getAgent(store, "worker");
    assert.equal(worker?.ended_at, "2026-06-22T10:00:00.500Z");
    const sibling = await getAgent(store, "sibling");
    assert.equal(sibling?.ended_at, "2026-06-22T11:00:00.000Z");
  } finally {
    await close();
  }
});

/*
 * Scope guard, LEGACY arm. The event scope is threaded into the canonical fold
 * and the legacy fold as two INDEPENDENT arguments, so the case above pins only
 * one of them: widening just the legacy scope to
 * `e.session_id = agents.session_id` is not a syntax error, and every
 * all-canonical fixture discards the legacy arm before it can be observed. This
 * agent holds one un-canonicalizable event, so its fold runs in legacy mode and
 * the sibling's event is reachable.
 */
test("ISS-6893: the per-agent event scope also holds in legacy mode", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSiblingAgents(store, [
      "2026-06-22T10:00:00.000Z",
      UNCANONICALIZABLE_EVENT,
    ]);
    // Sorts above the worker's byte-wise winner, so a widened legacy scope would
    // stamp it onto the worker.
    await seedAgentEvent(
      store,
      "ev-sibling",
      "abandoned",
      "sibling",
      "2026-06-22T22:00:00.000Z"
    );

    const { swept } = await sweepOrphanedSessions(prisma, NOW);
    assert.equal(swept, 1);

    const worker = await getAgent(store, "worker");
    assert.equal(
      worker?.ended_at,
      UNCANONICALIZABLE_EVENT,
      "legacy mode still folds only the agent's OWN events"
    );
  } finally {
    await close();
  }
});

/*
 * The DERIVED consumers. `ended_at` is not only read back verbatim: two
 * independent aggregates compute a DURATION from it, and a too-early end
 * shortens both. `local-insights` serves the desktop's own agent-pipeline panel;
 * `aggregateAnalytics.byAgentType` carries the duration total to the cloud.
 * Both are driven from the same mixed-encoding fixture the sweep corrects, so a
 * regression in the fold moves a number a user reads.
 */
test("ISS-6893: the corrected end lengthens the agent durations both aggregates report", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(
      store,
      "abandoned",
      SESSION_STATUS.ACTIVE,
      STALE_UPDATED_AT,
      STALE_UPDATED_AT,
      AGENT_STARTED_AT
    );
    await seedAgent(
      store,
      "worker",
      "abandoned",
      DESKTOP_AGENT_STATUS.RUNNING,
      AGENT_STARTED_AT,
      "main"
    );
    // 09:30 at -05:00 is 14:30Z, 4.5h AFTER the `Z` event whose text sorts above
    // it — so the byte-wise fold reports a 5h span and the correct one 9.5h.
    await seedAgentEvent(
      store,
      "ev-0",
      "abandoned",
      "worker",
      "2026-06-22T10:00:00.000Z"
    );
    await seedAgentEvent(
      store,
      "ev-1",
      "abandoned",
      "worker",
      "2026-06-22T09:30:00-05:00"
    );

    const { swept } = await sweepOrphanedSessions(prisma, NOW);
    assert.equal(swept, 1);

    const insights = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      InsightsPeriod.Month,
      new Date(NOW)
    );
    const node = insights.charts.agentPipeline?.nodes.find(
      (row) => row.subagentType === "main"
    );
    assert.ok(node, "the swept agent's type is in the pipeline rollup");
    assert.equal(
      node.avgDuration,
      9.5 * 60 * 60,
      "avg_duration is the chronological span in seconds, not the shortened one"
    );

    // `aggregateAnalytics` is OPTIONAL on `AgentSessionSyncSource` (sources
    // without it fall back to the full hydrate path), so the sqlite source's
    // implementation has to be narrowed before it can be called.
    const syncSource = createSqliteSessionSyncSource(prisma);
    assert.ok(
      syncSource.aggregateAnalytics,
      "the sqlite sync source implements the SQL analytics aggregate"
    );
    const analytics = await syncSource.aggregateAnalytics(
      {},
      emptyAttributionCache()
    );
    const group = analytics.byAgentType.find((row) => row.agentType === "main");
    assert.ok(group, "the swept agent's type is in the synced analytics");
    assert.equal(group.durationCount, 1);
    assert.equal(
      group.durationTotalMs,
      9.5 * 60 * 60 * 1000,
      "the duration total the cloud receives reflects the chronological end"
    );
  } finally {
    await close();
  }
});

/**
 * One stale session holding a `worker` with the given events plus an event-less
 * `sibling`, so a scope leak between the two agents is observable.
 */
async function seedSiblingAgents(
  store: Awaited<ReturnType<typeof openTestPrisma>>["db"],
  workerEventCreatedAts: readonly string[]
): Promise<void> {
  await seedSession(
    store,
    "abandoned",
    SESSION_STATUS.ACTIVE,
    STALE_UPDATED_AT
  );
  await seedAgent(
    store,
    "worker",
    "abandoned",
    DESKTOP_AGENT_STATUS.RUNNING,
    AGENT_STARTED_AT
  );
  await seedAgent(
    store,
    "sibling",
    "abandoned",
    DESKTOP_AGENT_STATUS.RUNNING,
    AGENT_STARTED_AT
  );
  for (const [index, createdAt] of workerEventCreatedAts.entries()) {
    await seedAgentEvent(
      store,
      `ev-own-${index}`,
      "abandoned",
      "worker",
      createdAt
    );
  }
}
