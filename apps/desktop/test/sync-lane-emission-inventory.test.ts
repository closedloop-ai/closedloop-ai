/**
 * @file sync-lane-emission-inventory.test.ts
 * @description ISS-8589 (PRD-699 §6 item 0a) — the emission-site inventory,
 * executed rather than written down.
 *
 * ISS-6338 and ISS-7248 landed the per-lane emission, and each lane's own suite
 * asserts its own lane. Nothing held the lanes to the claim PRD-699 §9 measures
 * success by — "every failure/dead-letter event carrying `sync.lane` +
 * `sync.reason`" — ACROSS lanes, so a lane that stopped naming either took only
 * its own suite red and nothing said the cross-lane invariant had gone.
 *
 * Exhaustive over the TELEMETRY vocabulary, which is narrower than exhaustive
 * over the desktop's sync lanes. The table is a `Record<SyncLane, …>`, so a
 * member added to `SyncLane` fails `tsc` here until it names its own producers,
 * and `sync-lane-cloud-health.test.ts` pins `SyncLane` equal to the desktop's
 * `SyncLaneId`. Project-artifact-placement has no batch-span producer yet, so its
 * inventory entry is `null` without weakening the exhaustive lane-set check.
 *
 * Scope is deliberately narrow, in two further directions. WHICH reason a lane
 * folds a given status onto, and what each one means, stay with the lane's own
 * suite. And the table names ONE producer per lane, not all of them — so the
 * assertions below are a claim about the ENUMERATED producers, never a coverage
 * record for the lane. Lane 1's other five producers are the live instance of
 * that gap (ISS-10070); see the entry below for which, and for the half of
 * their contract that IS pinned elsewhere.
 */
