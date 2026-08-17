import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
} from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import {
  isSessionDetailStatusClockRelevant,
  resolveSessionDetailDisplayStatus,
} from "../session-detail-display-status";

/**
 * ISS-5818 (#4739 review, wongk): the Session DETAIL title chip's display
 * derivation.
 *
 * The cases that matter are the ones neither producer guarantees. The cloud
 * projects Waiting server-side, so a web payload arrives already carrying it;
 * the desktop local read projects it only in `mapListItem`, and only behind the
 * INDEPENDENT `sessions-displayed-status-parity` Labs flag — so the raw `active`
 * row below is not a contrived input, it is the exact shape `mapDetail` hands
 * this view on a desktop install with that flag off.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const JUST_INSIDE_CUTOFF = new Date(
  NOW.getTime() - (STALE_SESSION_DISPLAY_THRESHOLD_HOURS - 1) * HOUR_MS
);
const PAST_CUTOFF = new Date(
  NOW.getTime() - (STALE_SESSION_DISPLAY_THRESHOLD_HOURS + 1) * HOUR_MS
);

describe("resolveSessionDetailDisplayStatus", () => {
  it("projects Waiting from awaitingInputSince on a raw active row", () => {
    // The desktop-local shape with the displayed-status parity flag OFF. Without
    // this projection the detail chip badges "Active" here while the SAME
    // session reads "Waiting" on web — a cross-surface split produced by turning
    // on a layout flag.
    expect(
      resolveSessionDetailDisplayStatus({
        awaitingInputSince: JUST_INSIDE_CUTOFF,
        endedAt: null,
        lastActivityAt: JUST_INSIDE_CUTOFF,
        now: NOW,
        startedAt: JUST_INSIDE_CUTOFF,
        status: SESSION_STATUS.ACTIVE,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.WAITING);
  });

  it("is idempotent on a payload the producer already projected", () => {
    // The web shape: `projectDisplayedSessionStatus` ran server-side, so the
    // status is already `waiting`. The chip must land on the same word either
    // way, or the two surfaces disagree in the other direction.
    expect(
      resolveSessionDetailDisplayStatus({
        awaitingInputSince: JUST_INSIDE_CUTOFF,
        endedAt: null,
        lastActivityAt: JUST_INSIDE_CUTOFF,
        now: NOW,
        startedAt: JUST_INSIDE_CUTOFF,
        status: DISPLAYED_SESSION_STATUS.WAITING,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.WAITING);
  });

  it("does not project Waiting once the run has ended", () => {
    // ISS-4559: `awaitingInputSince` outlives the run. A terminal row that still
    // carries the timestamp must not be badged as blocked on a human.
    expect(
      resolveSessionDetailDisplayStatus({
        awaitingInputSince: JUST_INSIDE_CUTOFF,
        endedAt: NOW,
        lastActivityAt: JUST_INSIDE_CUTOFF,
        now: NOW,
        startedAt: JUST_INSIDE_CUTOFF,
        status: SESSION_STATUS.ACTIVE,
      })
    ).toBe(SESSION_STATUS.ACTIVE);
  });

  /**
   * ISS-6455: the chip reads both timestamps through the shared
   * `classifyAwaitingInputEvidence`, exactly as the Duration projection and the
   * Sessions list mapper do. On raw truthiness an unusable value made the chip
   * claim one thing while the Duration beside it claimed another — one screen,
   * two claims about one run.
   *
   * wongk (#5099 review) settled the answer, and the two fields get DIFFERENT
   * ones. An unreadable `endedAt` means this build cannot tell whether the run
   * is over, so the chip disclaims — the same `unknown` the Duration resolves,
   * whose window is unmeasurable. An unreadable `awaitingInputSince` withholds
   * only the staleness exemption, so the row folds normally rather than losing a
   * state the rest of its fields state perfectly well.
   */
  it("disclaims the state when endedAt is unreadable, matching the Duration derivation", () => {
    expect(
      resolveSessionDetailDisplayStatus({
        awaitingInputSince: JUST_INSIDE_CUTOFF,
        endedAt: new Date("not-a-date"),
        lastActivityAt: PAST_CUTOFF,
        now: NOW,
        startedAt: PAST_CUTOFF,
        status: SESSION_STATUS.ACTIVE,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.UNKNOWN);
  });

  it("folds normally when only awaitingInputSince is unreadable", () => {
    expect(
      resolveSessionDetailDisplayStatus({
        awaitingInputSince: new Date("not-a-date"),
        endedAt: null,
        lastActivityAt: PAST_CUTOFF,
        now: NOW,
        startedAt: PAST_CUTOFF,
        status: SESSION_STATUS.ACTIVE,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.STALE);
  });

  it("still projects Waiting when a VALID endedAt is simply absent", () => {
    // The control: the cases above must not be the corrupt guard swallowing
    // every awaiting-input row.
    expect(
      resolveSessionDetailDisplayStatus({
        awaitingInputSince: JUST_INSIDE_CUTOFF,
        endedAt: null,
        lastActivityAt: PAST_CUTOFF,
        now: NOW,
        startedAt: PAST_CUTOFF,
        status: SESSION_STATUS.ACTIVE,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.WAITING);
  });

  it("does not project Waiting on an already-terminal status", () => {
    // ISS-4654: fold first, so a straggler terminal row carrying the timestamp
    // keeps its outcome.
    expect(
      resolveSessionDetailDisplayStatus({
        awaitingInputSince: JUST_INSIDE_CUTOFF,
        endedAt: null,
        lastActivityAt: JUST_INSIDE_CUTOFF,
        now: NOW,
        startedAt: JUST_INSIDE_CUTOFF,
        status: SESSION_STATUS.ERROR,
      })
    ).toBe(SESSION_STATUS.ERROR);
  });

  it("keeps a waiting run out of the staleness fold", () => {
    // A run blocked on a human for days is still blocked on that human. Folding
    // it to "Stale" would replace a fact the user can act on with one they
    // cannot.
    expect(
      resolveSessionDetailDisplayStatus({
        awaitingInputSince: PAST_CUTOFF,
        endedAt: null,
        lastActivityAt: PAST_CUTOFF,
        now: NOW,
        startedAt: PAST_CUTOFF,
        status: SESSION_STATUS.ACTIVE,
      })
    ).toBe(DISPLAYED_SESSION_STATUS.WAITING);
  });

  it("measures the staleness cutoff against the injected clock, not the wall clock", () => {
    const input = {
      awaitingInputSince: null,
      endedAt: null,
      lastActivityAt: JUST_INSIDE_CUTOFF,
      startedAt: JUST_INSIDE_CUTOFF,
      status: SESSION_STATUS.ACTIVE,
    };
    // One session, two instants: the SAME inputs must resolve differently once
    // the caller's clock has advanced past the cutoff. This is what makes
    // feeding the view a coarse tick meaningful — a resolver reading its own
    // `new Date()` would answer whatever the render happened to catch.
    expect(resolveSessionDetailDisplayStatus({ ...input, now: NOW })).toBe(
      SESSION_STATUS.ACTIVE
    );
    expect(
      resolveSessionDetailDisplayStatus({
        ...input,
        now: new Date(NOW.getTime() + 2 * HOUR_MS),
      })
    ).toBe(DISPLAYED_SESSION_STATUS.STALE);
  });

  it("folds an unrecognized status to Unknown rather than claiming it is running", () => {
    expect(
      resolveSessionDetailDisplayStatus({
        awaitingInputSince: null,
        endedAt: null,
        lastActivityAt: JUST_INSIDE_CUTOFF,
        now: NOW,
        startedAt: JUST_INSIDE_CUTOFF,
        status: "quiesced",
      })
    ).toBe(DISPLAYED_SESSION_STATUS.UNKNOWN);
  });
});

describe("isSessionDetailStatusClockRelevant", () => {
  it("wants a clock for a running session, whose chip can still cross the cutoff", () => {
    expect(
      isSessionDetailStatusClockRelevant({
        awaitingInputSince: null,
        endedAt: null,
        status: SESSION_STATUS.ACTIVE,
      })
    ).toBe(true);
  });

  it("wants no clock for a terminal session", () => {
    // A finished run's chip is fixed, so a detail page parked on one must not
    // re-render the whole view on a timer forever.
    for (const status of [SESSION_STATUS.INACTIVE, SESSION_STATUS.ERROR]) {
      expect(
        isSessionDetailStatusClockRelevant({
          awaitingInputSince: null,
          endedAt: NOW,
          status,
        })
      ).toBe(false);
    }
  });

  it("wants no clock for a run that is waiting on a human", () => {
    expect(
      isSessionDetailStatusClockRelevant({
        awaitingInputSince: PAST_CUTOFF,
        endedAt: null,
        status: SESSION_STATUS.ACTIVE,
      })
    ).toBe(false);
  });

  it("wants no clock once a producer has already served a display-only status", () => {
    for (const status of [
      DISPLAYED_SESSION_STATUS.STALE,
      DISPLAYED_SESSION_STATUS.UNKNOWN,
    ]) {
      expect(
        isSessionDetailStatusClockRelevant({
          awaitingInputSince: null,
          endedAt: null,
          status,
        })
      ).toBe(false);
    }
  });
});
