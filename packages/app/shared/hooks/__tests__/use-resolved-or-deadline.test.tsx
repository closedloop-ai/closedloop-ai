import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useResolvedOrDeadline } from "../use-resolved-or-deadline";

const DEADLINE_MS = 3000;

afterEach(() => {
  vi.useRealTimers();
});

describe("useResolvedOrDeadline", () => {
  it("is ready immediately when the input is already resolved", () => {
    const { result } = renderHook(() =>
      useResolvedOrDeadline(true, DEADLINE_MS)
    );
    expect(result.current).toBe(true);
  });

  it("holds until the deadline, then proceeds anyway", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useResolvedOrDeadline(false, DEADLINE_MS)
    );

    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(DEADLINE_MS - 1));
    expect(result.current).toBe(false);

    // The whole point of the deadline: an upstream that never resolves must not
    // leave the caller waiting forever behind a skeleton.
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("re-closes when a resolved input goes unresolved again", () => {
    vi.useFakeTimers();
    let resolved = false;
    const { result, rerender } = renderHook(() =>
      useResolvedOrDeadline(resolved, DEADLINE_MS)
    );

    act(() => vi.advanceTimersByTime(DEADLINE_MS));
    expect(result.current).toBe(true);

    resolved = true;
    act(() => rerender());
    expect(result.current).toBe(true);

    // A latch that never cleared would keep reporting ready here purely because
    // a deadline expired during an EARLIER, unrelated stall — so a consumer
    // gating a fetch would fire against a value it is about to replace, which
    // is exactly the double read the gate exists to prevent.
    resolved = false;
    act(() => rerender());
    expect(result.current).toBe(false);
  });

  it("does not fire the deadline once the input resolves in time", () => {
    vi.useFakeTimers();
    let resolved = false;
    const { result, rerender } = renderHook(() =>
      useResolvedOrDeadline(resolved, DEADLINE_MS)
    );

    resolved = true;
    act(() => rerender());
    resolved = false;
    act(() => rerender());

    // The timer armed on the first render must have been cleared when the input
    // resolved, so the original deadline cannot fire against this new wait.
    act(() => vi.advanceTimersByTime(DEADLINE_MS - 1));
    expect(result.current).toBe(false);
  });
});
