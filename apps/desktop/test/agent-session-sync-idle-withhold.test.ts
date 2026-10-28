/**
 * @file agent-session-sync-idle-withhold.test.ts
 * @description ISS-7246: an idle ("phantom") session must leave the lane's owed
 * work DURABLY, not just in memory.
 *
 * Before this ticket the withhold dequeued the id but left its outbox row
 * `pending`, so `reconcilePendingOutboxIfIdle` re-armed it on the next idle tick
 * and the session cycled forever — queued, hydrated, judged idle, withheld,
 * re-queued — burning work and inflating every progress surface that divides by
 * the queue depth.
 *
 * Drives the real `AgentSessionSyncService` over the shared `FakeSyncSource`,
 * whose outbox mirrors the sqlite store's guards.
 */

import assert from "node:assert/strict";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { test } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { SessionDispositionDeps } from "../src/main/agent-sync/agent-session-sync-dispositions.js";
import { withholdNonUploadableCandidates } from "../src/main/agent-sync/agent-session-sync-dispositions.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  flushAgentSessionSync,
  pumpSyncDrainTurn,
  settleSelfContinuedDrain,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const COMPUTE_TARGET = "idle-withhold-target";
const SOURCE_KEY = buildAgentSessionSyncSourceKey(COMPUTE_TARGET);
/** Idle ticks to pump after the drain settles, hunting for a re-queue. */
const EXTRA_IDLE_TURNS = 20;
/**
 * Idle poll ticks to drive after the drain settles. Each one runs the ISS-6031
 * outbox reconciliation (both queues drained is exactly its gate), which is the
 * mechanism that used to re-arm a withheld row.
 */
const RECONCILE_TICKS = 5;
/** Bound on {@link pumpUntil} — generous, so exhausting it means a real wedge. */
const MAX_PUMP_TURNS = 200;

/** A `SessionStart`-only row: no turns, no tokens, no tool use. */
function makeIdleSession(id: string, updatedAt: string): SyncedAgentSession {
  return {
    externalSessionId: id,
    status: "active",
    harness: "codex",
    cwd: `/workspace/${id}`,
    startedAt: "2026-08-19T12:00:00.000Z",
    updatedAt,
    agents: [],
    events: [
      {
        externalEventId: `${id}-session-start`,
        eventType: "SessionStart",
        createdAt: "2026-08-19T12:00:00.000Z",
      },
    ],
    tokenUsageByModel: [],
  };
}

function makeService(
  source: FakeSyncSource,
  sentIds: string[]
): AgentSessionSyncService {
  return new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: (batch) => {
      for (const session of batch.sessions) {
        sentIds.push(session.externalSessionId);
      }
      return Promise.resolve({ accepted: true });
    },
  });
}

/** How many times the lane hydrated `id` — the cost a re-queue loop pays. */
function hydrationCount(source: FakeSyncSource, id: string): number {
  return source.loadSyncedSessionIds.filter((ids) => ids.includes(id)).length;
}

/**
 * Pump drain turns until `predicate` holds, then return; THROW if it never does.
 *
 * `settleSelfContinuedDrain` cannot serve here: right after a local `updated_at`
 * bump the lane is still caught up (the incremental read has not run yet), so it
 * returns immediately and the assertion that follows reads stale state. This
 * waits for the real observable effect instead, with an explicit bound so a
 * regression surfaces as a labeled timeout rather than a silent pass.
 */
async function pumpUntil(
  predicate: () => boolean,
  label: string
): Promise<void> {
  for (let turn = 0; turn < MAX_PUMP_TURNS; turn += 1) {
    if (predicate()) {
      return;
    }
    await pumpSyncDrainTurn();
  }
  throw new Error(`never observed within ${MAX_PUMP_TURNS} turns: ${label}`);
}

/**
 * A `SessionDispositionDeps` that records the two durable dispositions and
 * no-ops everything else — enough to assert WHICH disposition a candidate got.
 */
function recordingDeps(): SessionDispositionDeps & {
  withheld: string[];
  parkCalls: number;
  dequeued: string[];
} {
  const withheld: string[] = [];
  const dequeued: string[] = [];
  const deps = {
    withheld,
    dequeued,
    parkCalls: 0,
    nextRetryAfterMs: new Map<string, number>(),
    clearFailureStateForId: () => undefined,
    markDeadLettered: () => undefined,
    dequeue: (_mode: AgentSessionSyncMode, ids: string[]) => {
      dequeued.push(...ids);
    },
    queueSizes: () => ({ incremental: 0, backfill: 0, deadLettered: 0 }),
    logWarn: () => undefined,
    logInfo: () => undefined,
    emitDeadLetterTelemetry: () => undefined,
    persistCursorIfCaughtUp: () => undefined,
    scheduleImmediateDrainIfReadyWorkRemains: () => undefined,
    isTracked: () => false,
    feedIntoBackfillQueue: () => 0,
    onDurableWorkQueued: () => undefined,
    parkForeignOutboxRows: () => {
      deps.parkCalls += 1;
    },
    markOutboxWithheld: (ids: string[]) => {
      withheld.push(...ids);
    },
    isCurrentSourceState: () => true,
    readSourceKey: () => SOURCE_KEY,
  };
  return deps;
}

