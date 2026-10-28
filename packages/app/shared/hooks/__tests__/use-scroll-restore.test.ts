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
    // Each case that spies on requestAnimationFrame restores it on its last
    // line, which a FAILING assertion skips — leaking the spy into the next
    // case and reporting a second, invented failure that hides the real one.
    vi.restoreAllMocks();
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

  test("restores into a replacement container after the first one is unmounted", () => {
    // The Documents index swaps its scroll container out for a no-results empty
    // state and back when the search is cleared (davetho review, cid
    // 3955792554). The hook itself never unmounts across that, so a
    // restore-once-ever flag would spend its single restore on the FIRST
    // container and leave the reader at the top of the list on their way back.
    localStorage.setItem(
      "scroll-key",
      JSON.stringify({ savedAt: Date.now(), data: 400 })
    );

    const rafCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });

    const first = createMockContainer(0);
    const { rerender } = renderHook(
      ({ container }: { container: HTMLElement | null }) =>
        useScrollRestore("scroll-key", container),
      { initialProps: { container: first as HTMLElement | null } }
    );
    for (const cb of rafCallbacks.splice(0)) {
      cb(0);
    }
    expect(first.scrollTop).toBe(400);

    // The empty state renders: the container is gone entirely for a while.
    rerender({ container: null });

    // Search cleared — the table, and a BRAND NEW container element, are back.
    const replacement = createMockContainer(0);
    rerender({ container: replacement });
    for (const cb of rafCallbacks.splice(0)) {
      cb(0);
    }

    expect(replacement.scrollTop).toBe(400);

    vi.mocked(globalThis.requestAnimationFrame).mockRestore();
  });

  test("re-arms the restore when the key changes under a container that never unmounts", () => {
    // ISS-9726 (codex 3966394770). The container is only half the identity of a
    // restore. The KEY moves under a mounted container on two real paths: the
    // org-scoped flag resolving lifts a surface off its held `null` onto the
    // real key, and switching organizations renames every namespaced key. Armed
    // on the element alone, the one allowed restore was already spent by the
    // previous key and the new key's stored offset was never applied — the
    // reader stayed wherever the OLD organization's offset had put them.
    const container = createMockContainer(0);
    localStorage.setItem(
      "scroll-key-org-a",
      JSON.stringify({ savedAt: Date.now(), data: 400 })
    );
    localStorage.setItem(
      "scroll-key-org-b",
      JSON.stringify({ savedAt: Date.now(), data: 120 })
    );

    const rafCallbacks: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });

    const { rerender } = renderHook(
      ({ key }: { key: string }) => useScrollRestore(key, container),
      { initialProps: { key: "scroll-key-org-a" } }
    );
    for (const cb of rafCallbacks.splice(0)) {
      cb(0);
    }
    expect(container.scrollTop).toBe(400);

    // Same element throughout — only the key moves.
    rerender({ key: "scroll-key-org-b" });
    for (const cb of rafCallbacks.splice(0)) {
      cb(0);
    }

    expect(container.scrollTop).toBe(120);

    vi.mocked(globalThis.requestAnimationFrame).mockRestore();
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
