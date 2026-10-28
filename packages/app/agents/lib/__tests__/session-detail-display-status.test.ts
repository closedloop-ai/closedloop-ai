import {
  SESSION_STATUS,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
} from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import { resolveSessionDetailDisplayStatus } from "../session-detail-display-status";

/**
 * ISS-5818 (#4739 review, whitlockk): the Session DETAIL title chip's display
 * derivation.
 *
 * ISS-10364 (operator ruling, Cosimo Corrigan, 2026-09-23/24) retired the
 * Waiting/Unknown projection this module used to run ahead of the shared
 * resolver: `resolveSessionDetailDisplayStatus` is now a pure alias of
 * `resolveDisplayedSessionStatus`, which folds `status` alone — the timestamp
 * fields stay on the signature so callers keep compiling, but none of them are
 * read any more. This file was rewritten from the pre-ISS-10364 suite, which
 * pinned a Waiting/Unknown projection that no longer exists.
 *
 * `isSessionDetailStatusClockRelevant` and its four cases went with the module's
 * own deletion of that predicate: with the chip's value depending only on the
 * stored status, "can this chip still change because time passed" has no caller
 * and no question to answer.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const SOME_INSTANT = new Date(NOW.getTime() - 2 * HOUR_MS);
/**
 * Comfortably past `STALE_SESSION_DISPLAY_THRESHOLD_HOURS`, read from the
 * canonical constant rather than a local 24: the clock counterfactual below is
 * only a counterfactual if its fixture actually crosses the cutoff a restored
 * fold would use.
 */
const SILENT_PAST_CUTOFF = new Date(
  NOW.getTime() - (STALE_SESSION_DISPLAY_THRESHOLD_HOURS + 6) * HOUR_MS
);

describe("resolveSessionDetailDisplayStatus", () => {
  it("folds a recognized lifecycle status to itself, regardless of timestamps", () => {
    for (const status of [
      SESSION_STATUS.ACTIVE,
      SESSION_STATUS.INACTIVE,
      SESSION_STATUS.ERROR,
    ]) {
      expect(
        resolveSessionDetailDisplayStatus({
          awaitingInputSince: SOME_INSTANT,
          endedAt: SOME_INSTANT,
          lastActivityAt: SOME_INSTANT,
          now: NOW,
          startedAt: SOME_INSTANT,
          status,
        })
      ).toBe(status);
    }
  });

  it("ISS-10364: folds a retired or unrecognized spelling to Active, the same fail-open every other unmodelled status takes", () => {
    // "waiting"/"stale"/"unknown" are no longer `DISPLAYED_SESSION_STATUS`
    // members — a producer predating the ruling, or a genuinely future
    // spelling, both fail open to Active now.
    for (const status of ["waiting", "stale", "unknown", "quiesced"]) {
      expect(
        resolveSessionDetailDisplayStatus({
          awaitingInputSince: null,
          endedAt: null,
          lastActivityAt: SOME_INSTANT,
          now: NOW,
          startedAt: SOME_INSTANT,
          status,
        })
      ).toBe(SESSION_STATUS.ACTIVE);
    }
  });

  it("ISS-10364: awaitingInputSince and endedAt no longer influence the chip at all", () => {
    // The Waiting projection and the Unknown disclaim-on-corrupt-endedAt
    // branch are both gone. A corrupt `endedAt` alongside an `awaitingInputSince`
    // used to disclaim to Unknown; now it is simply not read.
    expect(
      resolveSessionDetailDisplayStatus({
        awaitingInputSince: SOME_INSTANT,
        endedAt: new Date("not-a-date"),
        lastActivityAt: SOME_INSTANT,
        now: NOW,
        startedAt: SOME_INSTANT,
        status: SESSION_STATUS.ACTIVE,
      })
    ).toBe(SESSION_STATUS.ACTIVE);
  });

  it("ISS-10364: the injected clock no longer changes the fold — the same inputs resolve identically before and after the old cutoff", () => {
    const input = {
      awaitingInputSince: null,
      endedAt: null,
      // PAST the cutoff, not merely two hours old: a fixture inside the window
      // resolves Active under a restored staleness fold too, so it would leave
      // this case green on exactly the regression it names.
      lastActivityAt: SILENT_PAST_CUTOFF,
      startedAt: SILENT_PAST_CUTOFF,
      status: SESSION_STATUS.ACTIVE,
    };
    // `resolveDisplayedSessionStatus`'s `now`/`lastActivityAt`/`startedAt`
    // parameters stay on its signature for this step of the stack but are no
    // longer read, so the ONE thing this counterfactual pins is that a row
    // silent past the old cutoff still reads Active, and advancing `now` further
    // cannot flip it — a change that quietly restores a silence cutoff must
    // edit this.
    expect(resolveSessionDetailDisplayStatus({ ...input, now: NOW })).toBe(
      SESSION_STATUS.ACTIVE
    );
    expect(
      resolveSessionDetailDisplayStatus({
        ...input,
        now: new Date(NOW.getTime() + 2 * HOUR_MS),
      })
    ).toBe(SESSION_STATUS.ACTIVE);
  });
});
