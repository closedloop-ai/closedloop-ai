import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useLocalStorageState } from "../use-local-storage-state";

describe("useLocalStorageState", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("boolean values", () => {
    test("returns default value when nothing stored", () => {
      const { result } = renderHook(() =>
        useLocalStorageState("test-key", false)
      );
      expect(result.current[0]).toBe(false);
    });

    test("returns stored value over default", () => {
      localStorage.setItem("test-key", "true");
      const { result } = renderHook(() =>
        useLocalStorageState("test-key", false)
      );
      expect(result.current[0]).toBe(true);
    });

    test("persists value to localStorage on set", () => {
      const { result } = renderHook(() =>
        useLocalStorageState("test-key", false)
      );

      act(() => {
        result.current[1](true);
      });

      expect(result.current[0]).toBe(true);
      expect(localStorage.getItem("test-key")).toBe("true");
    });

    test("supports functional updater", () => {
      const { result } = renderHook(() =>
        useLocalStorageState("test-key", false)
      );

      act(() => {
        result.current[1]((prev) => !prev);
      });

      expect(result.current[0]).toBe(true);

      act(() => {
        result.current[1]((prev) => !prev);
      });

      expect(result.current[0]).toBe(false);
    });
  });

  describe("string values", () => {
    test("stores and retrieves strings", () => {
      const { result } = renderHook(() =>
        useLocalStorageState("theme", "light")
      );
      expect(result.current[0]).toBe("light");

      act(() => {
        result.current[1]("dark");
      });

      expect(result.current[0]).toBe("dark");
      expect(JSON.parse(localStorage.getItem("theme")!)).toBe("dark");
    });
  });

  describe("object values", () => {
    test("stores and retrieves objects", () => {
      const defaultVal = { x: 0, y: 0 };
      const { result } = renderHook(() =>
        useLocalStorageState("position", defaultVal)
      );
      expect(result.current[0]).toEqual({ x: 0, y: 0 });

      act(() => {
        result.current[1]({ x: 100, y: 200 });
      });

      expect(result.current[0]).toEqual({ x: 100, y: 200 });
    });
  });

  describe("error handling", () => {
    test("returns default when stored value is invalid JSON", () => {
      localStorage.setItem("broken", "not-valid-json");
      const { result } = renderHook(() => useLocalStorageState("broken", 42));
      expect(result.current[0]).toBe(42);
    });
  });

  describe("cross-instance sync", () => {
    test("updates when storage event fires for same key", () => {
      const { result } = renderHook(() =>
        useLocalStorageState("sync-key", "a")
      );
      expect(result.current[0]).toBe("a");

      act(() => {
        localStorage.setItem("sync-key", JSON.stringify("b"));
        globalThis.dispatchEvent(
          new StorageEvent("storage", { key: "sync-key" })
        );
      });

      expect(result.current[0]).toBe("b");
    });

    test("ignores storage events for different keys", () => {
      const { result } = renderHook(() =>
        useLocalStorageState("my-key", "original")
      );

      act(() => {
        localStorage.setItem("other-key", JSON.stringify("changed"));
        globalThis.dispatchEvent(
          new StorageEvent("storage", { key: "other-key" })
        );
      });

      expect(result.current[0]).toBe("original");
    });

    // ISS-9568 (marisolashgrove review): extracting the listener into
    // `subscribeToStorageKey` WIDENED this hook — the shared helper forwards a
    // `key: null` event (`localStorage.clear()` in another document, which took
    // this key with it) where the old inline handler dropped it. That is the
    // behavior we want, so it is pinned here rather than left as an unstated
    // side effect of the extraction. Without the forward this reads "stored".
    test("re-reads on a null-key storage event (localStorage.clear() elsewhere)", () => {
      const { result } = renderHook(() =>
        useLocalStorageState("cleared-key", "fallback")
      );

      act(() => {
        localStorage.setItem("cleared-key", JSON.stringify("stored"));
        globalThis.dispatchEvent(
          new StorageEvent("storage", { key: "cleared-key" })
        );
      });
      expect(result.current[0]).toBe("stored");

      act(() => {
        localStorage.clear();
        globalThis.dispatchEvent(new StorageEvent("storage", { key: null }));
      });

      expect(result.current[0]).toBe("fallback");
    });
  });
});

/**
 * ISS-8533: the optional `validate` coercer.
 *
 * Cases below are labelled by what they can actually prove. NEW exercises the new
 * parameter and therefore cannot run against unfixed `main` at all — honest coverage
 * of new surface, never evidence a defect existed. PIN runs and passes on `main` and
 * guards a wrong fix. The defect reproductions themselves live at the CONSUMERS
 * (`use-group-expansion.test.tsx`, `use-agents-nav-activity.test.tsx`), because that
 * is where an unvalidated value actually throws or miscounts.
 */
