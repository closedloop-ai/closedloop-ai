import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLoadingStall } from "../use-loading-stall";

// FEA-3639: the stall detector that keeps a blocking (no-data-yet) load from
// spinning forever. It advances none → soft → hard as the thresholds elapse and
// resets the moment the load resolves.
const THRESHOLDS = { softMs: 10_000, hardMs: 30_000 };

describe("useLoadingStall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("escalates none → soft → hard as the thresholds elapse", () => {
    const { result } = renderHook(() => useLoadingStall(true, THRESHOLDS));

    expect(result.current).toBe("none");

    act(() => {
      vi.advanceTimersByTime(THRESHOLDS.softMs);
    });
    expect(result.current).toBe("soft");

    act(() => {
      vi.advanceTimersByTime(THRESHOLDS.hardMs - THRESHOLDS.softMs);
    });
    expect(result.current).toBe("hard");
  });

  it("resets to none when the load resolves (active → false)", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useLoadingStall(active, THRESHOLDS),
      { initialProps: { active: true } }
    );

    act(() => {
      vi.advanceTimersByTime(THRESHOLDS.hardMs);
    });
    expect(result.current).toBe("hard");

    rerender({ active: false });
    expect(result.current).toBe("none");
  });

  it("restarts the budget when the reset token changes (Retry mid-stall)", () => {
    const { result, rerender } = renderHook(
      ({ token }: { token: number }) =>
        useLoadingStall(true, THRESHOLDS, token),
      { initialProps: { token: 0 } }
    );

    act(() => {
      vi.advanceTimersByTime(THRESHOLDS.hardMs);
    });
    expect(result.current).toBe("hard");

    // A retry bumps the token: `active` never went false (the read is still
    // wedged), but the detector must reset to none and re-escalate on a fresh
    // budget rather than staying latched at "hard".
    rerender({ token: 1 });
    expect(result.current).toBe("none");

    act(() => {
      vi.advanceTimersByTime(THRESHOLDS.softMs);
    });
    expect(result.current).toBe("soft");
  });

  it("stops escalating after unmount — the pending hard timer is cleared", () => {
    const { result, unmount } = renderHook(() =>
      useLoadingStall(true, THRESHOLDS)
    );

    act(() => {
      vi.advanceTimersByTime(THRESHOLDS.softMs);
    });
    expect(result.current).toBe("soft");

    unmount();
    // The hard timer must have been cleared on unmount; advancing past it must
    // not push a state update into an unmounted hook (nor escalate to "hard").
    act(() => {
      vi.advanceTimersByTime(THRESHOLDS.hardMs);
    });
    expect(result.current).toBe("soft");
  });
});
