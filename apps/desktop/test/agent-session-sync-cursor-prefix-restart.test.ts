/**
 * @file agent-session-sync-cursor-prefix-restart.test.ts
 * @description ISS-8041 — the two properties the prefix boundary exists for,
 * driven end to end through the REAL `AgentSessionSyncService` over the shared
 * `FakeSyncSource`, whose cursor predicate mirrors the sqlite one
 * (`updated_at > $1 OR (updated_at = $1 AND id NOT IN (<tied>))`).
 *
 * THE REPORTED SHAPE. One session sits in bounded retry while every other
 * session acks. Before this change the durable cursor persisted only once BOTH
 * queues were empty, so that one row pinned it: the lane completed units every
 * pass against a motionless watermark, and every restart re-walked the whole
 * window. Here the cursor must climb to the pinned row's own stamp — no further
 * — while the row is still queued.
 *
 * WHY THE OUTBOX IS WIPED BEFORE THE RESTART. `loadPendingOutboxIds` would
 * re-enqueue the pinned row on resume regardless of where the cursor sits, so a
 * restart test that left the outbox intact would pass just as well against a
 * cursor advanced clean past the row — it would prove nothing about the
 * invariant. Wiping it models the failure the invariant actually defends
 * against: `recordOutboxEnqueue` and `recordOutboxRePend` are fire-and-forget,
 * so a durable hint can genuinely be missing. With no outbox row anywhere, the
 * CURSOR is the only thing that can bring the session back.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
import {
  detectCursorStall,
  type SyncLaneBurndown,
  SyncLaneDrainState,
  SyncLaneId,
} from "../src/shared/sync-burndown-contract.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const COMPUTE_TARGET = "cursor-prefix-target";
const SOURCE_KEY = buildAgentSessionSyncSourceKey(COMPUTE_TARGET);

/** The session that acks on pass zero and settles the cursor beneath the pin. */
const SETTLED_ID = "settled-000";
const SETTLED_AT = "2026-08-25T21:00:00.000Z";
/** The session the server keeps refusing, held in bounded retry for the run. */
const PINNED_ID = "pinned-001";
const PINNED_AT = "2026-08-25T21:05:00.000Z";
/** Live sessions created after the pin, all of which ack. */
const LIVE_PREFIX = "live-";
const LIVE_COUNT = 6;

/** Bounded so a lane that never settles fails loudly instead of hanging. */
const MAX_TICKS = 40;

function liveIdAt(index: number): string {
  return `${LIVE_PREFIX}${String(index).padStart(3, "0")}`;
}

function liveStampAt(index: number): string {
  return `2026-08-25T21:${String(10 + index).padStart(2, "0")}:00.000Z`;
}