import assert from "node:assert/strict";
import {
  SyncLane,
  SyncPayloadShaping,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { test } from "vitest";
import { ComponentSyncSendOutcome } from "../src/main/agent-sync/agent-component-sync-dead-letter.js";
import { reportSyncAttemptFailure } from "../src/main/agent-sync/sync-failure-diagnostic.js";
import {
  componentInventoryBatchEvent,
  componentRecoveryBatchEvent,
  invocationPartBatchEvent,
  permanentSkipSyncReason,
  transcriptArchiveBatchEvent,
} from "../src/main/agent-sync/sync-lane-cloud-health.js";
import {
  type DesktopSyncBatchEventInput,
  DesktopSyncBatchOutcome,
} from "../src/main/telemetry/app-otel-runtime.js";
import { SPAN_PRODUCING_SYNC_LANES } from "./support/sync-lane-span-producers.js";

/** Shaped like the ids the sync request body already carries; never a real one. */
const BATCH_ID = "0191f0a0-0000-7000-8000-000000000001";

/**
 * Lane 1 has no pure builder, and its ATTEMPT failures go through the reporting
 * seam below, so the inventory drives that seam and captures what it hands the
 * span sink.
 *
 * That seam is not every session-lane emitter. Six further emit sites in three
 * modules — `agent-session-payload-preparation.ts` (1),
 * `agent-session-sync-dispositions.ts` (2: unhydratable and locally-oversized),
 * and `agent-session-sync-accepted-ack.ts` (3) — build their events inline and
 * carry no lane. This entry does not drive them, and the two halves of their
 * contract are NOT in the same state:
 *
 * - LANE is structurally guaranteed and already pinned. All seven sites reach
 *   the wire through the single `onSyncBatchTelemetry` option, which
 *   `desktop-sync-lane-composition.ts` wires to a closure that stamps
 *   `session_metadata`; `sync-lane-cloud-health-wiring.test.ts` drives the real
 *   composition through that seam and asserts the stamp.
 * - REASON is pinned nowhere across them. Deleting the reason from
 *   `dropAbsentCandidates` leaves this file green, which is why the case names
 *   its enumerated producer rather than the lane. ISS-10070 owns closing it,
 *   in the wiring suite that already stands up the composition.
 */
function sessionMetadataFailureEvents(): DesktopSyncBatchEventInput[] {
  const emitted: DesktopSyncBatchEventInput[] = [];
  const outcomes = [
    DesktopSyncBatchOutcome.Failure,
    DesktopSyncBatchOutcome.DeadLetter,
  ] as const;
  for (const outcome of outcomes) {
    reportSyncAttemptFailure(
      {
        emitTelemetry: (event) => emitted.push(event),
        writeDurableRecord: () => undefined,
      },
      {
        batchId: BATCH_ID,
        lane: SyncLane.SessionMetadata,
        outcome,
        reason: SyncReason.IngestionFailed,
        payloadBytes: 512,
        sessionIds: ["session-1"],
        payloadShaping: SyncPayloadShaping.Whole,
      }
    );
  }
  return emitted;
}

/**
 * One entry per lane, naming that lane's failure and dead-letter producers.
 *
 * Lanes 2–4 reach the emitter only through the pure builders in
 * `sync-lane-cloud-health.ts`, so their entries call those directly and do cover
 * the lane; lane 1 has several emitters and this drives one of them — see that
 * entry. Within an entry, every non-success arm the producer can reach is
 * listed.
 */
const LANE_FAILURE_EMISSIONS: Record<
  SyncLane,
  (() => readonly DesktopSyncBatchEventInput[]) | null
> = {
  [SyncLane.SessionMetadata]: sessionMetadataFailureEvents,
  [SyncLane.InvocationParts]: () => [
    invocationPartBatchEvent({ kind: "unavailable", status: 401 }),
    invocationPartBatchEvent({ kind: "retry", error: "boom", status: 500 }),
  ],
  [SyncLane.TranscriptArchive]: () => [
    transcriptArchiveBatchEvent({ failed: true }),
    transcriptArchiveBatchEvent({
      failed: true,
      dead: true,
      reason: permanentSkipSyncReason(TranscriptSkipReason.SourceGone),
    }),
  ],
  [SyncLane.ComponentInventory]: () => [
    componentInventoryBatchEvent({
      laneFailureReason: SyncReason.TransportUnavailable,
    }),
    componentInventoryBatchEvent({
      rejectedReason: SyncReason.ValidationFailed,
      deadLettered: true,
      deadLetteredCount: 4,
    }),
    componentRecoveryBatchEvent(
      ComponentSyncSendOutcome.BatchRejected,
      SyncReason.ValidationFailed
    ),
  ],
  [SyncLane.TraceComments]: null,
};

test("ISS-8589: every lane's enumerated producer names BOTH its lane and a reason on every failure and dead-letter event it emits", () => {
  for (const [lane, produceEvents] of Object.entries(LANE_FAILURE_EMISSIONS)) {
    if (produceEvents === null) {
      continue;
    }
    const events = produceEvents();
    assert.ok(
      events.length > 0,
      `${lane} contributed no failure event to the inventory`
    );
    for (const event of events) {
      // The trap this guards: a builder input that lands on its SUCCESS arm
      // would satisfy a bare "has a lane" assertion while proving nothing about
      // the failure path the inventory is for.
      assert.notEqual(
        event.outcome,
        DesktopSyncBatchOutcome.Success,
        `${lane} produced a success event where a failure was asked for`
      );
      assert.equal(
        event.lane,
        lane,
        `${lane} emitted a ${event.outcome} event no monitor can attribute to a lane`
      );
      assert.notEqual(
        event.reason,
        undefined,
        `${lane} emitted a ${event.outcome} event with no sync.reason`
      );
    }
  }
});

test("ISS-8589: the inventory covers the contract's whole lane set", () => {
  // The `Record<SyncLane, …>` above already fails `tsc` on a missing lane. This
  // is the half a type cannot hold: it fails if the table is ever widened to a
  // looser key type and a lane then quietly drops out of the sweep.
  assert.deepEqual(
    new Set(Object.keys(LANE_FAILURE_EMISSIONS)),
    new Set([
      "session_metadata",
      "invocation_parts",
      "transcript_archive",
      "component_inventory",
      "trace_comments",
    ])
  );
});

test("ISS-10375: only a lane with no span producer may skip the sweep", () => {
  const skipped = Object.entries(LANE_FAILURE_EMISSIONS)
    .filter(([, produceEvents]) => produceEvents === null)
    .map(([lane]) => lane);
  assert.deepEqual(
    new Set(skipped),
    new Set(
      Object.values(SyncLane).filter(
        (lane) => !SPAN_PRODUCING_SYNC_LANES.includes(lane)
      )
    )
  );
});