test("ISS-7246 (cr-60883): a foreign-owned phantom is parked, never withheld under the wrong key", () => {
  // Both dispositions are durable, and they write different things. The ISS-7096
  // environment sweep scans `pending` rows only, so a phantom marked `withheld`
  // under the signed-in identity's key could never be parked under its real
  // owner afterwards — ownership therefore has to be judged first.
  const foreignPhantom = {
    ...makeIdleSession("foreign-phantom", "2026-08-19T12:05:00.000Z"),
    userId: "user-other",
    organizationId: "org-other",
  };
  const ownPhantom = makeIdleSession("own-phantom", "2026-08-19T12:06:00.000Z");
  const deps = recordingDeps();

  const retained = withholdNonUploadableCandidates(
    {
      syncMode: AgentSessionSyncMode.Backfill,
      sessions: [foreignPhantom, ownPhantom],
      identity: { userId: "user-mine", organizationId: "org-mine" },
    },
    deps
  );

  assert.deepEqual(retained, [], "neither session is uploadable");
  assert.deepEqual(
    deps.withheld,
    ["own-phantom"],
    "only the session this identity owns is marked withheld"
  );
  assert.equal(
    deps.parkCalls,
    1,
    "the foreign-owned phantom is parked instead"
  );
  assert.deepEqual(
    [...deps.dequeued].sort(),
    ["foreign-phantom", "own-phantom"],
    "both still leave the in-memory queues"
  );
});

test("ISS-7246: an idle session's outbox row is durably withheld, not left pending", async () => {
  const source = new FakeSyncSource([
    makeIdleSession("phantom", "2026-08-19T12:05:00.000Z"),
    makeSyncedSession("real", "2026-08-19T12:06:00.000Z"),
  ]);
  const sentIds: string[] = [];
  const service = makeService(source, sentIds);

  service.start();
  await settleSelfContinuedDrain(service);
  // ISS-7099: this queue emptied by TWO different means — one verified ack and
  // one withhold — and only the ack is a delivery. A progress numerator derived
  // from the queue draining would credit both. Asserted before stop(), which
  // clears the source-derived counters.
  assert.equal(
    service.getSyncProgress().deliveredSessions,
    1,
    "the withheld session left the queue without being credited as delivered"
  );
  service.stop();

  assert.deepEqual(sentIds, ["real"], "only the substantive session uploaded");
  assert.deepEqual(
    source.withheldOutboxIds(SOURCE_KEY),
    ["phantom"],
    "the idle session's row is durably withheld"
  );
  assert.deepEqual(
    source.pendingOutboxIds(SOURCE_KEY),
    [],
    "nothing is still owed — the acked row was cleared and the idle row is not pending"
  );
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    0,
    "withholding is not dead-lettering — the session must stay eligible for a later, legitimate sync"
  );
});