/** Advance one event-loop turn (microtasks + one macrotask). */
async function pumpOneTurn(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function drive(
  service: AgentSessionSyncService,
  awaited: string,
  isDone: () => boolean
): Promise<void> {
  for (let tick = 0; tick < MAX_TICKS; tick += 1) {
    service.refresh();
    await service.whenSessionSyncSettled();
    await pumpOneTurn();
    if (isDone()) {
      return;
    }
  }
  throw new Error(
    `drive: ${awaited} did not happen within ${MAX_TICKS} ticks. Failing here rather than falling through, so no later assertion reads stale state and passes.`
  );
}

/**
 * A lane sample carrying only what {@link detectCursorStall} reads. Every other
 * field is filled with a value that cannot itself suppress the detector, so a
 * `false` verdict below is attributable to the cursor VALUE and nothing else.
 */
function laneAt(
  durableCursorValue: string | null,
  workCompletedSincePrevious: number
): SyncLaneBurndown {
  return {
    lane: SyncLaneId.SessionMetadata,
    state: SyncLaneDrainState.Draining,
    itemsRemaining: 1,
    itemsRemainingIsLowerBound: false,
    readyItemsRemaining: 0,
    unmeasuredRows: 0,
    bytesRemaining: null,
    chunksRemaining: null,
    deadLetteredCount: 0,
    deadLetteredBasis: "queue_status_count",
    oldestPendingSinceIso: PINNED_AT,
    oldestPendingBasis: "enqueued_at",
    oldestPendingAgeMs: 60_000,
    tracksDurableCursor: true,
    durableCursorValue,
    durableCursorWrittenAtIso: "2026-08-25T21:20:00.000Z",
    durableCursorAgeMs: 60_000,
    workCompletedSincePrevious,
    bytesSentSincePrevious: null,
    queueRowsClearedSincePrevious: null,
  } as SyncLaneBurndown;
}

test("ISS-8041: the durable cursor climbs to the pinned row while it is still queued, and a restart re-selects it", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession(SETTLED_ID, SETTLED_AT),
  ]);
  const acceptedIds = new Set<string>();
  let liveCreated = 0;
  let liveChurnEnabled = false;
  let pinnedAttempts = 0;

  function buildService(): AgentSessionSyncService {
    return new AgentSessionSyncService({
      isHttpReady: () => true,
      getSource: () => source,
      getSyncComputeTargetId: () => COMPUTE_TARGET,
      sendBatch: (batch) => {
        const ids = batch.sessions.map((session) => session.externalSessionId);
        if (ids.includes(PINNED_ID)) {
          pinnedAttempts += 1;
          // A row-attributable server failure that DEFERS with a backoff rather
          // than dead-lettering: a dead-letter is recorded in the cursor and
          // deliberately stops blocking, which is the case this test is not.
          return Promise.resolve({
            accepted: false as const,
            reason: DesktopAgentSessionsAckReason.IngestionFailed,
          });
        }
        for (const id of ids) {
          acceptedIds.add(id);
        }
        if (liveChurnEnabled && liveCreated < LIVE_COUNT) {
          liveCreated += 1;
          source.upsert(
            makeSyncedSession(liveIdAt(liveCreated), liveStampAt(liveCreated))
          );
        }
        return Promise.resolve({ accepted: true as const });
      },
    });
  }

  const service = buildService();
  try {
    // Pass zero: the corpus is one session, it acks, and the cursor settles
    // BELOW the pin. Without this the pin would be the corpus maximum and
    // FEA-3473's initial persist would already sit at its stamp, so the climb
    // this test is about could not be observed.
    service.start();
    await drive(service, "the first session acked", () =>
      acceptedIds.has(SETTLED_ID)
    );
    assert.ok(acceptedIds.has(SETTLED_ID), "the first session acked");
    const settledCursor =
      source.advanceCalls.at(-1)?.state.observedTopUpdatedAt;
    assert.equal(
      settledCursor,
      SETTLED_AT,
      "the drained lane recorded its watermark"
    );

    // The pin arrives ALONE and is refused, which parks it behind a 300s
    // backoff. Introducing it alongside live work instead would put both in one
    // batch, and `ingestion_failed` defers the whole batch — the live sessions
    // would never ack and the run would prove nothing.
    source.upsert(makeSyncedSession(PINNED_ID, PINNED_AT));
    await drive(
      service,
      "the pinned session was attempted",
      () => pinnedAttempts > 0
    );
    assert.ok(
      pinnedAttempts > 0,
      "the pinned session was attempted and refused"
    );

    // Live sessions above it now keep acking while it sits deferred — the
    // ISS-8041 shape: work completes every pass with one row stuck underneath.
    liveChurnEnabled = true;
    source.upsert(makeSyncedSession(liveIdAt(0), liveStampAt(0)));
    await drive(
      service,
      "every live session acked",
      () => acceptedIds.has(liveIdAt(LIVE_COUNT)) && liveCreated >= LIVE_COUNT
    );

    assert.deepEqual(
      [...acceptedIds].sort(),
      [
        SETTLED_ID,
        ...Array.from({ length: LIVE_COUNT + 1 }, (_unused, index) =>
          liveIdAt(index)
        ),
      ].sort(),
      "every live session acked while the pin was stuck, and nothing else did"
    );
    assert.ok(
      !acceptedIds.has(PINNED_ID),
      "the pinned session never acked, so it is still owed"
    );

    const cursorAfter = source.advanceCalls.at(-1)?.state.observedTopUpdatedAt;
    // THE FIX. Pre-ISS-8041 this stayed at SETTLED_AT for as long as the pin
    // was queued, because the watermark was written only on a drained lane.
    assert.equal(
      cursorAfter,
      PINNED_AT,
      "the cursor advanced to the oldest still-owed stamp — not further, and not stuck below it"
    );
    assert.deepEqual(
      source.advanceCalls.at(-1)?.state.observedIdsAtTopUpdatedAt,
      [],
      "a prefix boundary serializes an EMPTY tied-top set so the resume scan re-selects the boundary stamp"
    );

    // ISS-10429: the boundary the burn-down reads is the pinned row, and it
    // stays the pinned row with every outbox row gone. That is the lost
    // enqueue write the outbox table's oldest-pending time cannot see.
    const pinnedBoundary = { sourceKey: SOURCE_KEY, value: PINNED_AT };
    assert.deepEqual(service.readCursorBoundary(), pinnedBoundary);
    source.outbox.clear();
    service.refresh();
    await service.whenSessionSyncSettled();
    await pumpOneTurn();
    assert.deepEqual(
      service.readCursorBoundary(),
      pinnedBoundary,
      "a stuck row with no outbox row still names the boundary"
    );

    // THE DIAGNOSTIC. ISS-7401's `DURABLE CURSOR NOT ADVANCING` reads exactly
    // these two values; fed the real ones this run produced, it goes quiet.
    assert.equal(
      detectCursorStall({
        previous: laneAt(settledCursor ?? null, 0),
        current: laneAt(cursorAfter ?? null, acceptedIds.size),
      }),
      false,
      "the stall detector is quiet across the advance"
    );
    // The counterfactual: the SAME sample pair with the pre-fix frozen cursor
    // still fires, so the `false` above is the cursor moving, not the fixture.
    assert.equal(
      detectCursorStall({
        previous: laneAt(settledCursor ?? null, 0),
        current: laneAt(settledCursor ?? null, acceptedIds.size),
      }),
      true,
      "the same detector still fires on the frozen cursor this change removes"
    );
  } finally {
    service.stop();
  }

  // RESTART. Every durable outbox hint is gone, so `loadPendingOutboxIds` can
  // contribute nothing and the persisted cursor is the only way back.
  source.outbox.clear();
  source.loadSyncedSessionIds = [];
  const resumed = buildService();
  try {
    resumed.start();
    await drive(
      resumed,
      "the resumed lane re-selected the pinned session",
      () => source.loadSyncedSessionIds.some((ids) => ids.includes(PINNED_ID))
    );
    assert.equal(
      source.pendingOutboxIds(SOURCE_KEY).length > 0,
      true,
      "the resumed lane re-enqueued work of its own, proving it did not simply idle"
    );
    assert.ok(
      source.loadSyncedSessionIds.some((ids) => ids.includes(PINNED_ID)),
      "the un-acked session was re-selected after the restart, with no outbox row to find it by"
    );
  } finally {
    resumed.stop();
  }
});

