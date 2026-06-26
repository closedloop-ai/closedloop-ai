import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
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
  });
});
