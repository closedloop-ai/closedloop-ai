import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  FEATURE_FLAG_SETTLE_TIMEOUT_MS,
  useFeatureFlagSettleDeadline,
} from "../feature-flag-pending";

/**
 * ISS-4566 — the deadline's epoch is one WAIT, not one mount.
 *
 * The no-argument form is what the route gate and the Settings panel call, and
 * it must keep behaving exactly as it did: those callers mount and unmount with
 * the surface that is waiting.
 */

afterEach(cleanup);
afterEach(() => {
  vi.useRealTimers();
});

test("elapses once for a caller that mounts with its own wait", () => {
  vi.useFakeTimers();

  const { result } = renderHook(() => useFeatureFlagSettleDeadline());

  expect(result.current).toBe(false);
  act(() => {
    vi.advanceTimersByTime(FEATURE_FLAG_SETTLE_TIMEOUT_MS);
  });
  expect(result.current).toBe(true);
});

test("arms a fresh deadline for each wait a long-lived caller reports", () => {
  vi.useFakeTimers();

  const { result, rerender } = renderHook(
    ({ waiting }: { waiting: boolean }) =>
      useFeatureFlagSettleDeadline(waiting),
    { initialProps: { waiting: true } }
  );

  act(() => {
    vi.advanceTimersByTime(FEATURE_FLAG_SETTLE_TIMEOUT_MS);
  });
  expect(result.current).toBe(true);

  rerender({ waiting: false });
  expect(result.current).toBe(false);

  // The window a mid-session `identify()` flag reload opens. A deadline epoched
  // on the caller's mount has already expired here, so it reports elapsed on
  // this window's first render and the caller commits without waiting at all.
  rerender({ waiting: true });
  expect(result.current).toBe(false);

  act(() => {
    vi.advanceTimersByTime(FEATURE_FLAG_SETTLE_TIMEOUT_MS);
  });
  expect(result.current).toBe(true);
});
