/**
 * @file transcript-terminal-skip-reason-emission.test.ts
 * @description ISS-9884 (PLN-1986 §9) — the ONE producer of the new terminal
 * skip reason: which BOUND dead-lettered a transcript picks which reason the
 * cloud is told, and what the local row records.
 *
 * Lives in its own file rather than in `transcript-sync-service.test.ts`,
 * which is at the 1,000-line ceiling, and for the same reason
 * `transcript-skip-reason-version-skew.test.ts` does — its §3 sibling.
 */
import assert from "node:assert/strict";
import { SyncLane, SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { test } from "vitest";
import type { SyncLaneBatchEvent } from "../src/main/agent-sync/sync-lane-cloud-health.js";
import { DesktopSyncBatchOutcome } from "../src/main/telemetry/app-otel-runtime.js";
import { TranscriptSyncClientError } from "../src/main/transcript/desktop-transcripts-client.js";
import { TRANSCRIPT_LANE_STALL_CEILING_MS } from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  fakeExecutor,
  fakeStore,
  fingerprint,
  makeService,
  NOW,
} from "./helpers/transcript-sync-fixtures.js";

// ISS-9884 (PLN-1986 §9) — WHICH BOUND FIRED PICKS WHICH REASON.
//
// Both bounds dead-letter through the same ack-gated path, and until now both
// told the cloud `retries_exhausted`, which maps to `failedPermanent`: "the
// transcript is never coming". That is true of a ladder that ran out of
// attempts on a file something was wrong with. It is false of a lane that was
// refused LANE-WIDE for a day on a file nothing was ever established to be
// wrong with — the retry count was deliberately never advanced, the source is
// presumed present, and the transport was simply never available.
test("ISS-9884: crossing the lane-wide WALL CLOCK dead-letters with environment_unavailable", async () => {
  const executor = fakeExecutor({
    syncFile: () => {
      // Lane-wide by classification: a 503 says nothing about this row.
      throw new TranscriptSyncClientError("bucket unavailable", 503);
    },
    skipAck: true,
  });
  const store = fakeStore([
    fingerprint({
      // The ladder is deliberately NOT spent — a lane-wide failure never
      // advances it, which is exactly why the wall clock exists.
      retryCount: 0,
      laneStalledSince: new Date(
        Date.parse(NOW) - TRANSCRIPT_LANE_STALL_CEILING_MS - 1
      ).toISOString(),
    }),
  ]);
  const { service } = makeService({ store, executor });

  await service.drainOnce();

  assert.deepEqual(
    executor.skipNotifications.map((notification) => notification.reason),
    [TranscriptSkipReason.EnvironmentUnavailable],
    "the cloud is told the environment gave up, not that this file exhausted its retries"
  );
  assert.equal(store.failures[0].dead, true);
  // ISS-9884 (re-review): the local row records the reason the SERVER said it
  // persisted, which `fakeExecutor` answers as a fixed `too_large` precisely
  // so it differs from the requested `environment_unavailable`. Asserting the
  // REQUESTED reason here could not fail: the old double echoed the request,
  // so the assertion held whether the drain read `emit.reason` off the
  // response or handed its own request straight back.
  assert.equal(
    store.failures[0].terminalSkipReason,
    TranscriptSkipReason.TooLarge,
    "and the local row records what the cloud recorded, so the desktop's own list agrees with it"
  );
});

test("ISS-9884: the consecutive-failure LADDER still emits retries_exhausted", async () => {
  // The control, byte for byte as before. A row-attributable failure spends the
  // per-row budget, and running that budget out IS `retries_exhausted`.
  const executor = fakeExecutor({
    syncFile: () => {
      throw new Error("still failing");
    },
    skipAck: true,
  });
  const store = fakeStore([fingerprint({ retryCount: 4 })]);
  const { service } = makeService({ store, executor });

  await service.drainOnce();

  assert.deepEqual(
    executor.skipNotifications.map((notification) => notification.reason),
    [TranscriptSkipReason.RetriesExhausted]
  );
  // Same split as above: the ladder REQUESTS `retries_exhausted`, and the row
  // records the fake server's differing `too_large` answer.
  assert.equal(
    store.failures[0].terminalSkipReason,
    TranscriptSkipReason.TooLarge
  );
});

test("ISS-9884: a lane-wide failure INSIDE the ceiling records no terminal reason", async () => {
  // Still deferring, not terminal. Stamping a reason on a row that is still on
  // the ladder would make the local verdict read a give-up off a live row.
  const executor = fakeExecutor({
    syncFile: () => {
      throw new TranscriptSyncClientError("bucket unavailable", 503);
    },
    skipAck: true,
  });
  const store = fakeStore([
    fingerprint({
      retryCount: 0,
      laneStalledSince: new Date(Date.parse(NOW) - 60_000).toISOString(),
    }),
  ]);
  const { service } = makeService({ store, executor });

  await service.drainOnce();

  assert.equal(store.failures[0].dead, false);
  assert.equal(store.failures[0].terminalSkipReason, null);
  assert.equal(executor.skipNotifications.length, 0);
});

// ISS-9884 — the SPAN, not just the skip request. A dead letter reported the
// last attempt's transport error, so a 24h environmental give-up still blamed
// the file on the lane's cloud health and `lane_gave_up` was emitted by
// nothing. Driven through the real drain, with the fake cloud acknowledging
// the reason the span must carry.
async function drainCapturingArchiveEvents(input: {
  laneStalledSince: string;
  skipReason?: TranscriptSkipReason;
}): Promise<SyncLaneBatchEvent[]> {
  const events: SyncLaneBatchEvent[] = [];
  const { service } = makeService({
    store: fakeStore([
      fingerprint({ retryCount: 0, laneStalledSince: input.laneStalledSince }),
    ]),
    executor: fakeExecutor({
      syncFile: () => {
        throw new TranscriptSyncClientError("bucket unavailable", 503);
      },
      skipAck: true,
      skipReason: input.skipReason,
    }),
    emitSyncBatch: (event) => events.push(event),
  });
  await service.drainOnce();
  return events.filter((event) => event.lane === SyncLane.TranscriptArchive);
}

test("ISS-9884: a wall-clock dead letter reports lane_gave_up, not the transport error", async () => {
  const events = await drainCapturingArchiveEvents({
    laneStalledSince: new Date(
      Date.parse(NOW) - TRANSCRIPT_LANE_STALL_CEILING_MS - 1
    ).toISOString(),
    skipReason: TranscriptSkipReason.EnvironmentUnavailable,
  });

  assert.deepEqual(events, [
    {
      lane: SyncLane.TranscriptArchive,
      outcome: DesktopSyncBatchOutcome.DeadLetter,
      reason: SyncReason.LaneGaveUp,
    },
  ]);
});

test("ISS-9884: the same 503 inside the ceiling keeps the server's status reason", async () => {
  // The control. Not terminal, so the raw-error mapping stands — a dead-letter
  // fold applied to every failure would turn this into a give-up too.
  const events = await drainCapturingArchiveEvents({
    laneStalledSince: new Date(Date.parse(NOW) - 60_000).toISOString(),
    skipReason: TranscriptSkipReason.EnvironmentUnavailable,
  });

  assert.deepEqual(events, [
    {
      lane: SyncLane.TranscriptArchive,
      outcome: DesktopSyncBatchOutcome.Failure,
      reason: SyncReason.IngestionFailed,
    },
  ]);
});