test("ISS-7246: the idle-tick outbox reconciliation no longer re-arms a withheld session", async () => {
  const source = new FakeSyncSource([
    makeIdleSession("phantom", "2026-08-19T12:05:00.000Z"),
  ]);
  const service = makeService(source, []);

  service.start();
  await settleSelfContinuedDrain(service);
  // Drive idle poll ticks. This is where the loop used to run: with both queues
  // drained, `reconcilePendingOutboxIfIdle` re-read the still-`pending` row and
  // fed it back onto the backfill lane, to be hydrated and re-withheld on the
  // next pass, forever.
  for (let tick = 0; tick < RECONCILE_TICKS; tick += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
  service.stop();

  assert.equal(
    hydrationCount(source, "phantom"),
    1,
    "the withheld session was hydrated exactly once — a re-queue loop would hydrate it again on every idle tick"
  );
  const progress = service.getSyncProgress();
  assert.equal(progress.pendingBackfillSessions, 0);
  assert.equal(progress.pendingIncrementalSessions, 0);
});

test("ISS-7246: a withheld session uploads once it gains substantive activity", async () => {
  const source = new FakeSyncSource([
    makeIdleSession("phantom", "2026-08-19T12:05:00.000Z"),
  ]);
  const sentIds: string[] = [];
  const service = makeService(source, sentIds);

  service.start();
  await settleSelfContinuedDrain(service);
  assert.deepEqual(
    source.withheldOutboxIds(SOURCE_KEY),
    ["phantom"],
    "precondition: the session is withheld"
  );

  // The live hook records a real turn and bumps `updated_at`. That bump is the
  // new evidence the incremental feed acts on: the row must return to `pending`
  // and the session must upload. `enqueueOutboxEntries` cannot do this on its
  // own — its upsert never touches `status`.
  source.upsert(makeSyncedSession("phantom", "2026-08-19T12:30:00.000Z"));
  service.refresh();
  await pumpUntil(
    () => sentIds.length > 0,
    "the re-pended session reached the wire"
  );
  service.stop();

  assert.deepEqual(
    sentIds,
    ["phantom"],
    "the now-substantive session uploaded"
  );
  assert.deepEqual(
    source.withheldOutboxIds(SOURCE_KEY),
    [],
    "its row left the withheld set"
  );
  assert.deepEqual(
    source.pendingOutboxIds(SOURCE_KEY),
    [],
    "and was cleared by the verified ack"
  );
});

test("ISS-7246: a still-idle bump re-judges the session once and withholds it again", async () => {
  const source = new FakeSyncSource([
    makeIdleSession("phantom", "2026-08-19T12:05:00.000Z"),
  ]);
  const sentIds: string[] = [];
  const service = makeService(source, sentIds);

  service.start();
  await settleSelfContinuedDrain(service);

  // A bump that does NOT make the session substantive (an event with no turn,
  // token, or tool use). One re-judgement is correct — the bump is real evidence
  // — but it must settle back to withheld rather than accumulate.
  source.upsert(makeIdleSession("phantom", "2026-08-19T12:31:00.000Z"));
  service.refresh();
  await pumpUntil(
    () => hydrationCount(source, "phantom") === 2,
    "the bumped session was re-judged once"
  );
  for (let turn = 0; turn < EXTRA_IDLE_TURNS; turn += 1) {
    await pumpSyncDrainTurn();
  }
  service.stop();

  assert.deepEqual(
    sentIds,
    [],
    "an unsubstantive session still does not upload"
  );
  assert.deepEqual(
    source.withheldOutboxIds(SOURCE_KEY),
    ["phantom"],
    "it settles back to withheld"
  );
  assert.equal(
    hydrationCount(source, "phantom"),
    2,
    "hydrated once per real bump — not once per idle tick"
  );
});

test("ISS-5801: an invocation-only session uploads instead of being withheld", async () => {
  // The slash-command/skill/subagent/hook-only shape: the SessionStart-only
  // idle row, but its local agent_component_invocations rows exist — hydration
  // carries their count. Withholding this parent is what minted terminal
  // `session_missing` orphans for its queued invocation children (PRD-635).
  const source = new FakeSyncSource([
    {
      ...makeIdleSession("slash-only", "2026-08-19T12:05:00.000Z"),
      componentInvocationCount: 2,
    },
  ]);
  const sentIds: string[] = [];
  const service = makeService(source, sentIds);

  service.start();
  await settleSelfContinuedDrain(service);
  service.stop();

  assert.deepEqual(
    sentIds,
    ["slash-only"],
    "the invocation-only session uploaded"
  );
  assert.deepEqual(
    source.withheldOutboxIds(SOURCE_KEY),
    [],
    "nothing was withheld"
  );
});

test("ISS-5801: a withheld session uploads once its invocation set materializes", async () => {
  const source = new FakeSyncSource([
    makeIdleSession("phantom", "2026-08-19T12:05:00.000Z"),
  ]);
  const sentIds: string[] = [];
  const service = makeService(source, sentIds);

  service.start();
  await settleSelfContinuedDrain(service);
  assert.deepEqual(
    source.withheldOutboxIds(SOURCE_KEY),
    ["phantom"],
    "precondition: the session is withheld"
  );

  // The invocation materializer derives the session's first invocation set and
  // bumps `sessions.updated_at` in the same transaction
  // (`materializeAgentComponentInvocations`), so the row re-enters the
  // incremental cursor carrying a positive hydrated count.
  source.upsert({
    ...makeIdleSession("phantom", "2026-08-19T12:30:00.000Z"),
    componentInvocationCount: 1,
  });
  service.refresh();
  await pumpUntil(
    () => sentIds.length > 0,
    "the now-substantive session reached the wire"
  );
  service.stop();

  assert.deepEqual(sentIds, ["phantom"], "the session uploaded");
  assert.deepEqual(source.withheldOutboxIds(SOURCE_KEY), []);
});

test("ISS-7246: a cold-start corpus re-walk leaves withheld rows withheld", async () => {
  const source = new FakeSyncSource([
    makeIdleSession("phantom", "2026-08-19T12:05:00.000Z"),
  ]);
  const firstRun = makeService(source, []);
  firstRun.start();
  await settleSelfContinuedDrain(firstRun);
  firstRun.stop();

  // A fresh process re-enumerates the whole corpus and re-seeds the outbox. That
  // walk carries no new information about a session, so it must not re-pend the
  // withheld row — doing so would reintroduce the loop once per boot.
  const sentIds: string[] = [];
  const secondRun = makeService(source, sentIds);
  secondRun.start();
  await settleSelfContinuedDrain(secondRun);
  secondRun.stop();

  assert.deepEqual(sentIds, [], "the re-walk uploaded nothing");
  assert.deepEqual(
    source.withheldOutboxIds(SOURCE_KEY),
    ["phantom"],
    "the row is still withheld after a cold start"
  );
  assert.deepEqual(source.pendingOutboxIds(SOURCE_KEY), []);
});
