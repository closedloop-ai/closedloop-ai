import { useSettledValue } from "@closedloop-ai/design-system/hooks/use-settled-value";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SETTLE_MS = 150;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSettledValue", () => {
  it("returns the value verbatim when settleMs is 0, so an un-opted-in caller is unchanged", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useSettledValue(value, 0),
      { initialProps: { value: 1000 } }
    );

    expect(result.current).toBe(1000);
    rerender({ value: 1180 });
    expect(result.current).toBe(1180);
    rerender({ value: 1240 });
    expect(result.current).toBe(1240);
  });

  it("returns the value verbatim when settleMs is negative", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useSettledValue(value, -1),
      { initialProps: { value: 1000 } }
    );

    rerender({ value: 1180 });
    expect(result.current).toBe(1180);
  });

  it("applies the FIRST change immediately, so the first real measurement paints without a delay", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useSettledValue(value, SETTLE_MS),
      { initialProps: { value: 1024 } }
    );

    rerender({ value: 1108 });
    expect(result.current).toBe(1108);
  });

  it("holds the last settled value through a continuous run of changes", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useSettledValue(value, SETTLE_MS),
      { initialProps: { value: 1024 } }
    );
    rerender({ value: 1108 }); // leading edge — applied
    expect(result.current).toBe(1108);

    for (const width of [1140, 1180, 1220, 1260]) {
      rerender({ value: width });
      act(() => {
        vi.advanceTimersByTime(SETTLE_MS - 1);
      });
      expect(result.current).toBe(1108);
    }
  });

  it("applies the newest value once the changes stop", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useSettledValue(value, SETTLE_MS),
      { initialProps: { value: 1024 } }
    );
    rerender({ value: 1108 });
    rerender({ value: 1180 });
    rerender({ value: 1260 });

    act(() => {
      vi.advanceTimersByTime(SETTLE_MS);
    });

    // The intermediate 1180 is never observed — only the value the run ended on.
    expect(result.current).toBe(1260);
  });

  it("cancels a superseded pending apply rather than emitting it late", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useSettledValue(value, SETTLE_MS),
      { initialProps: { value: 1024 } }
    );
    rerender({ value: 1108 });

    rerender({ value: 1180 });
    act(() => {
      vi.advanceTimersByTime(SETTLE_MS - 10);
    });
    rerender({ value: 1260 });
    act(() => {
      // The 1180 timer would have fired here if it had not been cleared.
      vi.advanceTimersByTime(10);
    });
    expect(result.current).toBe(1108);

    act(() => {
      vi.advanceTimersByTime(SETTLE_MS);
    });
    expect(result.current).toBe(1260);
  });

  it("does not apply a change when the value is unchanged (Object.is short-circuit)", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useSettledValue(value, SETTLE_MS),
      { initialProps: { value: 1024 } }
    );
    rerender({ value: 1108 });
    expect(result.current).toBe(1108);

    rerender({ value: 1108 });
    act(() => {
      vi.advanceTimersByTime(SETTLE_MS);
    });
    expect(result.current).toBe(1108);
  });

  it("re-seeds from the CURRENT value when damping turns on mid-life", () => {
    const { result, rerender } = renderHook(
      ({ value, settleMs }) => useSettledValue(value, settleMs),
      { initialProps: { settleMs: 0, value: 1024 } }
    );
    rerender({ settleMs: 0, value: 1108 });
    expect(result.current).toBe(1108);

    rerender({ settleMs: SETTLE_MS, value: 1108 });

    // Not 1024, the mount-time value the state still held.
    expect(result.current).toBe(1108);
  });

  it("damps the first change after turning on, rather than letting one more through", () => {
    const { result, rerender } = renderHook(
      ({ value, settleMs }) => useSettledValue(value, settleMs),
      { initialProps: { settleMs: 0, value: 1108 } }
    );
    rerender({ settleMs: SETTLE_MS, value: 1108 });

    rerender({ settleMs: SETTLE_MS, value: 1260 });
    act(() => {
      vi.advanceTimersByTime(SETTLE_MS - 1);
    });
    expect(result.current).toBe(1108);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(1260);
  });

  it("does not apply a pending value after unmount", () => {
    const { result, rerender, unmount } = renderHook(
      ({ value }) => useSettledValue(value, SETTLE_MS),
      { initialProps: { value: 1024 } }
    );
    rerender({ value: 1108 });
    rerender({ value: 1260 });
    // The trailing timer is armed by the second rerender above.
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    // Assert the timer is GONE, not that advancing it fails to throw:
    // advancing a live timer whose hook has unmounted throws nothing either, so
    // the negative form stayed green with `clearTimeout` deleted. Same shape as
    // the useCopyToClipboard cleanup case in `shared-primitives.test.tsx`.
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current).toBe(1108);
  });

  it("returns the newest value immediately when settleMs drops back to 0 mid-wait, bypassing the pending debounce", () => {
    const { result, rerender } = renderHook(
      ({ value, settleMs }) => useSettledValue(value, settleMs),
      { initialProps: { settleMs: SETTLE_MS, value: 1024 } }
    );
    rerender({ settleMs: SETTLE_MS, value: 1108 }); // leading edge — applied
    rerender({ settleMs: SETTLE_MS, value: 1180 }); // queued, not yet applied

    rerender({ settleMs: 0, value: 1260 });

    expect(result.current).toBe(1260);
  });
});
