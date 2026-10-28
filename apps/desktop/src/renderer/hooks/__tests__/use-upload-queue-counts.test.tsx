import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CloudSyncProgress,
  useCloudSyncProgress,
  useUploadQueueCounts,
} from "../use-cloud-sync-progress";

// ISS-12529 AC-003: the upload queue view's counts ride the existing shared
// runtime-status poll. No second getRuntimeStatus round-trip per interval.
const CLOUD_SYNC: CloudSyncProgress = {
  identified: true,
  pendingBackfillSessions: 6,
  pendingIncrementalSessions: 1,
  sendingSessions: 3,
  backfilling: true,
  caughtUp: false,
  deadLetteredSessions: 2,
};

describe("useUploadQueueCounts", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reads the counts off the shared poll that useCloudSyncProgress uses", async () => {
    vi.useFakeTimers();
    const getRuntimeStatus = vi.fn(() =>
      Promise.resolve({ cloudSync: CLOUD_SYNC })
    );
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { getRuntimeStatus },
      writable: true,
    });

    const { result, unmount } = renderHook(() => {
      useCloudSyncProgress(true);
      return useUploadQueueCounts(true);
    });
    expect(result.current).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toEqual({ queued: 4, inFlight: 3, failed: 2 });
    // Two hooks, one poll.
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(2);
    unmount();
  });
});
