import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { resolveDisplayedSessionStatusWithWaiting } from "@repo/app/agents/lib/session-displayed-status-with-waiting";
import { describe, expect, it } from "vitest";

/**
 * ISS-6455 (whitlockk, #5099 review): originally the matrix for the Waiting/Unknown
 * projection this resolver ran ahead of the shared fold.
 *
 * ISS-10364 (operator ruling, Cosimo Corrigan, 2026-09-23/24) retired that
 * projection outright: `resolveDisplayedSessionStatusWithWaiting` is now a
 * pure alias of `resolveDisplayedSessionStatus`, so `awaitingInputSince` and
 * `endedAt` no longer influence its answer at all — only `status` does, via
 * the ordinary lifecycle fold. This file was rewritten from the pre-ISS-10364
 * suite, which pinned the retired instant-evidence matrix.
 */

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-06-17T12:00:00.000Z");
const STARTED_AT = new Date(NOW.getTime() - 60 * HOUR_MS);
const AWAITING_SINCE = new Date(NOW.getTime() - 30 * HOUR_MS);
/** What `new Date(...)` yields for a malformed value from a skewed producer. */
const UNPARSEABLE = new Date("not-a-date");

function resolveFor(
  overrides: Partial<
    Parameters<typeof resolveDisplayedSessionStatusWithWaiting>[0]
  > = {}
) {
  return resolveDisplayedSessionStatusWithWaiting({
    endedAt: null,
    lastActivityAt: STARTED_AT,
    now: NOW,
    startedAt: STARTED_AT,
    status: SESSION_STATUS.ACTIVE,
    ...overrides,
  });
}

describe("resolveDisplayedSessionStatusWithWaiting", () => {
  it("folds a recognized lifecycle status to itself", () => {
    for (const status of [
      SESSION_STATUS.ACTIVE,
      SESSION_STATUS.INACTIVE,
      SESSION_STATUS.ERROR,
    ]) {
      expect(resolveFor({ status })).toBe(status);
    }
  });

  it("ISS-10364: folds a retired or unrecognized spelling to Active", () => {
    for (const status of ["waiting", "stale", "unknown", "quantum-flux"]) {
      expect(resolveFor({ status })).toBe(SESSION_STATUS.ACTIVE);
    }
  });

  it("ISS-10364: awaitingInputSince no longer changes the answer, present or absent, valid or corrupt", () => {
    for (const awaitingInputSince of [
      null,
      AWAITING_SINCE,
      UNPARSEABLE,
      "",
    ] as const) {
      expect(resolveFor({ awaitingInputSince })).toBe(SESSION_STATUS.ACTIVE);
    }
  });

  it("ISS-10364: endedAt no longer changes the answer for a non-terminal status", () => {
    for (const endedAt of [
      null,
      UNPARSEABLE,
      new Date(NOW.getTime() - HOUR_MS),
    ]) {
      expect(resolveFor({ endedAt })).toBe(SESSION_STATUS.ACTIVE);
    }
  });

  it("keeps a TERMINAL status verbatim even when its end instant is unreadable", () => {
    expect(
      resolveFor({
        endedAt: UNPARSEABLE,
        status: SESSION_STATUS.INACTIVE,
      })
    ).toBe(SESSION_STATUS.INACTIVE);
  });
});
