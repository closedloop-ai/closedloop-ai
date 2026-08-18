import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
  type TranscriptSyncStatusSnapshot,
} from "../../../shared/transcript-sync-status-contract";
import {
  TRANSCRIPT_SYNC_BACKOFF_MAX_MS,
  TRANSCRIPT_SYNC_POLL_MS,
  useTranscriptSyncStatus,
} from "../use-transcript-sync-status";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

const SNAPSHOT: TranscriptSyncStatusSnapshot = {
  enabled: true,
  online: true,
  tierGate: TranscriptEgressGate.Allowed,
  storeReady: true,
  statusCounts: emptyTranscriptStatusCounts(),
};

function installDesktopApi(
  getTranscriptSyncStatus: (() => Promise<TranscriptSyncStatusSnapshot>) | null
): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: getTranscriptSyncStatus ? { getTranscriptSyncStatus } : {},
  });
}

/** Let the in-flight read resolve without advancing the clock. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

describe("useTranscriptSyncStatus (ISS-4716)", () => {
  it("starts on loading and settles on the snapshot", async () => {
    const read = vi.fn(() => Promise.resolve(SNAPSHOT));
    installDesktopApi(read);

    const { result } = renderHook(() => useTranscriptSyncStatus(true));
    expect(result.current).toEqual({ state: "loading" });

    await flush();
    expect(result.current).toEqual({ state: "ready", snapshot: SNAPSHOT });
  });

  it("makes no call at all while inactive — the flag-off path costs nothing", async () => {
    const read = vi.fn(() => Promise.resolve(SNAPSHOT));
    installDesktopApi(read);

    const { result } = renderHook(() => useTranscriptSyncStatus(false));
    await advance(TRANSCRIPT_SYNC_POLL_MS * 5);

    expect(read).not.toHaveBeenCalled();
    expect(result.current).toEqual({ state: "loading" });
  });

  it("keeps polling on the normal cadence while active", async () => {
    const read = vi.fn(() => Promise.resolve(SNAPSHOT));
    installDesktopApi(read);

    renderHook(() => useTranscriptSyncStatus(true));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    await advance(TRANSCRIPT_SYNC_POLL_MS);
    expect(read).toHaveBeenCalledTimes(2);

    await advance(TRANSCRIPT_SYNC_POLL_MS);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("stops polling and drops back to loading when it goes inactive", async () => {
    const read = vi.fn(() => Promise.resolve(SNAPSHOT));
    installDesktopApi(read);

    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useTranscriptSyncStatus(active),
      { initialProps: { active: true } }
    );
    await flush();
    const callsWhileActive = read.mock.calls.length;

    rerender({ active: false });
    await advance(TRANSCRIPT_SYNC_POLL_MS * 4);

    expect(read).toHaveBeenCalledTimes(callsWhileActive);
    // Not the last settled value: a re-shown banner must not flash a status
    // read minutes ago before the first fresh poll lands.
    expect(result.current).toEqual({ state: "loading" });
  });

  it("reads immediately when it becomes active again", async () => {
    const read = vi.fn(() => Promise.resolve(SNAPSHOT));
    installDesktopApi(read);

    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useTranscriptSyncStatus(active),
      { initialProps: { active: false } }
    );
    expect(read).not.toHaveBeenCalled();

    rerender({ active: true });
    await flush();

    // Without waiting a full period.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("clears its timer on unmount", async () => {
    const read = vi.fn(() => Promise.resolve(SNAPSHOT));
    installDesktopApi(read);

    const { unmount } = renderHook(() => useTranscriptSyncStatus(true));
    await flush();
    const callsBeforeUnmount = read.mock.calls.length;

    unmount();
    await advance(TRANSCRIPT_SYNC_POLL_MS * 4);

    expect(read).toHaveBeenCalledTimes(callsBeforeUnmount);
  });

  it("reports unavailable and stops when there is no bridge to call", async () => {
    // A bare mount (or a non-Electron host) has nothing to retry toward.
    installDesktopApi(null);

    const { result } = renderHook(() => useTranscriptSyncStatus(true));
    await flush();
    expect(result.current).toEqual({ state: "unavailable" });

    await advance(TRANSCRIPT_SYNC_BACKOFF_MAX_MS * 3);
    expect(result.current).toEqual({ state: "unavailable" });
  });

  it("reports unavailable on a rejected read but RECOVERS on a later poll", async () => {
    // The read awaits a real Prisma query, so a transient db-host failure is
    // expected. Giving up permanently would pin the footer for the whole
    // session, because the banner never unmounts to reset it.
    const read = vi
      .fn<() => Promise<TranscriptSyncStatusSnapshot>>()
      .mockRejectedValueOnce(new Error("db-host busy"))
      .mockResolvedValue(SNAPSHOT);
    installDesktopApi(read);

    const { result } = renderHook(() => useTranscriptSyncStatus(true));
    await flush();
    expect(result.current).toEqual({ state: "unavailable" });

    await advance(TRANSCRIPT_SYNC_POLL_MS);
    expect(result.current).toEqual({ state: "ready", snapshot: SNAPSHOT });
  });

  it("backs off on repeated failures and resets after a success", async () => {
    const read = vi
      .fn<() => Promise<TranscriptSyncStatusSnapshot>>()
      .mockRejectedValue(new Error("db-host busy"));
    installDesktopApi(read);

    renderHook(() => useTranscriptSyncStatus(true));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    // 1st failure schedules the base delay; nothing fires early.
    await advance(TRANSCRIPT_SYNC_POLL_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(read).toHaveBeenCalledTimes(2);

    // 2nd failure doubles it — the base delay alone is no longer enough.
    await advance(TRANSCRIPT_SYNC_POLL_MS);
    expect(read).toHaveBeenCalledTimes(2);
    await advance(TRANSCRIPT_SYNC_POLL_MS);
    expect(read).toHaveBeenCalledTimes(3);

    // A success returns the ladder to the base cadence.
    read.mockResolvedValue(SNAPSHOT);
    await advance(TRANSCRIPT_SYNC_POLL_MS * 4);
    const afterRecovery = read.mock.calls.length;
    await advance(TRANSCRIPT_SYNC_POLL_MS);
    expect(read).toHaveBeenCalledTimes(afterRecovery + 1);
  });

  it("never overlaps reads when one outlives the poll period", async () => {
    let release: ((snapshot: TranscriptSyncStatusSnapshot) => void) | undefined;
    const read = vi.fn(
      () =>
        new Promise<TranscriptSyncStatusSnapshot>((resolve) => {
          release = resolve;
        })
    );
    installDesktopApi(read);

    renderHook(() => useTranscriptSyncStatus(true));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);

    // Well past several poll periods, with the first read still in flight.
    await advance(TRANSCRIPT_SYNC_POLL_MS * 5);
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.(SNAPSHOT);
      // Let the resolution propagate through the hook's own continuation.
      await Promise.resolve();
    });
    await advance(TRANSCRIPT_SYNC_POLL_MS);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("drops a read that resolves after it goes inactive", async () => {
    let release: ((snapshot: TranscriptSyncStatusSnapshot) => void) | undefined;
    const read = vi.fn(
      () =>
        new Promise<TranscriptSyncStatusSnapshot>((resolve) => {
          release = resolve;
        })
    );
    installDesktopApi(read);

    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useTranscriptSyncStatus(active),
      { initialProps: { active: true } }
    );
    await flush();

    rerender({ active: false });
    await act(async () => {
      release?.(SNAPSHOT);
      // Let the resolution propagate through the hook's own continuation.
      await Promise.resolve();
    });

    expect(result.current).toEqual({ state: "loading" });
  });
});
