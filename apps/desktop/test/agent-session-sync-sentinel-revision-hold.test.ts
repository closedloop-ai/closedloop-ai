/**
 * @file agent-session-sync-sentinel-revision-hold.test.ts
 * @description ISS-8271 (PLN-1839 Step 3): the session-lane sentinel-revision
 * guard — no outbound session payload may ever carry `dataRevision < 1`
 * (`main/sync/AGENTS.md` invariant 11, the session-lane twin of the invocation
 * lane's ISS-4572 `DATA_REVISION` pin).
 *
 * A sentinel-carrying session is DEFERRED on the outbox-pending path: it keeps
 * its queue slot behind a retry deadline, its outbox row stays `pending`, and it
 * is neither dequeued, dead-lettered, nor durably withheld — so it re-sends once
 * the reseal stamps a real revision, including across a process restart (the
 * reseal deliberately does not bump `updated_at`, so the pending row is the only
 * signal).
 *
 * Drives the real `AgentSessionSyncService` over the shared `FakeSyncSource` for
 * the wire-level guard, plus the disposition unit matrix.
 */

import assert from "node:assert/strict";
import type { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { test } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { SessionDispositionDeps } from "../src/main/agent-sync/agent-session-sync-dispositions.js";
import { deferSentinelRevisionCandidates } from "../src/main/agent-sync/agent-session-sync-dispositions.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  DATA_REVISION_IMPORT_PENDING,
  DATA_REVISION_MAINTENANCE_STALE,
} from "../src/main/collectors/engine/data-revision.js";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import { pumpSyncDrainTurn } from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const COMPUTE_TARGET = "sentinel-revision-target";
const SOURCE_KEY = buildAgentSessionSyncSourceKey(COMPUTE_TARGET);
/** Bound on {@link pumpUntil} — generous, so exhausting it means a real wedge. */
const MAX_PUMP_TURNS = 200;

function makeSessionWithRevision(
  id: string,
  updatedAt: string,
  dataRevision: number
): SyncedAgentSession {
  return { ...makeSyncedSession(id, updatedAt), dataRevision };
}

type CapturedBatch = { sessions: { externalSessionId: string }[] };

function makeService(
  source: FakeSyncSource,
  sentBatches: CapturedBatch[]
): AgentSessionSyncService {
  return new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: (batch) => {
      sentBatches.push({ sessions: batch.sessions });
      return Promise.resolve({ accepted: true });
    },
  });
}

function sentIds(sentBatches: CapturedBatch[]): string[] {
  return sentBatches.flatMap((batch) =>
    batch.sessions.map((session) => session.externalSessionId)
  );
}

/** THE guard: every revision that crossed the wire, across every batch sent. */
function sentRevisions(sentBatches: CapturedBatch[]): (number | null)[] {
  return sentBatches.flatMap((batch) =>
    batch.sessions.map(
      (session) => (session as SyncedAgentSession).dataRevision ?? null
    )
  );
}

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
 * A `SessionDispositionDeps` that records what the defer touched and no-ops the
 * rest — enough to assert WHICH disposition a candidate got, and that the defer
 * is exactly a retry deadline: no dequeue, no dead-letter, no durable withhold.
 */
function recordingDeps(): SessionDispositionDeps & {
  deadLettered: string[];
  dequeued: string[];
  withheld: string[];
} {
  const deadLettered: string[] = [];
  const dequeued: string[] = [];
  const withheld: string[] = [];
  return {
    deadLettered,
    dequeued,
    withheld,
    nextRetryAfterMs: new Map<string, number>(),
    clearFailureStateForId: () => undefined,
    markDeadLettered: (id: string) => {
      deadLettered.push(id);
    },
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
    parkForeignOutboxRows: () => undefined,
    markOutboxWithheld: (ids: string[]) => {
      withheld.push(...ids);
    },
    isCurrentSourceState: () => true,
    readSourceKey: () => SOURCE_KEY,
  };
}

