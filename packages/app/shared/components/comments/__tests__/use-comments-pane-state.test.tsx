import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommentsPaneOpenKey,
  CommentsPaneWidthKey,
  commentsPaneWidthOrFallback,
  useCommentsPaneVisibility,
  useCommentsPaneWidth,
  useEndCommentsPaneTransient,
} from "../use-comments-pane-state";

const SESSION = CommentsPaneOpenKey.Session;

/** A pane's view of the state, ending its transient on unmount as the panes do. */
function usePane(key: CommentsPaneOpenKey, identity: string | null = "a") {
  useEndCommentsPaneTransient(key, identity);
  return useCommentsPaneVisibility(key);
}

afterEach(() => {
  globalThis.localStorage.clear();
  renderHook(() => {
    useEndCommentsPaneTransient(SESSION, null);
  }).unmount();
});

describe("commentsPaneWidthOrFallback", () => {
  it.each([
    [279, 280],
    [561, 560],
    [400, 400],
  ])("clamps %s to %s", (stored, expected) => {
    expect(commentsPaneWidthOrFallback(stored, 360)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, "400", "", null, {}, -5])(
    "falls back for %s",
    (stored) => {
      expect(commentsPaneWidthOrFallback(stored, 360)).toBe(360);
    }
  );
});

describe("useCommentsPaneVisibility", () => {
  it("writes the saved value on a user action and never on a transient one", () => {
    const { result } = renderHook(() => usePane(SESSION));
    expect(result.current.open).toBe(true);

    act(() => result.current.setOpen(false));
    expect(result.current.open).toBe(false);
    expect(globalThis.localStorage.getItem(SESSION)).toBe("false");

    act(() => result.current.showTransiently());
    expect(result.current.open).toBe(true);
    act(() => result.current.hideTransiently());
    expect(result.current.open).toBe(false);
    act(() => result.current.showTransiently());
    expect(globalThis.localStorage.getItem(SESSION)).toBe("false");
  });

  describe("when localStorage refuses the save", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("still hides the pane the reader hid", () => {
      const { result } = renderHook(() => usePane(SESSION));
      expect(result.current.open).toBe(true);
      vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

      act(() => result.current.setOpen(false));

      expect(result.current.open).toBe(false);
      expect(globalThis.localStorage.getItem(SESSION)).toBeNull();
    });
  });

  it("ends a transient reveal when the entity changes", () => {
    globalThis.localStorage.setItem(SESSION, "false");
    const { rerender, result } = renderHook(
      ({ identity }) => usePane(SESSION, identity),
      { initialProps: { identity: "a" } }
    );
    act(() => result.current.showTransiently());
    expect(result.current.open).toBe(true);

    rerender({ identity: "b" });
    expect(result.current.open).toBe(false);
  });
});

describe("useCommentsPaneWidth", () => {
  it("keeps a drag live and persists the clamped width on commit", () => {
    const key = CommentsPaneWidthKey.Session;
    const { result } = renderHook(() => useCommentsPaneWidth(key, 360));

    act(() => result.current.setLiveWidth(420));
    expect(result.current.width).toBe(420);
    expect(globalThis.localStorage.getItem(key)).toBeNull();

    act(() => result.current.commitWidth(900));
    expect(result.current.width).toBe(560);
    expect(globalThis.localStorage.getItem(key)).toBe("560");
  });
});
