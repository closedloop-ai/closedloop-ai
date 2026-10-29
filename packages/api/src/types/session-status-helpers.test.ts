import { describe, expect, it } from "vitest";
import {
  DISPLAYED_SESSION_STATUS,
  foldToDisplayedSessionStatus,
  isRecognizedSessionStatus,
  isSessionDisplayStale,
  RECOGNIZED_SESSION_STATUS_VALUES,
  resolveSessionDurationLifecycle,
  SESSION_STATUS,
  SessionDurationLifecycle,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
} from "./session-status.ts";

const MS_PER_HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-09-28T12:00:00.000Z");

// ISS-10364 (operator ruling, 2026-09-23/24) retired `isDisplayOnlySessionStatus`
// along with the two members it existed to recognize (`unknown`, `stale`): there
// is no longer a display-only member for it to tell apart from a lifecycle one,
// so the function itself is gone rather than kept answering `false` for
// everything.

describe("isRecognizedSessionStatus", () => {
  it("recognizes exactly the displayed vocabulary", () => {
    expect([...RECOGNIZED_SESSION_STATUS_VALUES].sort()).toEqual(
      Object.values(DISPLAYED_SESSION_STATUS).sort()
    );
    for (const value of Object.values(DISPLAYED_SESSION_STATUS)) {
      expect(isRecognizedSessionStatus(value)).toBe(true);
    }
  });

  it("rejects unknown values, case variants, and inherited keys", () => {
    expect(isRecognizedSessionStatus("running")).toBe(false);
    expect(isRecognizedSessionStatus("ACTIVE")).toBe(false);
    expect(isRecognizedSessionStatus("toString")).toBe(false);
    expect(isRecognizedSessionStatus("")).toBe(false);
  });
});

describe("foldToDisplayedSessionStatus", () => {
  /*
   * ISS-10364: this used to match `unknown`/`stale` verbatim (display-only
   * members, matched ahead of the fold) and preserve `waiting`. All three are
   * retired, so this is now a pure alias of `normalizeDisplayedSessionStatus` —
   * every one of those spellings, like any other unrecognized one, folds to
   * ACTIVE.
   */
  it.each([
    ["unknown", SESSION_STATUS.ACTIVE],
    ["stale", SESSION_STATUS.ACTIVE],
    ["waiting", SESSION_STATUS.ACTIVE],
    [SESSION_STATUS.ACTIVE, SESSION_STATUS.ACTIVE],
    [SESSION_STATUS.INACTIVE, SESSION_STATUS.INACTIVE],
    [SESSION_STATUS.ERROR, SESSION_STATUS.ERROR],
    ["garbage", SESSION_STATUS.ACTIVE],
  ])("%s -> %s", (status, expected) => {
    expect(foldToDisplayedSessionStatus(status)).toBe(expected);
  });
});

describe("isSessionDisplayStale", () => {
  const threshold = STALE_SESSION_DISPLAY_THRESHOLD_HOURS * MS_PER_HOUR;

  it("is false for an absent or empty timestamp", () => {
    expect(isSessionDisplayStale(null, NOW)).toBe(false);
    expect(isSessionDisplayStale(undefined, NOW)).toBe(false);
    expect(isSessionDisplayStale("", NOW)).toBe(false);
  });

  it("is strictly past the threshold, for Date and string input", () => {
    const atThreshold = new Date(NOW.getTime() - threshold);
    const pastThreshold = new Date(NOW.getTime() - threshold - 1);
    expect(isSessionDisplayStale(atThreshold, NOW)).toBe(false);
    expect(isSessionDisplayStale(pastThreshold, NOW)).toBe(true);
    expect(isSessionDisplayStale(pastThreshold.toISOString(), NOW)).toBe(true);
    expect(isSessionDisplayStale(atThreshold.toISOString(), NOW)).toBe(false);
  });

  it("is false for an unparseable timestamp", () => {
    expect(isSessionDisplayStale("not-a-date", NOW)).toBe(false);
  });
});

describe("resolveSessionDurationLifecycle case handling", () => {
  it("lower-cases before folding", () => {
    expect(resolveSessionDurationLifecycle("INACTIVE")).toBe(
      SessionDurationLifecycle.Ended
    );
    expect(resolveSessionDurationLifecycle("Error")).toBe(
      SessionDurationLifecycle.Ended
    );
    expect(resolveSessionDurationLifecycle("ACTIVE")).toBe(
      SessionDurationLifecycle.Running
    );
    expect(resolveSessionDurationLifecycle("Waiting")).toBe(
      SessionDurationLifecycle.Running
    );
    expect(resolveSessionDurationLifecycle(undefined)).toBe(
      SessionDurationLifecycle.Indeterminate
    );
    // ISS-10364: "stale" is a plain literal now (the member is retired) and, like
    // any other unrecognized-or-retired spelling, folds to ACTIVE and classifies
    // Running — not Indeterminate — so Duration agrees with the ACTIVE badge.
    expect(resolveSessionDurationLifecycle("stale")).toBe(
      SessionDurationLifecycle.Running
    );
  });
});
