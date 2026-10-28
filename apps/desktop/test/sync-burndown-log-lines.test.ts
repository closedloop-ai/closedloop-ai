/**
 * @file sync-burndown-log-lines.test.ts
 * @description The operator-facing burn-down LINES: what each verdict actually
 * says to the human reading it.
 *
 * Split out of `sync-burndown-contract.test.ts` when ISS-9823 pushed that file
 * past the 1,000-line ceiling. The seam is a responsibility boundary rather than
 * a cut at a line count: everything here asserts rendered text, everything left
 * there asserts a classifier's or a detector's answer.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  formatLaneBurndownLine,
  formatLaneDrainedWithDeadLettersLine,
  formatLaneFullySyncedLine,
  formatLaneRemainingUnknownLine,
  OldestPendingBasis,
  type SyncLaneBurndown,
  SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
  SyncLaneId,
  SyncLaneRemainderBasis,
} from "../src/shared/sync-burndown-contract.js";
import { burndownLane } from "./helpers/sync-burndown-fixtures.js";

const CONTRACT_RE_4 = /items=12/;
const CONTRACT_RE_5 = /bytes=3\.0MiB/;
const CONTRACT_RE_6 = /chunks=n\/a/;
const CONTRACT_RE_7 = /deadLettered=2/;
const CONTRACT_RE_8 = /oldestPending=1h \(last_state_change\)/;
const CONTRACT_RE_9 = /sent=1\.0MiB/;
const CONTRACT_RE_10 = /items=n\/a/;
const CONTRACT_RE_11 = /bytes=unknown/;
const CONTRACT_RE_12 = /bytes=0B/;
const CONTRACT_RE_13 = /fully synced/;
const CONTRACT_RE_14 = /0 remaining, 0 dead-lettered/;
const DEAD_LETTER_VERDICT_BASIS_RE =
  /4 item\(s\) were dead-lettered \(queue_status_count at this sample; gave up, not caught up\)/;
const FULLY_SYNCED_BASIS_RE = /0 dead-lettered \(abandoned_id_ledger\)/;
const DEAD_LETTER_VERDICT_LEDGER_RE =
  /4 item\(s\) were dead-lettered \(abandoned_id_ledger at this sample; gave up, not caught up\)/;
const GIB_BYTES_RE = /bytes=2\.50GiB/;
const MIB_BYTES_RE = /MiB/;
const UNKNOWN_UNCLASSIFIABLE_ROWS_RE =
  /3 row\(s\) carry a status this build cannot classify/;
const UNKNOWN_NO_MEASURABLE_REMAINDER_RE =
  /this lane exposes no measurable remainder/;
const UNKNOWN_RESUME_BLOCKED_RE =
  /its once-per-identity resume read is failing/;
const OLDEST_PENDING_NONE_RE = /oldestPending=none \(enqueued_at\)/;
const OLDEST_PENDING_UNKNOWN_RE = /oldestPending=n\/a \(enqueued_at\)/;
const STRUCTURAL_AGE_UNKNOWN_RE =
  /oldestPending=n\/a \(no_per_item_timestamp\)/;
const OLDEST_PENDING_NONE_ANY_BASIS_RE = /oldestPending=none/;

/**
 * The lane these line assertions render. It differs from the shared fixture in
 * exactly the fields a LINE has to print: a chunk count and a durable cursor
 * that actually exist.
 */
function lane(overrides: Partial<SyncLaneBurndown> = {}): SyncLaneBurndown {
  return burndownLane({
    chunksRemaining: 0,
    durableCursorValue: "2026-08-06T10:00:00.000Z",
    durableCursorWrittenAtIso: "2026-08-06T10:00:01.000Z",
    durableCursorAgeMs: 1000,
    ...overrides,
  });
}