/**
 * The counterfactual for the assertion above, so the restart half is not merely
 * assumed to depend on the tied-top set being empty. Seeding the SAME boundary
 * stamp with the still-owed id present in the exclusion set is the plausible
 * "keep the precision" variant, and it silently drops the row: the scan's
 * `id NOT IN (…)` term removes it, and nothing else brings it back.
 */
test("ISS-8041: a boundary that excludes the still-owed id by tied-top set loses it", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession(PINNED_ID, PINNED_AT),
    makeSyncedSession(liveIdAt(1), liveStampAt(1)),
  ]);
  source.advanceSyncState(SOURCE_KEY, {
    observedTopUpdatedAt: PINNED_AT,
    observedIdsAtTopUpdatedAt: [PINNED_ID],
    deadLetteredIds: [],
  });
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    sendBatch: () => Promise.resolve({ accepted: true as const }),
  });
  try {
    service.start();
    await drive(service, "the lane selected the row above the boundary", () =>
      source.loadSyncedSessionIds.some((ids) => ids.includes(liveIdAt(1)))
    );
    assert.ok(
      source.loadSyncedSessionIds.some((ids) => ids.includes(liveIdAt(1))),
      "the lane really ran and selected the row ABOVE the boundary"
    );
    assert.ok(
      !source.loadSyncedSessionIds.some((ids) => ids.includes(PINNED_ID)),
      "the row AT the boundary was excluded — which is why a prefix boundary must serialize an empty set"
    );
  } finally {
    service.stop();
  }
});
