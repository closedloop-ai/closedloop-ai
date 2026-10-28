import { describe, expect, it } from "vitest";
import type { CloudSyncProgress } from "../../../hooks/use-cloud-sync-progress";
import {
  countOrNull,
  deliveredSessions,
  inFlightTotalSessions,
  pendingSessions,
  resolveSyncCounter,
  uploadQueueCounts,
} from "../cloud-sync-pending-sessions";

// ISS-10696: pins the renderer's "measured or unknown" fold over the cloud sync
// snapshot. Every refusal here is a `null`, never a `0` — a queue the lane has
// not measured must not render as an empty one.

const IDENTIFIED: CloudSyncProgress = {
  identified: true,
  pendingBackfillSessions: 3,
  pendingIncrementalSessions: 4,
  backfilling: true,
  caughtUp: false,
  deadLetteredSessions: 0,
};

describe("pendingSessions", () => {
  it("sums both owed queues once the lane has identified the device", () => {
    expect(pendingSessions(IDENTIFIED)).toBe(7);
  });

  it("answers null with no snapshot at all", () => {
    expect(pendingSessions(null)).toBeNull();
  });

  it("answers null for a device the lane has not identified", () => {
    expect(pendingSessions({ ...IDENTIFIED, identified: false })).toBeNull();
  });

  it("discards the whole sample when either queue carries a non-count", () => {
    expect(
      pendingSessions({ ...IDENTIFIED, pendingBackfillSessions: -1 })
    ).toBeNull();
    expect(
      pendingSessions({
        ...IDENTIFIED,
        pendingIncrementalSessions: Number.POSITIVE_INFINITY,
      })
    ).toBeNull();
  });

  // pins current behavior (ISS-10702); looks odd because a fractional queue
  // size is not a count, yet it is floored into one instead of discarding the
  // sample.
  it("floors fractional queue sizes rather than rounding them up", () => {
    expect(
      pendingSessions({
        ...IDENTIFIED,
        pendingBackfillSessions: 1.9,
        pendingIncrementalSessions: 0.2,
      })
    ).toBe(1);
  });
});

describe("countOrNull", () => {
  it("keeps zero as a measured count", () => {
    expect(countOrNull(0)).toBe(0);
  });

  it("refuses NaN, negatives and infinities", () => {
    expect(countOrNull(Number.NaN)).toBeNull();
    expect(countOrNull(-0.5)).toBeNull();
    expect(countOrNull(Number.NEGATIVE_INFINITY)).toBeNull();
  });
});

describe("deliveredSessions / inFlightTotalSessions", () => {
  it("read the lane's optional pair only from an identified snapshot", () => {
    const progress: CloudSyncProgress = {
      ...IDENTIFIED,
      deliveredSessions: 12,
      inFlightTotalSessions: 40,
    };
    expect(deliveredSessions(progress)).toBe(12);
    expect(inFlightTotalSessions(progress)).toBe(40);
    expect(deliveredSessions({ ...progress, identified: false })).toBeNull();
    expect(
      inFlightTotalSessions({ ...progress, identified: false })
    ).toBeNull();
    expect(deliveredSessions(null)).toBeNull();
    expect(inFlightTotalSessions(null)).toBeNull();
  });

  it("treat an absent field and a null field the same way — unknown, not zero", () => {
    expect(deliveredSessions(IDENTIFIED)).toBeNull();
    expect(inFlightTotalSessions(IDENTIFIED)).toBeNull();
    expect(
      deliveredSessions({ ...IDENTIFIED, deliveredSessions: null })
    ).toBeNull();
    expect(
      inFlightTotalSessions({ ...IDENTIFIED, inFlightTotalSessions: null })
    ).toBeNull();
  });

  // pins current behavior (ISS-10702); looks odd because the fractional
  // in-flight total is floored while the negative delivered count is refused.
  it("refuses a negative delivered count and floors a fractional in-flight total", () => {
    expect(
      deliveredSessions({ ...IDENTIFIED, deliveredSessions: -3 })
    ).toBeNull();
    expect(
      inFlightTotalSessions({ ...IDENTIFIED, inFlightTotalSessions: 2.5 })
    ).toBe(2);
  });
});

describe("resolveSyncCounter", () => {
  it("prints the lane's own measured pair", () => {
    expect(resolveSyncCounter({ delivered: 30, total: 40 })).toEqual({
      completed: 30,
      total: 40,
    });
  });

  it("refuses a lane pair whose total is zero rather than printing a full bar", () => {
    expect(resolveSyncCounter({ delivered: 0, total: 0 })).toBeNull();
  });

  it("answers null when either half of the lane pair is unmeasured, with no derived fallback", () => {
    expect(resolveSyncCounter({ delivered: null, total: 40 })).toBeNull();
    expect(resolveSyncCounter({ delivered: 30, total: null })).toBeNull();
  });
});

// ISS-12529: the upload queue view's three disjoint counts, split out of the
// same snapshot. Unmeasured is `null`, never an empty queue.
describe("uploadQueueCounts", () => {
  const MEASURED: CloudSyncProgress = {
    ...IDENTIFIED,
    sendingSessions: 3,
    deadLetteredSessions: 5,
  };

  it("splits pending into in flight (the batch on the wire) and queued (the rest), with failed beside them", () => {
    expect(uploadQueueCounts(MEASURED)).toEqual({
      queued: 4,
      inFlight: 3,
      failed: 5,
    });
  });

  it("counts sessions only, not component-inventory dead-letters", () => {
    expect(
      uploadQueueCounts({ ...MEASURED, deadLetteredComponents: 40 })?.failed
    ).toBe(5);
  });

  it("answers zeros for a drained lane", () => {
    expect(
      uploadQueueCounts({
        ...MEASURED,
        pendingBackfillSessions: 0,
        pendingIncrementalSessions: 0,
        sendingSessions: 0,
        deadLetteredSessions: 0,
      })
    ).toEqual({ queued: 0, inFlight: 0, failed: 0 });
  });

  it("answers null with no snapshot or an unidentified device", () => {
    expect(uploadQueueCounts(null)).toBeNull();
    expect(uploadQueueCounts({ ...MEASURED, identified: false })).toBeNull();
  });

  it("answers null when the sending count is absent or not yet measured (whitlockk review)", () => {
    // Absent: a main process that predates the field.
    expect(uploadQueueCounts(IDENTIFIED)).toBeNull();
    // Null: before the initial history walk has enumerated anything, the empty
    // queues are not an empty upload queue.
    expect(
      uploadQueueCounts({
        ...MEASURED,
        pendingBackfillSessions: 0,
        pendingIncrementalSessions: 0,
        sendingSessions: null,
        deadLetteredSessions: 0,
      })
    ).toBeNull();
  });

  it("answers null when a count is corrupt or sending exceeds pending", () => {
    expect(
      uploadQueueCounts({ ...MEASURED, deadLetteredSessions: -1 })
    ).toBeNull();
    expect(uploadQueueCounts({ ...MEASURED, sendingSessions: 50 })).toBeNull();
  });
});
