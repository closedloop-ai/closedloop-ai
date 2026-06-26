import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useScrollRestore } from "../use-scroll-restore";

function createMockContainer(scrollTop = 0) {
  const container = document.createElement("div");
  let _scrollTop = scrollTop;
  Object.defineProperty(container, "scrollTop", {
    get: () => _scrollTop,
    set: (v: number) => {
      _scrollTop = v;
    },
    configurable: true,
  });
  Object.defineProperty(container, "scrollHeight", {
    value: 1000,
    configurable: true,
  });
  Object.defineProperty(container, "clientHeight", {
    value: 500,
    configurable: true,
  });
  return container;
}

describe("useScrollRestore", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("saves scroll position to localStorage after debounced scroll", () => {
    const container = createMockContainer();

    renderHook(() => useScrollRestore("scroll-key", container));

    Object.defineProperty(container, "scrollTop", {
      get: () => 250,
      set: () => {},
      configurable: true,
    });
    container.dispatchEvent(new Event("scroll"));

    vi.advanceTimersByTime(300);

    const stored = localStorage.getItem("scroll-key");
    expect(stored).not.toBeNull();
    const envelope = JSON.parse(stored!);
    expect(envelope.data).toBe(250);
  });

  test("restores saved scroll position on mount", () => {
    const container = createMockContainer(0);

    localStorage.setItem(
      "scroll-key",
      JSON.stringify({ savedAt: Date.now(), data: 400 })
    );

    const rafCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });

    renderHook(() => useScrollRestore("scroll-key", container));

    for (const cb of rafCallbacks) {
      cb(0);
    }

    expect(container.scrollTop).toBe(400);

    vi.mocked(globalThis.requestAnimationFrame).mockRestore();
  });

  test("does not restore expired scroll position", () => {
    const container = createMockContainer(0);

    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem(
      "scroll-key",
      JSON.stringify({ savedAt: eightDaysAgo, data: 300 })
    );

    const rafCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });

    renderHook(() => useScrollRestore("scroll-key", container));

    for (const cb of rafCallbacks) {
      cb(0);
    }

    expect(container.scrollTop).toBe(0);

    vi.mocked(globalThis.requestAnimationFrame).mockRestore();
  });

  test("clearPosition cancels pending debounce timer", () => {
    const container = createMockContainer();

    const { result } = renderHook(() =>
      useScrollRestore("scroll-key", container)
    );

    Object.defineProperty(container, "scrollTop", {
      get: () => 250,
      set: () => {},
      configurable: true,
    });
    container.dispatchEvent(new Event("scroll"));

    result.current.clearPosition();

    vi.advanceTimersByTime(300);

    const stored = localStorage.getItem("scroll-key");
    const envelope = stored ? JSON.parse(stored) : null;
    expect(envelope === null || envelope.data === 0).toBe(true);
  });

  test("saves last scroll position on unmount even if debounce timer has not fired", () => {
    const container = createMockContainer();

    const { unmount } = renderHook(() =>
      useScrollRestore("scroll-key", container)
    );

    Object.defineProperty(container, "scrollTop", {
      get: () => 250,
      set: () => {},
      configurable: true,
    });
    container.dispatchEvent(new Event("scroll"));

    unmount();

    // The cleanup saves the last position immediately, so the timer never fires
    vi.advanceTimersByTime(300);

    const stored = localStorage.getItem("scroll-key");
    expect(stored).not.toBeNull();
    const envelope = JSON.parse(stored!);
    expect(envelope.data).toBe(250);
  });

  test("cleans up requestAnimationFrame on unmount", () => {
    const container = createMockContainer(0);

    // Store a position that triggers the restore effect
    localStorage.setItem(
      "scroll-key",
      JSON.stringify({ savedAt: Date.now(), data: 400 })
    );

    const rafCalls: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      rafCalls.push(cb);
      return rafCalls.length;
    });
    const cancelSpy = vi
      .spyOn(globalThis, "cancelAnimationFrame")
      .mockImplementation(() => {});

    const { unmount } = renderHook(() =>
      useScrollRestore("scroll-key", container)
    );

    // The restore effect schedules exactly one frame on mount.
    expect(globalThis.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(rafCalls).toHaveLength(1);
    const scheduledFrameId = vi.mocked(globalThis.requestAnimationFrame).mock
      .results[0].value;

    // Unmount before any RAF fires — the cleanup must cancel the pending frame.
    unmount();

    expect(cancelSpy).toHaveBeenCalledWith(scheduledFrameId);

    vi.mocked(globalThis.requestAnimationFrame).mockRestore();
    cancelSpy.mockRestore();
  });
});
