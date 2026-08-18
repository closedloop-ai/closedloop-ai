import { useSettledValue } from "@repo/design-system/hooks/use-settled-value";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-4906: the damping behind `GridTable`'s `foldFitSettleMs`.
 *
 * The fold fit widens the leading track by the container's leftover, and that
 * leftover resets the instant the next column starts to fit — so re-fitting on
 * every measured width walks every column after the lead sideways at each
 * threshold a resize drag crosses. Holding the width still through the drag and
 * re-fitting once it stops removes the sawtooth without giving up the
 * whole-column guarantee AT REST.
 *
 * Lives in `@repo/app` because `packages/design-system` has no test runner — the
 * same arrangement as `column-fold.test.ts` beside it.
 *
 * Time is pinned with fake timers rather than waited on: the contract is about
 * exact settle boundaries, and a real-clock assertion here would be flaky.
 */

const SETTLE_MS = 150;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSettledValue (ISS-4906)", () => {
  it("returns the value verbatim when damping is off, so an un-opted-in caller is unchanged", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useSettledValue(value, 0),
      { initialProps: { value: 1000 } }
    );

    rerender({ value: 1180 });
    expect(result.current).toBe(1180);
    rerender({ value: 1240 });
    expect(result.current).toBe(1240);
  });

  it("applies the FIRST change immediately, so the first real measurement paints without a delay", () => {
    // `useContainerWidth` starts at a wide pre-measure default and reports the
    // real width once observed. Waiting out the settle for that transition would
    // paint the unfitted template and then visibly snap.
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

    // A drag: each frame arrives before the window elapses, so none is applied.
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

    // The intermediate 1180 is never observed — only the value the drag ended on.
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
      vi.advanceTimersByTime(10);
    });
    // The 1180 timer would have fired here if it had not been cleared.
    expect(result.current).toBe(1108);

    act(() => {
      vi.advanceTimersByTime(SETTLE_MS);
    });
    expect(result.current).toBe(1260);
  });

  it("re-seeds from the CURRENT value when damping turns on mid-life", () => {
    // The web gate is a PostHog flag that resolves AFTER mount, so damping flips
    // on while the value has already moved. Switching to a value captured at
    // mount would paint one frame of visibly wrong column geometry.
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

    // Arming mid-resize must not consume the leading edge on the next frame.
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
    unmount();

    // A surviving timer would call `setSettled` on an unmounted hook.
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(SETTLE_MS * 2);
      })
    ).not.toThrow();
    expect(result.current).toBe(1108);
  });
});
