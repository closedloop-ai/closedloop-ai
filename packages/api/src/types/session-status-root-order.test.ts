import { describe, expect, it } from "vitest";
import { SESSION_STATUS } from "./session-status.ts";
import {
  compareSessionSortIdentityDescending,
  compareSessionSortIdsDescending,
  SessionStatusOrderingName,
  sessionStatusRootRankOrNull,
} from "./session-status-root-order.ts";

describe("D5 shared Sessions root ordering", () => {
  it("DT-19/20: maps exactly the three persisted statuses and refuses unknown roots", () => {
    expect(sessionStatusRootRankOrNull(SESSION_STATUS.ACTIVE)).toBe(1);
    expect(sessionStatusRootRankOrNull(SESSION_STATUS.INACTIVE)).toBe(3);
    expect(sessionStatusRootRankOrNull(SESSION_STATUS.ERROR)).toBe(4);
    expect(sessionStatusRootRankOrNull("waiting")).toBeNull();
    expect(sessionStatusRootRankOrNull("__proto__")).toBeNull();
    expect(sessionStatusRootRankOrNull("constructor")).toBeNull();
    expect(sessionStatusRootRankOrNull(null)).toBeNull();
    expect(Object.values(SessionStatusOrderingName)).toEqual([
      "vocabulary",
      "root_first",
    ]);
  });

  it("DT-19/20: applies the same unique descending ID tie in either host", () => {
    expect(compareSessionSortIdsDescending("z", "a")).toBeLessThan(0);
    expect(compareSessionSortIdsDescending("a", "z")).toBeGreaterThan(0);
    expect(compareSessionSortIdsDescending("z", "z")).toBe(0);
  });

  it("DT-24: compares target before its local session ID", () => {
    expect(
      compareSessionSortIdentityDescending(
        { computeTargetId: "target-z", externalSessionId: "a" },
        { computeTargetId: "target-a", externalSessionId: "z" }
      )
    ).toBeLessThan(0);
    expect(
      compareSessionSortIdentityDescending(
        { computeTargetId: null, externalSessionId: "z" },
        { computeTargetId: null, externalSessionId: "a" }
      )
    ).toBeLessThan(0);
  });
});