describe("useLocalStorageState — validate (ISS-8533)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const toStringOrFallback = (value: unknown, fallback: string) =>
    typeof value === "string" ? value : fallback;

  test("NEW: coerces a stored value of the wrong shape to the fallback", () => {
    localStorage.setItem("v-key", "5");
    const { result } = renderHook(() =>
      useLocalStorageState("v-key", "default", toStringOrFallback)
    );
    expect(result.current[0]).toBe("default");
  });

  test("NEW: passes a valid stored value through untouched", () => {
    localStorage.setItem("v-key", JSON.stringify("stored"));
    const { result } = renderHook(() =>
      useLocalStorageState("v-key", "default", toStringOrFallback)
    );
    expect(result.current[0]).toBe("stored");
  });

  test("NEW(cf): is NOT called when the key is absent", () => {
    // Kills a fix that runs the validator over `defaultValue` — which would let a
    // validator reject the caller's own default.
    const validate = vi.fn(toStringOrFallback);
    const { result } = renderHook(() =>
      useLocalStorageState("v-key", "default", validate)
    );
    expect(result.current[0]).toBe("default");
    expect(validate).not.toHaveBeenCalled();
  });

  test("NEW(cf): is NOT called when JSON.parse throws", () => {
    // Kills a fix that moves the validator inside the parse catch.
    localStorage.setItem("v-key", "{not json");
    const validate = vi.fn(toStringOrFallback);
    const { result } = renderHook(() =>
      useLocalStorageState("v-key", "default", validate)
    );
    expect(result.current[0]).toBe("default");
    expect(validate).not.toHaveBeenCalled();
  });

  test("NEW: receives the CALLER'S CURRENT default as its second argument", () => {
    // The two-argument shape exists so three boolean sites with different defaults
    // can share one coercer instead of restating each default inside it.
    localStorage.setItem("v-key", "5");
    const validate = vi.fn(toStringOrFallback);
    renderHook(() => useLocalStorageState("v-key", "mine", validate));
    expect(validate).toHaveBeenCalledWith(5, "mine");
  });

  test("NEW: validates the functional updater's `prev`, not the raw parsed value", () => {
    localStorage.setItem("v-key", "5");
    const { result } = renderHook(() =>
      useLocalStorageState("v-key", "default", toStringOrFallback)
    );

    let seenPrev: unknown;
    act(() => {
      result.current[1]((prev) => {
        seenPrev = prev;
        return `${prev}!`;
      });
    });

    expect(seenPrev).toBe("default");
    expect(result.current[0]).toBe("default!");
  });

  test("NEW: a throwing validator propagates from the RENDER path", () => {
    localStorage.setItem("v-key", "5");
    const throwing = () => {
      throw new Error("validator bug");
    };
    expect(() =>
      renderHook(() => useLocalStorageState("v-key", "default", throwing))
    ).toThrow("validator bug");
  });

  test("NEW: a throwing validator propagates from the WRITE path and persists nothing", () => {
    // The half a read-path-only fix misses: setValue's catch used to wrap the whole
    // deserialize call, so a validator throw became the default AND was then written
    // to storage under the user's key.
    localStorage.setItem("v-key", JSON.stringify("stored"));
    let shouldThrow = false;
    const validate = (value: unknown, fallback: string) => {
      if (shouldThrow) {
        throw new Error("validator bug");
      }
      return toStringOrFallback(value, fallback);
    };
    const { result } = renderHook(() =>
      useLocalStorageState("v-key", "default", validate)
    );

    shouldThrow = true;
    expect(() => result.current[1]((prev) => `${prev}!`)).toThrow(
      "validator bug"
    );
    expect(localStorage.getItem("v-key")).toBe(JSON.stringify("stored"));
  });

  test("NEW: a write round-trips by CONTENT through re-validation", () => {
    // setValue dispatches a StorageEvent, so the next snapshot re-parses AND
    // re-validates what was just written. A normalizing validator (trim, sort,
    // dedupe) would make the rendered value differ from the value written.
    const { result } = renderHook(() =>
      useLocalStorageState("v-key", "default", toStringOrFallback)
    );
    act(() => {
      result.current[1]("  padded  ");
    });
    expect(result.current[0]).toBe("  padded  ");
  });

  test("NEW: keeps a stable reference across rerenders for a coerced value", () => {
    localStorage.setItem("v-key", JSON.stringify(["a", "b"]));
    const { result, rerender } = renderHook(() =>
      useLocalStorageState<string[]>("v-key", [], (value, fallback) =>
        Array.isArray(value)
          ? value.filter((m): m is string => typeof m === "string")
          : fallback
      )
    );
    const first = result.current[0];
    rerender();
    // An allocating validator still yields ONE reference per raw string, which is
    // what useSyncExternalStore requires of getSnapshot.
    expect(result.current[0]).toBe(first);
  });

  test("PIN(cf): omitting validate leaves the unvalidated passthrough exactly as it was", () => {
    // The guarantee the five already-coerced call sites rest on: they pass no
    // validator, so they must still receive the raw parsed value.
    localStorage.setItem("v-key", "5");
    const { result } = renderHook(() =>
      useLocalStorageState<unknown>("v-key", "default")
    );
    expect(result.current[0]).toBe(5);
  });

  test("PIN(cf): the parse-error path still caches the default, unchanged", () => {
    localStorage.setItem("v-key", "{not json");
    const { result } = renderHook(() =>
      useLocalStorageState<unknown>("v-key", "default")
    );
    expect(result.current[0]).toBe("default");
  });
});
