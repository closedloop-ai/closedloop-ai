import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCoarseNow } from "../use-coarse-now";

beforeEach(() => {
  // Installed before every render: the hook seeds its state from `new Date()`
  // in a useState initializer, so a real clock there would make every
  // subsequent assertion about elapsed time drift.
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useCoarseNow", () => {
  it("seeds with the current instant and advances one interval at a time", () => {
    const { result } = renderHook(() => useCoarseNow(INTERVAL_MS));

    expect(result.current.getTime()).toBe(NOW.getTime());

    act(() => {
      vi.advanceTimersByTime(INTERVAL_MS);
    });
    expect(result.current.getTime()).toBe(NOW.getTime() + INTERVAL_MS);

    act(() => {
      vi.advanceTimersByTime(INTERVAL_MS);
    });
    expect(result.current.getTime()).toBe(NOW.getTime() + 2 * INTERVAL_MS);
  });

  it("holds the previous instant until the interval actually elapses", () => {
    const { result } = renderHook(() => useCoarseNow(INTERVAL_MS));
    const seeded = result.current;

    act(() => {
      vi.advanceTimersByTime(INTERVAL_MS - 1);
    });

    // Identity, not just value: consumers pass this straight into a useMemo
    // dependency list, so a new Date every render would defeat the memo the
    // hook exists to re-key.
    expect(result.current).toBe(seeded);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).not.toBe(seeded);
  });

  it("runs no timer and returns one stable instant when disabled", () => {
    const { result, rerender } = renderHook(() =>
      useCoarseNow(INTERVAL_MS, false)
    );
    const seeded = result.current;

    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(INTERVAL_MS * 100);
    });

    // Rerender under the advanced clock, not just advance: the promise is one
    // stable instant for the LIFETIME of the component, so a disabled hook that
    // read the clock on each render would still be wrong even with no timer.
    rerender();

    expect(result.current).toBe(seeded);
    expect(result.current.getTime()).toBe(NOW.getTime());
  });

  it.each([
    ["zero", 0],
    ["negative", -1000],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("schedules nothing for a %s interval", (_label, intervalMs) => {
    const { result } = renderHook(() => useCoarseNow(intervalMs));
    const seeded = result.current;

    // setInterval coerces each of these to a 0ms delay, so without the guard
    // the hook would re-render on every macrotask forever.
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(INTERVAL_MS * 100);
    });
    expect(result.current).toBe(seeded);
  });

  it("clears the interval on unmount", () => {
    const { unmount } = renderHook(() => useCoarseNow(INTERVAL_MS));
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-creates rather than stacks the timer when intervalMs changes", () => {
    const { result, rerender } = renderHook(
      ({ intervalMs }) => useCoarseNow(intervalMs),
      { initialProps: { intervalMs: INTERVAL_MS } }
    );

    const faster = INTERVAL_MS / 2;
    rerender({ intervalMs: faster });

    expect(vi.getTimerCount()).toBe(1);

    // A superseded 30s timer left running would fire here too, and the extra
    // setNow would be invisible in the value — both callbacks read the same
    // faked clock. The timer count above is what proves it was cleared.
    act(() => {
      vi.advanceTimersByTime(faster);
    });
    expect(result.current.getTime()).toBe(NOW.getTime() + faster);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("re-creates the timer when enabled flips on, and drops it when it flips off", () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useCoarseNow(INTERVAL_MS, enabled),
      { initialProps: { enabled: false } }
    );

    expect(vi.getTimerCount()).toBe(0);

    rerender({ enabled: true });
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(INTERVAL_MS);
    });
    expect(result.current.getTime()).toBe(NOW.getTime() + INTERVAL_MS);

    rerender({ enabled: false });
    expect(vi.getTimerCount()).toBe(0);

    const parked = result.current;
    act(() => {
      vi.advanceTimersByTime(INTERVAL_MS * 10);
    });
    rerender({ enabled: false });
    expect(result.current).toBe(parked);
  });

  /**
   * ISS-8217 review (codex P2 at :577, whitlockk at :574 — one defect, found twice):
   * enabling the hook started the interval and left `now` at the MOUNT instant,
   * so the first enabled render derived from a stale clock and stayed wrong
   * until the first tick — up to a whole `intervalMs`.
   *
   * The clock is moved across a UTC-DAY boundary rather than by minutes, and
   * that is the whole point of the fixture: the windows this hook feeds quantize
   * to UTC days, so a stale-and-fresh pair inside one day would land on the same
   * window and this case would pass against the unfixed hook.
   *
   * `setSystemTime` rather than `advanceTimersByTime`, and the timer count is
   * asserted at zero first: while disabled the hook runs no interval at all, so
   * nothing could have fired here and the value can only have moved because
   * enabling re-read the clock.
   */
  it("re-reads the clock when enabled flips on after a UTC-day rollover", () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useCoarseNow(INTERVAL_MS, enabled),
      { initialProps: { enabled: false } }
    );

    expect(result.current.getTime()).toBe(NOW.getTime());
    expect(vi.getTimerCount()).toBe(0);

    vi.setSystemTime(AFTER_ROLLOVER);
    rerender({ enabled: true });

    expect(result.current.getTime()).toBe(AFTER_ROLLOVER.getTime());
  });

  /**
   * The other half of the same contract, and the reason the re-read above is
   * keyed on the TRANSITION rather than run unconditionally: a caller that
   * mounts already enabled must not be re-rendered to be told the instant it
   * already has. Refreshing from the effect body would set a fresh `Date` on
   * every enabled mount, which is never referentially equal, so React could not
   * bail out — and the biggest consumer re-keys a whole page's filter and sort
   * on this value.
   */
  it("does not re-render an already-enabled mount to re-read the clock", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useCoarseNow(INTERVAL_MS);
    });

    expect(renders).toBe(1);
    expect(result.current.getTime()).toBe(NOW.getTime());
  });
});

const NOW = new Date("2026-08-22T12:00:00.000Z");
const INTERVAL_MS = 30_000;

/** Three UTC days past {@link NOW} — see the enable-transition case. */
const AFTER_ROLLOVER = new Date("2026-08-25T03:00:00.000Z");
