import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  resolveBranchLastActiveMetric,
  UNCOMPUTED_SESSION_LAST_ACTIVITY_MS,
} from "./branch-last-active";

const BRANCH_AT = "2026-10-01T12:00:00.000Z";
const NEWER_SESSION_AT = "2026-10-05T08:00:00.000Z";
const OLDER_SESSION_AT = "2026-09-20T08:00:00.000Z";
const EPOCH_ISO = new Date(UNCOMPUTED_SESSION_LAST_ACTIVITY_MS).toISOString();

describe("resolveBranchLastActiveMetric (ISS-11915)", () => {
  it("keeps the Branch's own evidence over a newer linked session", () => {
    const result = resolveBranchLastActiveMetric(
      [{ sourceEventId: "atom:1", occurredAt: BRANCH_AT }],
      [{ sessionId: "s1", lastActivityAt: NEWER_SESSION_AT }]
    );

    expect(result.value).toBe(BRANCH_AT);
  });

  it("falls back to the latest linked session when the Branch has no instant", () => {
    const result = resolveBranchLastActiveMetric(
      [],
      [
        { sessionId: "s1", lastActivityAt: OLDER_SESSION_AT },
        { sessionId: "s2", lastActivityAt: new Date(NEWER_SESSION_AT) },
      ]
    );

    expect(result.value).toBe(NEWER_SESSION_AT);
    expect(result.state).toBe(BranchMetricAvailability.Partial);
  });

  it("falls back when every Branch event is malformed", () => {
    const result = resolveBranchLastActiveMetric(
      [{ sourceEventId: "atom:1", occurredAt: "not-a-date" }],
      [{ sessionId: "s1", lastActivityAt: OLDER_SESSION_AT }]
    );

    expect(result.value).toBe(OLDER_SESSION_AT);
  });

  it("skips the uncomputed epoch default in either representation", () => {
    for (const lastActivityAt of [
      EPOCH_ISO,
      new Date(UNCOMPUTED_SESSION_LAST_ACTIVITY_MS),
    ]) {
      const result = resolveBranchLastActiveMetric(
        [],
        [{ sessionId: "s1", lastActivityAt }]
      );
      expect(result).toEqual({
        state: BranchMetricAvailability.Unavailable,
        value: null,
      });
    }
  });

  it("skips missing and unparseable session values but keeps a valid sibling", () => {
    const result = resolveBranchLastActiveMetric(
      [],
      [
        { sessionId: "s1", lastActivityAt: null },
        { sessionId: "s2", lastActivityAt: undefined },
        { sessionId: "s3", lastActivityAt: "" },
        { sessionId: "s4", lastActivityAt: "garbage" },
        { sessionId: "s5", lastActivityAt: new Date(Number.NaN) },
        { sessionId: "s6", lastActivityAt: EPOCH_ISO },
        { sessionId: "s7", lastActivityAt: OLDER_SESSION_AT },
      ]
    );

    expect(result.value).toBe(OLDER_SESSION_AT);
  });

  it("reports no activity when neither the Branch nor a session has one", () => {
    expect(resolveBranchLastActiveMetric([], []).value).toBeNull();
  });
});