test("ISS-8271: the disposition defers exactly the sentinel revisions (< 1), touching nothing durable", () => {
  const deps = recordingDeps();
  const updatedAt = "2026-08-20T12:00:00.000Z";
  const importPending = makeSessionWithRevision(
    "import-pending",
    updatedAt,
    DATA_REVISION_IMPORT_PENDING
  );
  const maintenanceStale = makeSessionWithRevision(
    "maintenance-stale",
    updatedAt,
    DATA_REVISION_MAINTENANCE_STALE
  );
  const sealed = makeSessionWithRevision(
    "sealed",
    updatedAt,
    effectiveDataRevision()
  );
  // A minimal/legacy shape with no revision at all is NOT a sentinel.
  const legacy = makeSyncedSession("legacy", updatedAt);

  const retained = deferSentinelRevisionCandidates(
    { sessions: [importPending, maintenanceStale, sealed, legacy] },
    deps
  );

  assert.deepEqual(
    retained.map((session) => session.externalSessionId),
    ["sealed", "legacy"],
    "only sessions with a real (or absent) revision stay uploadable"
  );
  assert.deepEqual(
    [...deps.nextRetryAfterMs.keys()].sort(),
    ["import-pending", "maintenance-stale"],
    "both sentinel classes are deferred behind a retry deadline"
  );
  assert.deepEqual(
    deps.dequeued,
    [],
    "a deferred session keeps its queue slot — the outbox-pending path"
  );
  assert.deepEqual(deps.deadLettered, [], "the defer never dead-letters");
  assert.deepEqual(
    deps.withheld,
    [],
    "the defer never durably withholds — the reseal bumps no updated_at, so a withheld row would never re-pend"
  );
});

test("ISS-8271: no outbound payload ever carries a sentinel dataRevision; the held row stays pending and ships after the seal + restart", async () => {
  const updatedAt = "2026-08-20T12:00:00.000Z";
  const source = new FakeSyncSource([
    makeSessionWithRevision(
      "mid-import",
      updatedAt,
      DATA_REVISION_IMPORT_PENDING
    ),
    makeSessionWithRevision("healthy", "2026-08-20T12:01:00.000Z", 42),
  ]);
  const sentBatches: CapturedBatch[] = [];

  const service = makeService(source, sentBatches);
  service.start();
  // `settleSelfContinuedDrain` waits for caught-up, which a deferred candidate
  // deliberately never reaches (it keeps its queue slot) — wait for the
  // observable effect instead.
  await pumpUntil(
    () => sentIds(sentBatches).includes("healthy"),
    "the healthy sibling uploads"
  );

  assert.ok(
    !sentIds(sentBatches).includes("mid-import"),
    "the sentinel-carrying session never reached the wire"
  );
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    0,
    "the hold is a defer, not a dead-letter"
  );
  assert.ok(
    source.pendingOutboxIds(SOURCE_KEY).includes("mid-import"),
    "the held session's outbox row stays pending — the re-send signal"
  );
  assert.deepEqual(
    source.withheldOutboxIds(SOURCE_KEY),
    [],
    "the held session is not durably withheld"
  );
  service.stop();

  // The seal lands (import completes): only data_revision moves, no updated_at
  // bump — the pending outbox row is the whole re-send signal. A restart (new
  // service, fresh in-memory state) must pick it up and ship it.
  source.upsert(
    makeSessionWithRevision("mid-import", updatedAt, effectiveDataRevision())
  );
  const restarted = makeService(source, sentBatches);
  restarted.start();
  await pumpUntil(
    () => sentIds(sentBatches).includes("mid-import"),
    "the sealed session uploads after restart"
  );
  restarted.stop();

  const revisions = sentRevisions(sentBatches);
  assert.ok(
    revisions.every((revision) => revision === null || revision >= 1),
    `no outbound session payload ever carries dataRevision < 1 (saw: ${revisions.join(", ")})`
  );
});
