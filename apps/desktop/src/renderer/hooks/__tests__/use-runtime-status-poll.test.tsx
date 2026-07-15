import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useIngestProgress,
  useMaintenanceProgress,
} from "../use-ingest-progress";

// FEA-2264: useIngestProgress and useMaintenanceProgress subscribe to a single
// shared getRuntimeStatus poll, so a component that reads BOTH (the first-launch
// banner) makes one IPC round-trip per interval rather than one per hook.
describe("shared runtime-status poll", () => {
  let getRuntimeStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    getRuntimeStatus = vi.fn(() =>
      Promise.resolve({
        ingest: { byHarness: [], total: 0, preparing: true, complete: false },
        maintenance: { active: true, phase: "rebuild" },
      })
    );
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { getRuntimeStatus },
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("polls once per interval no matter how many hooks are active", async () => {
    const { unmount } = renderHook(() => {
      useIngestProgress(true);
      useMaintenanceProgress(true);
    });
    // Flush the immediate poll's resolution so its state update is wrapped.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // First subscriber polls immediately; the second reuses the running poll.
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(3);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    // No subscribers left, so the interval is torn down and polling stops.
    expect(getRuntimeStatus).toHaveBeenCalledTimes(3);
  });

  it("stops polling when the only active hook deactivates", async () => {
    const { rerender, unmount } = renderHook(
      ({ active }: { active: boolean }) => useIngestProgress(active),
      { initialProps: { active: true } }
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);

    rerender({ active: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(1);
    unmount();
  });
});