describe("sync burn-down log lines", () => {
  it("ISS-10380: a counted-empty lane without per-item timestamps prints n/a", () => {
    const line = formatLaneBurndownLine(
      lane({
        lane: SyncLaneId.ComponentInventory,
        itemsRemaining: 0,
        oldestPendingSinceIso: null,
        oldestPendingAgeMs: null,
        oldestPendingBasis: OldestPendingBasis.NoPerItemTimestamp,
      })
    );
    assert.match(line, STRUCTURAL_AGE_UNKNOWN_RE);
    assert.doesNotMatch(line, OLDEST_PENDING_NONE_ANY_BASIS_RE);
  });

  it("carries counts, sizes, ages, and the durable cursor — and no content", () => {
    const line = formatLaneBurndownLine(
      lane({
        lane: SyncLaneId.TranscriptArchive,
        state: SyncLaneDrainState.Draining,
        itemsRemaining: 12,
        bytesRemaining: 3_145_728,
        chunksRemaining: null,
        deadLetteredCount: 2,
        oldestPendingAgeMs: 90 * 60 * 1000,
        oldestPendingBasis: OldestPendingBasis.LastStateChange,
        workCompletedSincePrevious: 4,
        bytesSentSincePrevious: 1_048_576,
      })
    );
    assert.match(line, CONTRACT_RE_4);
    assert.match(line, CONTRACT_RE_5);
    assert.match(line, CONTRACT_RE_6);
    assert.match(line, CONTRACT_RE_7);
    assert.match(line, CONTRACT_RE_8);
    assert.match(line, CONTRACT_RE_9);
  });

  it("prints an unmeasurable quantity as unknown rather than zero", () => {
    const line = formatLaneBurndownLine(
      lane({ bytesRemaining: null, itemsRemaining: null })
    );
    assert.match(line, CONTRACT_RE_10);
    assert.match(line, CONTRACT_RE_11);
    assert.doesNotMatch(
      line,
      CONTRACT_RE_12,
      "a fabricated zero is the reassuring lie this burn-down exists to stop"
    );
  });

  it("names an unclassifiable-row cause on the unknown-remainder line", () => {
    const line = formatLaneRemainingUnknownLine(
      lane({
        state: SyncLaneDrainState.RemainingUnknown,
        itemsRemaining: 0,
        unmeasuredRows: 3,
      })
    );
    assert.match(line, UNKNOWN_UNCLASSIFIABLE_ROWS_RE);
  });

  it("names the FAILING RESUME as the cause, not the benign structural one", () => {
    // ISS-9823 review. A resume-blocked session lane reports honest measured
    // zeros — `unmeasuredRows: 0`, `itemsRemaining: 0` — so before this it fell
    // to the else arm and the one operator-facing line for this state read
    // "this lane exposes no measurable remainder": the benign, structural
    // reading of a state that is actually a durable read failing every pass.
    const line = formatLaneRemainingUnknownLine(
      lane({
        state: SyncLaneDrainState.RemainingUnknown,
        resumeBlocked: true,
        itemsRemaining: 0,
        unmeasuredRows: 0,
      })
    );

    assert.match(line, UNKNOWN_RESUME_BLOCKED_RE);
    assert.doesNotMatch(
      line,
      UNKNOWN_NO_MEASURABLE_REMAINDER_RE,
      "a lane that measured a clean zero does not expose no remainder — it exposes a fault"
    );
  });

  it("names an absent measurement cause on the unknown-remainder line", () => {
    const line = formatLaneRemainingUnknownLine(
      lane({
        state: SyncLaneDrainState.RemainingUnknown,
        itemsRemaining: null,
        unmeasuredRows: 0,
      })
    );
    assert.match(line, UNKNOWN_NO_MEASURABLE_REMAINDER_RE);
  });

  it("ISS-9744: names the basis on the gave-up verdict line, not just a bare count", () => {
    // The verdict line an operator reads when a lane stops owing work WITHOUT
    // catching up. "4 item(s) were dead-lettered" alone reads as a running total
    // of losses; on an outbox lane it is a status count that a redrive lowers.
    const line = formatLaneDrainedWithDeadLettersLine(
      lane({
        state: SyncLaneDrainState.DrainedWithDeadLetters,
        deadLetteredCount: 4,
        deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
      })
    );
    assert.match(line, DEAD_LETTER_VERDICT_BASIS_RE);
  });

  it("ISS-9744: carries the LEDGER basis on that same line for the cursor lane", () => {
    // Same sentence, different population. Rendering the constant for whichever
    // lane happens to be common would be the collapse in its most durable form.
    const line = formatLaneDrainedWithDeadLettersLine(
      lane({
        lane: SyncLaneId.ComponentInventory,
        state: SyncLaneDrainState.DrainedWithDeadLetters,
        deadLetteredCount: 4,
        deadLetteredBasis: SyncLaneDeadLetteredBasis.AbandonedIdLedger,
      })
    );
    assert.match(line, DEAD_LETTER_VERDICT_LEDGER_RE);
  });

  it("states zero remaining AND zero dead-lettered on the fully-synced line", () => {
    const line = formatLaneFullySyncedLine(lane());
    assert.match(line, CONTRACT_RE_13);
    assert.match(line, CONTRACT_RE_14);
  });

  it("ISS-9744: qualifies even the caught-up zero with the basis it was read from", () => {
    // `0 dead-lettered` on the one line that declares victory is the reassuring
    // number this file exists to police. Saying which population produced it is
    // what lets a reader tell a counted zero from a lane nobody could count.
    const line = formatLaneFullySyncedLine(
      lane({ deadLetteredBasis: SyncLaneDeadLetteredBasis.AbandonedIdLedger })
    );
    assert.match(line, FULLY_SYNCED_BASIS_RE);
  });

  it("tells a COUNTED-empty backlog age from one nobody counted", () => {
    // ISS-10082, one column over. All three lanes below carry
    // `oldestPendingSinceIso: null` and all three printed `n/a`, so the drain an
    // operator is waiting for read exactly like the lane the store
    // short-circuited — on the one surface built to tell them apart.
    const drained = formatLaneBurndownLine(
      lane({ state: SyncLaneDrainState.Drained, itemsRemaining: 0 })
    );
    assert.match(drained, OLDEST_PENDING_NONE_RE);
    assert.doesNotMatch(
      drained,
      OLDEST_PENDING_UNKNOWN_RE,
      "this lane COUNTED its queue and found nothing owed; `n/a` gives that measurement away"
    );

    const unread = formatLaneBurndownLine(
      lane({
        state: SyncLaneDrainState.RemainingUnknown,
        itemsRemaining: null,
        deadLetteredBasis: SyncLaneDeadLetteredBasis.Unmeasured,
        remainderBasis: SyncLaneRemainderBasis.Unqueried,
      })
    );
    assert.match(unread, OLDEST_PENDING_UNKNOWN_RE);
    assert.doesNotMatch(
      unread,
      OLDEST_PENDING_NONE_RE,
      "`none` claims the queue was counted and found empty; nobody read this lane"
    );

    // The third member of the impossible set, not just the two everyone
    // remembers: a queue that WAS counted but carries rows this build cannot
    // classify has not measured an empty one, so its age is unknown too.
    const partlyClassified = formatLaneBurndownLine(
      lane({
        state: SyncLaneDrainState.RemainingUnknown,
        itemsRemaining: 0,
        unmeasuredRows: 3,
      })
    );
    assert.match(partlyClassified, OLDEST_PENDING_UNKNOWN_RE);
    assert.doesNotMatch(partlyClassified, OLDEST_PENDING_NONE_RE);

    // ISS-9823's lane, the one an operator can actually act on. Its counts ARE
    // zero and ARE counted, but every pass is abandoned before it can enqueue,
    // so `formatLaneRemainingUnknownLine` names this cause first and names it a
    // fault: the zeros are not evidence of anything. `none` would be this whole
    // subsystem printing a drain over a wedged device.
    const resumeBlocked = formatLaneBurndownLine(
      lane({
        state: SyncLaneDrainState.RemainingUnknown,
        itemsRemaining: 0,
        resumeBlocked: true,
      })
    );
    assert.match(resumeBlocked, OLDEST_PENDING_UNKNOWN_RE);
    assert.doesNotMatch(resumeBlocked, OLDEST_PENDING_NONE_RE);

    // A timestamp that would not parse: `ageMsFrom` answers `null` rather than
    // fabricate a brand-new age, and it lands beside a count `toCount` degraded
    // from a corrupt aggregate. Nothing was measured here either.
    const corruptTimestamp = formatLaneBurndownLine(
      lane({
        state: SyncLaneDrainState.RemainingUnknown,
        itemsRemaining: 0,
        oldestPendingSinceIso: "not-a-date",
        oldestPendingAgeMs: null,
      })
    );
    assert.match(corruptTimestamp, OLDEST_PENDING_UNKNOWN_RE);
    assert.doesNotMatch(corruptTimestamp, OLDEST_PENDING_NONE_RE);
  });

  it("scales a multi-gigabyte remainder to GiB, not a five-digit MiB count", () => {
    // A first backfill routinely owes gigabytes. `2621440.0MiB` is technically
    // true and operationally unreadable, which is how a burn-down line stops
    // being read at all.
    const line = formatLaneBurndownLine(
      lane({ bytesRemaining: 2.5 * 1024 ** 3 })
    );
    assert.match(line, GIB_BYTES_RE);
    assert.doesNotMatch(line, MIB_BYTES_RE);
  });
});
