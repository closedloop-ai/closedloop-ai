import { describe, expect, it } from "vitest";
import { SESSION_STATUS } from "./session-status.ts";
import {
  SESSION_STATUS_RANK,
  sessionStatusRank,
} from "./session-status-rank.ts";

describe("SESSION_STATUS_RANK", () => {
  it("pins the complete lifecycle order without depending on declaration order", () => {
    expect(SESSION_STATUS_RANK).toEqual({
      [SESSION_STATUS.ACTIVE]: 0,
      [SESSION_STATUS.INACTIVE]: 1,
      [SESSION_STATUS.ERROR]: 2,
    });
  });

  it("leaves retired, missing, and unrecognized values unranked", () => {
    // ISS-10364 retired `DISPLAYED_SESSION_STATUS.WAITING`/`UNKNOWN`/`STALE`, so
    // these are plain literals now — still unranked, same as any other spelling
    // outside the three-value lifecycle set.
    expect(sessionStatusRank("waiting")).toBeNull();
    expect(sessionStatusRank("unknown")).toBeNull();
    expect(sessionStatusRank("stale")).toBeNull();
    expect(sessionStatusRank("future-status")).toBeNull();
    expect(sessionStatusRank(null)).toBeNull();
    expect(sessionStatusRank(undefined)).toBeNull();
  });
});
