import { describe, expect, it } from "vitest";
import {
  earliestSessionStartMs,
  firstActivityTFromSessions,
} from "./branch-lead-time-activity";

/**
 * Literals rather than values derived from the helper: the expected instant is
 * the contract this module owns, so an expectation computed the way the
 * implementation computes it would agree with any mistake it makes.
 */
const FIRST_START = "2026-07-03T04:00:00.000Z";
const SECOND_START = "2026-07-03T04:30:00.000Z";

function sessions(...startedAt: string[]) {
  return startedAt.map((value) => ({ startedAt: value }));
}

describe("firstActivityTFromSessions (ISS-8821)", () => {
  it("reports the EARLIEST session start, not the latest", () => {
    // Two starts, deliberately unordered and deliberately different: a
    // single-session fixture passes under both the shipped defect (return the
    // branch's last-active instant) and a max-instead-of-min mistake.
    expect(
      firstActivityTFromSessions(sessions(SECOND_START, FIRST_START))
    ).toBe(FIRST_START);
  });

  it("is null when no session carries a start to measure from", () => {
    expect(firstActivityTFromSessions([])).toBeNull();
  });

  it("is null when every session start is unparseable", () => {
    expect(firstActivityTFromSessions(sessions("not-a-date"))).toBeNull();
  });

  it("skips an unparseable start rather than poisoning the minimum", () => {
    expect(
      firstActivityTFromSessions(sessions("not-a-date", SECOND_START))
    ).toBe(SECOND_START);
  });
});

describe("earliestSessionStartMs", () => {
  it("returns the earliest parseable start in epoch milliseconds", () => {
    expect(earliestSessionStartMs(sessions(SECOND_START, FIRST_START))).toBe(
      Date.parse(FIRST_START)
    );
  });

  it("returns null for an empty session list", () => {
    expect(earliestSessionStartMs([])).toBeNull();
  });
});
