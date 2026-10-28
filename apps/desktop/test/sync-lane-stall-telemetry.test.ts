/**
 * ISS-5973 coverage for the sync-lane stall monitored event.
 *
 * `describeStall` and `describeItemsRemaining` are not exported, so every case
 * drives them through the public {@link reportSyncLaneStall} and asserts on the
 * emitted event — which is also the boundary that matters, since the alert text
 * is what an operator reads.
 *
 * The version-skew cases are the point of the file: an absent or unrecognised
 * `kind` must still EMIT, falling back to the original ISS-5387 wording. Dropping
 * the alert over a field this build cannot read would be strictly worse than
 * describing it imprecisely.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { Observability } from "../src/main/telemetry/observability.js";
import { reportSyncLaneStall } from "../src/main/telemetry/sync-lane-stall-telemetry.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";
import {
  SYNC_LANE_IDS,
  SyncLaneDeadLetteredBasis,
  SyncLaneStallKind,
} from "../src/shared/sync-burndown-contract.js";

const STALL_CATEGORY = "sync.durable_cursor.stalled";
const NO_PROGRESS_RE = /is running with 2928 item\(s\) still owed/;
const NO_PROGRESS_ZERO_RE = /completed 0 unit\(s\)/;
const UNKNOWN_ITEMS_RE = /with unknown item\(s\) still owed/;
const LOWER_BOUND_ITEMS_RE = /with >=200 item\(s\) still owed/;
const EXACT_ITEMS_RE = /with 200 item\(s\) still owed/;
const CURSOR_FROZEN_RE = /durable cursor that did not advance/;
const GATE_SHUT_RE =
  /is NOT RUNNING while this machine is consented to deliver/;
const GATE_SHUT_ITEMS_RE = /with 3031 item\(s\) still owed/;
const RESUME_READ_FAILED_RE =
  /is RUNNING but cannot read its persisted resume state/;
const RESUME_READ_MIGRATION_RE =
  /check this machine for an unapplied desktop migration/;
const RESUME_READ_ZERO_DISOWNED_RE =
  /measured remainder of 0 item\(s\) is not evidence that it is caught up/;
const NEVER_PERSISTED_RE = /never persisted/;
const STALE_AGE_RE = /5s stale/;
const STATUS_COUNT_RE =
  /15 dead-lettered right now \(live queue status count, not a cumulative loss total\)/;
const FALLEN_STATUS_COUNT_RE =
  /7 dead-lettered right now \(live queue status count, not a cumulative loss total\)/;
const LEDGER_RE =
  /4 dead-lettered right now \(durable abandoned-id ledger, not a cumulative loss total\)/;
const NO_DEAD_LETTER_STATE_RE = /no dead-letter state on this lane/;
const UNKNOWN_BASIS_RE =
  /9 dead-lettered right now \(basis unknown, not a cumulative loss total\)/;
const BARE_DEAD_LETTERED_RE = /\d+ dead-lettered\)/;
const GATE_SHUT_LEDGER_RE =
  /4 dead-lettered right now \(durable abandoned-id ledger, not a cumulative loss total\)/;
const UNMEASURED_BASIS_RE = /dead-lettered not measured this sample/;

function captureStall(
  input: Parameters<typeof reportSyncLaneStall>[0],
  desktopClientVersion?: string
): EnrichedTelemetryEvent[] {
  const events: EnrichedTelemetryEvent[] = [];
  Observability.init({
    telemetrySend: (event) => events.push(event),
    ...(desktopClientVersion === undefined ? {} : { desktopClientVersion }),
  });
  try {
    reportSyncLaneStall(input);
  } finally {
    Observability.reset();
  }
  return events;
}

describe("reportSyncLaneStall (ISS-5973)", () => {
  const baseInput = {
    lane: "session_metadata",
    workCompletedSincePrevious: 0,
    durableCursorAgeMs: 5000,
    deadLetteredCount: 0,
  };

  it("describes a no-progress stall by the backlog it is not draining", () => {
    const events = captureStall({
      ...baseInput,
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: 2928,
    });

    assert.equal(events.length, 1);
    assert.equal(events[0]?.category, STALL_CATEGORY);
    assert.equal(events[0]?.severity, "error");
    assert.match(String(events[0]?.message), NO_PROGRESS_RE);
    assert.match(String(events[0]?.message), NO_PROGRESS_ZERO_RE);
  });

  it("reports an unmeasurable backlog as unknown, never a fabricated zero", () => {
    const events = captureStall({
      ...baseInput,
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: null,
    });

    assert.match(String(events[0]?.message), UNKNOWN_ITEMS_RE);
  });

  it("marks a capped backlog as a FLOOR rather than an exact count", () => {
    // The invocation lane's template probe stops at 200. Printing that bare says
    // the queue holds exactly 200 items when a 3,500-session backfill is sitting
    // behind it — the same reassuring lie as a fabricated zero, in the one line
    // an operator sizes the incident from.
    const events = captureStall({
      ...baseInput,
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: 200,
      itemsRemainingIsLowerBound: true,
    });

    assert.equal(events.length, 1);
    assert.match(String(events[0]?.message), LOWER_BOUND_ITEMS_RE);
  });

  it("prints an exact count bare when the probe did not cap", () => {
    // Absent means EXACT: a producer that predates the field must not have every
    // count decorated with a `>=` it has not earned.
    const events = captureStall({
      ...baseInput,
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: 200,
    });

    assert.match(String(events[0]?.message), EXACT_ITEMS_RE);
    assert.doesNotMatch(String(events[0]?.message), LOWER_BOUND_ITEMS_RE);
  });

  it("keeps the cursor-frozen wording for a cursor-frozen stall", () => {
    const events = captureStall({
      ...baseInput,
      workCompletedSincePrevious: 50,
      kind: SyncLaneStallKind.CursorFrozen,
    });

    assert.match(String(events[0]?.message), CURSOR_FROZEN_RE);
    assert.match(String(events[0]?.message), STALE_AGE_RE);
  });

  it("ISS-8768: describes a GATE-SHUT stall as not running, not as a frozen cursor", () => {
    const events = captureStall({
      ...baseInput,
      kind: SyncLaneStallKind.GateShutWithBacklog,
      itemsRemaining: 3031,
    });

    assert.equal(events.length, 1);
    assert.equal(events[0]?.category, STALL_CATEGORY);
    assert.match(String(events[0]?.message), GATE_SHUT_RE);
    assert.match(String(events[0]?.message), GATE_SHUT_ITEMS_RE);
    // The whole point of giving this kind its own sentence. The generic
    // fallback asserts a motionless DURABLE CURSOR, which for a lane that never
    // ran is a claim about work that never happened — and it would send triage
    // to the ISS-5347 cursor-freeze runbook instead of to this machine's
    // registration.
    assert.doesNotMatch(
      String(events[0]?.message),
      CURSOR_FROZEN_RE,
      "a gated lane must never borrow the cursor-frozen wording"
    );
  });

  it("ISS-9823: describes a failing RESUME READ by the read, and disowns the zero remainder", () => {
    // The caught-up device this kind exists for: the abort returns before the
    // enqueue, so nothing is ever written and `itemsRemaining` is a measured 0.
    // Every other sentence in this file would read that as reassurance.
    const events = captureStall({
      ...baseInput,
      kind: SyncLaneStallKind.ResumeReadFailed,
      itemsRemaining: 0,
    });

    assert.equal(events.length, 1);
    assert.equal(events[0]?.category, STALL_CATEGORY);
    assert.match(String(events[0]?.message), RESUME_READ_FAILED_RE);
    assert.match(
      String(events[0]?.message),
      RESUME_READ_ZERO_DISOWNED_RE,
      "the 0 must be stated and disowned in the same breath, or the alert reads as the opposite of the condition"
    );
    assert.match(
      String(events[0]?.message),
      RESUME_READ_MIGRATION_RE,
      "the operator action here is a durable read, not a queue or a credential"
    );
    // A durable read that never happened is not a durable cursor that stood
    // still; borrowing that wording sends triage to the ISS-5347 runbook.
    assert.doesNotMatch(String(events[0]?.message), CURSOR_FROZEN_RE);
    assert.doesNotMatch(String(events[0]?.message), GATE_SHUT_RE);
  });

  it("still emits when kind is ABSENT, as a pre-ISS-5973 caller sends", () => {
    const events = captureStall({
      ...baseInput,
      workCompletedSincePrevious: 7,
    });

    assert.equal(events.length, 1, "an older caller must not lose its alert");
    assert.equal(events[0]?.category, STALL_CATEGORY);
    assert.match(String(events[0]?.message), CURSOR_FROZEN_RE);
  });

  it("still emits on an UNRECOGNISED kind from a newer build", () => {
    const events = captureStall({
      ...baseInput,
      workCompletedSincePrevious: 7,
      kind: "a_kind_this_build_has_never_heard_of",
    });

    assert.equal(
      events.length,
      1,
      "an unknown kind must degrade to the generic wording, not drop the alert"
    );
    assert.match(String(events[0]?.message), CURSOR_FROZEN_RE);
  });

  it("names a cursor that was never persisted rather than inventing an age", () => {
    const events = captureStall({
      ...baseInput,
      workCompletedSincePrevious: 7,
      durableCursorAgeMs: null,
    });

    assert.match(String(events[0]?.message), NEVER_PERSISTED_RE);
  });

  it("ISS-7401: carries lane and kind as GROUPABLE fields, not only inside prose", () => {
    // The triage blocker. With lane and kind reachable only by parsing
    // `message`, the dashboard could count stalls and could not say which lane
    // or which failure dominated — a healthy session lane at flat queue depth
    // and a transcript lane sitting on thousands of dead-letters were one
    // undifferentiated number.
    const events = captureStall({
      ...baseInput,
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: 2928,
      itemsRemainingIsLowerBound: true,
      deadLetteredCount: 62,
    });

    assert.deepEqual(events[0]?.diagnostics?.syncLaneStall, {
      lane: "session_metadata",
      kind: SyncLaneStallKind.NoProgress,
      workCompletedSincePrevious: 0,
      deadLetteredCount: 62,
      durableCursorAgeMs: 5000,
      itemsRemaining: 2928,
      itemsRemainingIsLowerBound: true,
    });
  });

  it("ISS-7401: carries a reported cleared-row count of ZERO, and omits an unmeasured one", () => {
    // The emitter hop between the reporter (which fills the count) and the wire
    // schema (which validates it). Both neighbours assert this field; without
    // this case the copy in between could be deleted and the number would go
    // missing in transit with the suite still green. Zero is the load-bearing
    // value: it says the lane cleared NOTHING, which is the shape worth paging
    // on, so it must survive rather than read as unmeasured.
    const cleared = captureStall({
      ...baseInput,
      queueRowsClearedSincePrevious: 0,
    });
    assert.equal(
      cleared[0]?.diagnostics?.syncLaneStall?.queueRowsClearedSincePrevious,
      0
    );

    const unmeasured = captureStall({
      ...baseInput,
      queueRowsClearedSincePrevious: null,
    });
    assert.equal(
      Object.hasOwn(
        unmeasured[0]?.diagnostics?.syncLaneStall ?? {},
        "queueRowsClearedSincePrevious"
      ),
      false,
      "a lane that keeps no counter must not report having cleared nothing"
    );
  });

  it("ISS-7401: omits an unmeasurable backlog and a never-written cursor rather than zeroing them", () => {
    // A `0` on either field states the opposite of the alert it rides: "nothing
    // owed" on a not-draining lane, and "brand new" on a cursor that was never
    // written at all.
    const events = captureStall({
      ...baseInput,
      durableCursorAgeMs: null,
      itemsRemaining: null,
      workCompletedSincePrevious: 7,
    });

    const diagnostics = events[0]?.diagnostics?.syncLaneStall;
    assert.equal(Object.hasOwn(diagnostics ?? {}, "durableCursorAgeMs"), false);
    assert.equal(Object.hasOwn(diagnostics ?? {}, "itemsRemaining"), false);
    assert.equal(diagnostics?.kind, SyncLaneStallKind.CursorFrozen);
  });

  it("ISS-8589: keeps the BREAKDOWN for a lane outside the closed set, coarsening only the lane", () => {
    // ISS-7401 dropped the whole breakdown here, which is the unattributable
    // stall event ISS-8589 drives to zero: `kind`, both counts and the cursor
    // age are all still measured and all still true of a lane nobody can name.
    // Only the lane itself is unknown, and it says so in the bucket the
    // receiving schema already coarsens an unrecognised lane onto.
    const events = captureStall({
      ...baseInput,
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: 2928,
      deadLetteredCount: 62,
      lane: "a_lane_from_the_future",
    });

    assert.equal(events.length, 1);
    assert.equal(events[0]?.category, STALL_CATEGORY);
    assert.deepEqual(events[0]?.diagnostics?.syncLaneStall, {
      // The literal, not the imported const: the wire value a dashboard facet
      // groups by must be pinned independently of the module that emits it.
      lane: "unknown",
      kind: "no_progress",
      workCompletedSincePrevious: 0,
      deadLetteredCount: 62,
      durableCursorAgeMs: 5000,
      itemsRemaining: 2928,
      itemsRemainingIsLowerBound: false,
    });
  });

  it("ISS-8589: emits the breakdown on EVERY lane in the closed set", () => {
    // The claim is about every lane, not about whichever one `baseInput`
    // happens to name. Driven through the public emitter one lane at a time so
    // a lane that silently stopped producing a breakdown cannot hide behind a
    // sibling.
    for (const lane of SYNC_LANE_IDS) {
      const events = captureStall({ ...baseInput, lane });

      assert.equal(events.length, 1, `no stall event emitted for ${lane}`);
      assert.equal(
        events[0]?.diagnostics?.syncLaneStall?.lane,
        lane,
        `${lane} lost its breakdown`
      );
      assert.equal(
        events[0]?.diagnostics?.syncLaneStall?.kind,
        "cursor_frozen",
        `${lane} lost its stall kind`
      );
    }
  });

  it("ISS-8589: guarantees four fields, and only four, when nothing else was measured", () => {
    // The wrapper above makes the breakdown OBJECT unconditional, which is not
    // the same claim as every FIELD being present, and a dashboard needs to
    // know which of the two it may rely on. This pins the floor: a stall that
    // measured nothing optional still names its lane, its kind and both
    // counters, and the five unmeasured fields are ABSENT rather than zeroed or
    // nulled — the receiver types each of them optional-and-not-nullable, so a
    // `null` would fail its parse and take the whole event with it.
    const events = captureStall({
      lane: "component_inventory",
      workCompletedSincePrevious: 7,
      durableCursorAgeMs: null,
      deadLetteredCount: 0,
      itemsRemaining: null,
    });

    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.diagnostics?.syncLaneStall, {
      lane: "component_inventory",
      kind: "cursor_frozen",
      workCompletedSincePrevious: 7,
      deadLetteredCount: 0,
    });
  });

  it("ISS-8590: names the build that produced the stall", () => {
    // Without this the event cannot be attributed to a pre-fix client rather
    // than a live defect — the whole reason 474 stall events over the 7 days to
    // 2026-09-08 could not be classified.
    const events = captureStall(
      {
        ...baseInput,
        kind: SyncLaneStallKind.NoProgress,
        itemsRemaining: 2928,
      },
      "0.16.1814"
    );

    assert.equal(events[0]?.trace?.desktopClientVersion, "0.16.1814");
  });

  it("ISS-8590: omits the build version when this process was never told one", () => {
    // An unset version must leave the key ABSENT rather than present-and-empty,
    // because an empty string reads as a build that reported. This stands in for
    // the db-host child, where `Observability.init` never runs at all.
    const events = captureStall({
      ...baseInput,
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: 2928,
    });

    assert.equal(events.length, 1);
    assert.equal(
      Object.hasOwn(events[0]?.trace ?? {}, "desktopClientVersion"),
      false
    );
  });

  it("ISS-9744: names an outbox count as a live status count and refuses to call it a total", () => {
    // The misreading this closed: an operator reading "(15 dead-lettered)" on a
    // monitored alert concludes 15 items are lost and someone should go get
    // them. `invocation_parts` was observed at 13 -> 7 -> 5 over two days, so
    // that number is what is in the status right now, not what was lost.
    const events = captureStall({
      ...baseInput,
      lane: "invocation_parts",
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: 4,
      deadLetteredCount: 15,
      deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
    });

    assert.equal(events.length, 1);
    assert.match(String(events[0]?.message), STATUS_COUNT_RE);
    assert.doesNotMatch(
      String(events[0]?.message),
      BARE_DEAD_LETTERED_RE,
      "the bare, unqualified count is the wording that read as permanent loss"
    );
    assert.equal(
      events[0]?.diagnostics?.syncLaneStall?.deadLetteredBasis,
      SyncLaneDeadLetteredBasis.QueueStatusCount
    );
  });

  it("ISS-9744: says the same thing about the same lane after the count FALLS", () => {
    // A number that decreases cannot be a loss tally. The alert must describe a
    // 7 exactly as it described the 15 it followed — same basis, same refusal to
    // total — or the second alert reads as recovery of eight lost items.
    const events = captureStall({
      ...baseInput,
      lane: "invocation_parts",
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: 4,
      deadLetteredCount: 7,
      deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
    });

    assert.match(String(events[0]?.message), FALLEN_STATUS_COUNT_RE);
    assert.equal(
      events[0]?.diagnostics?.syncLaneStall?.deadLetteredBasis,
      SyncLaneDeadLetteredBasis.QueueStatusCount
    );
  });

  it("ISS-9744: names the component lane's durable id ledger as a different population", () => {
    // `readComponentInventoryCounts` returns `deadLetteredIds.length` off the
    // persisted cursor row. A dashboard that could not tell it from a queue
    // status count was summing unlike things across lanes.
    const events = captureStall({
      ...baseInput,
      lane: "component_inventory",
      workCompletedSincePrevious: 50,
      deadLetteredCount: 4,
      deadLetteredBasis: SyncLaneDeadLetteredBasis.AbandonedIdLedger,
    });

    assert.match(String(events[0]?.message), LEDGER_RE);
    assert.equal(
      events[0]?.diagnostics?.syncLaneStall?.deadLetteredBasis,
      SyncLaneDeadLetteredBasis.AbandonedIdLedger
    );
  });

  it("ISS-9744: reports a lane with no dead-letter state as such, not as a measured zero", () => {
    // The lane id is a stand-in for a lane with no give-up state.
    // "0 dead-lettered" invites the reader to treat that as a measurement that
    // could have been non-zero, and to read a rising number as new abandonment.
    const events = captureStall({
      ...baseInput,
      lane: "trace_comments",
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: 3,
      deadLetteredCount: 0,
      deadLetteredBasis: SyncLaneDeadLetteredBasis.NoDeadLetterState,
    });

    assert.match(String(events[0]?.message), NO_DEAD_LETTER_STATE_RE);
    assert.doesNotMatch(String(events[0]?.message), BARE_DEAD_LETTERED_RE);
  });

  it("ISS-9744: leaves the basis ABSENT when the producer did not state one", () => {
    // Version skew: an installed build that predates the field sends no basis.
    // Folding that onto a member the way an unknown `kind` folds onto
    // `cursor_frozen` would assert the exact meaning this field exists to stop
    // guessing, so the sentence says so and the breakdown omits the key.
    const events = captureStall({
      ...baseInput,
      workCompletedSincePrevious: 7,
      deadLetteredCount: 9,
    });

    assert.equal(events.length, 1, "an older producer must not lose its alert");
    assert.match(String(events[0]?.message), UNKNOWN_BASIS_RE);
    assert.equal(
      Object.hasOwn(
        events[0]?.diagnostics?.syncLaneStall ?? {},
        "deadLetteredBasis"
      ),
      false
    );
  });

  it("ISS-9744: does not adopt a basis only a NEWER build knows", () => {
    // Same posture as an absent one, and for a stronger reason: a value this
    // build cannot read must not be coerced into one it can, because the two
    // members mean different populations.
    const events = captureStall({
      ...baseInput,
      workCompletedSincePrevious: 7,
      deadLetteredCount: 9,
      deadLetteredBasis: "cumulative_permanent_loss",
    });

    assert.equal(events.length, 1);
    assert.match(String(events[0]?.message), UNKNOWN_BASIS_RE);
    assert.equal(
      Object.hasOwn(
        events[0]?.diagnostics?.syncLaneStall ?? {},
        "deadLetteredBasis"
      ),
      false
    );
  });

  it("ISS-9744: qualifies the count on a GATE-SHUT stall too, not only the other two kinds", () => {
    // The gate-shut sentence is its own template, so the qualifier has to be
    // added to it explicitly — and this is the kind an unpaired or offline
    // machine actually raises, which is exactly where a bare count is read as
    // permanent loss.
    const events = captureStall({
      ...baseInput,
      lane: "component_inventory",
      kind: SyncLaneStallKind.GateShutWithBacklog,
      itemsRemaining: 3031,
      deadLetteredCount: 4,
      deadLetteredBasis: SyncLaneDeadLetteredBasis.AbandonedIdLedger,
    });

    assert.equal(events.length, 1);
    assert.match(String(events[0]?.message), GATE_SHUT_RE);
    assert.match(String(events[0]?.message), GATE_SHUT_LEDGER_RE);
    assert.doesNotMatch(String(events[0]?.message), BARE_DEAD_LETTERED_RE);
    assert.equal(
      events[0]?.diagnostics?.syncLaneStall?.deadLetteredBasis,
      SyncLaneDeadLetteredBasis.AbandonedIdLedger
    );
  });

  it("ISS-9744: says nobody counted when the lane had no source key to count against", () => {
    // A gate-shut lane has no source key, so the store returned a placeholder
    // `0` without querying. Printing "0 dead-lettered" on the alert that reports
    // this machine is delivering NOTHING is the fabricated zero at its worst.
    const events = captureStall({
      ...baseInput,
      lane: "invocation_parts",
      kind: SyncLaneStallKind.GateShutWithBacklog,
      itemsRemaining: 3031,
      deadLetteredCount: 0,
      deadLetteredBasis: SyncLaneDeadLetteredBasis.Unmeasured,
    });

    assert.match(String(events[0]?.message), UNMEASURED_BASIS_RE);
    assert.doesNotMatch(String(events[0]?.message), BARE_DEAD_LETTERED_RE);
    assert.equal(
      events[0]?.diagnostics?.syncLaneStall?.deadLetteredBasis,
      SyncLaneDeadLetteredBasis.Unmeasured
    );
  });

  it("carries no content — only a lane id, counts, and an age", () => {
    const events = captureStall({
      ...baseInput,
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: 2928,
    });

    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("session-"), false);
    assert.equal(serialized.includes("/Users/"), false);
  });
});
