import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import {
  reviveDates,
  useViewStatePersistence,
} from "../use-view-state-persistence";

describe("useViewStatePersistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("returns defaultValue when no localStorage data exists", () => {
    const { result } = renderHook(() =>
      useViewStatePersistence("test-key", { filter: "all" })
    );

    expect(result.current[0]).toEqual({ filter: "all" });
  });

  test("restores saved state within TTL", () => {
    localStorage.setItem(
      "test-key",
      JSON.stringify({ savedAt: Date.now(), data: "saved" })
    );

    const { result } = renderHook(() =>
      useViewStatePersistence("test-key", "default")
    );

    expect(result.current[0]).toBe("saved");
  });

  test("returns defaultValue and clears expired state", () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem(
      "test-key",
      JSON.stringify({ savedAt: eightDaysAgo, data: "stale" })
    );

    const { result } = renderHook(() =>
      useViewStatePersistence("test-key", "default")
    );

    expect(result.current[0]).toBe("default");
  });

  test("validate callback transforms restored data", () => {
    localStorage.setItem(
      "test-key",
      JSON.stringify({
        savedAt: Date.now(),
        data: { status: "INVALID", count: 5 },
      })
    );

    const { result } = renderHook(() =>
      useViewStatePersistence(
        "test-key",
        { status: "active", count: 0 },
        {
          validate: (data) => ({
            ...data,
            status: data.status === "INVALID" ? "active" : data.status,
          }),
        }
      )
    );

    expect(result.current[0]).toEqual({ status: "active", count: 5 });
  });

  test("uses in-memory state when key is null", () => {
    const { result } = renderHook(() =>
      useViewStatePersistence(null, "initial")
    );

    expect(result.current[0]).toBe("initial");

    act(() => {
      result.current[1]("updated");
    });

    expect(result.current[0]).toBe("updated");
    expect(localStorage.getItem("__view-state-noop__")).toBeNull();
  });

  test("clear removes localStorage entry and returns defaultValue", () => {
    localStorage.setItem(
      "test-key",
      JSON.stringify({ savedAt: Date.now(), data: "saved" })
    );

    const { result } = renderHook(() =>
      useViewStatePersistence("test-key", "default")
    );

    expect(result.current[0]).toBe("saved");

    act(() => {
      result.current[2]();
    });

    expect(result.current[0]).toBe("default");
  });

  test("functional updater receives current value", () => {
    localStorage.setItem(
      "test-key",
      JSON.stringify({ savedAt: Date.now(), data: { count: 10 } })
    );

    const { result } = renderHook(() =>
      useViewStatePersistence("test-key", { count: 0 })
    );

    expect(result.current[0]).toEqual({ count: 10 });

    act(() => {
      result.current[1]((prev) => ({ ...prev, count: prev.count + 1 }));
    });

    expect(result.current[0]).toEqual({ count: 11 });
  });
});

describe("reviveDates", () => {
  test("converts ISO string fields to Date objects", () => {
    const input = {
      field: "CREATED_AT",
      preset: "LAST_7D",
      startDate: "2026-01-01T00:00:00.000Z",
    };

    const result = reviveDates(input, ["startDate"]);

    expect(result.startDate).toBeInstanceOf(Date);
    expect((result.startDate as unknown as Date).toISOString()).toBe(
      "2026-01-01T00:00:00.000Z"
    );
    expect(result.field).toBe("CREATED_AT");
    expect(result.preset).toBe("LAST_7D");
  });

  test("leaves non-string fields unchanged", () => {
    const input = { count: 42, name: "test" };
    const result = reviveDates(input, ["count"]);

    expect(result.count).toBe(42);
  });

  test("leaves invalid date strings unchanged", () => {
    const input = { date: "not-a-date" };
    const result = reviveDates(input, ["date"]);

    expect(result.date).toBe("not-a-date");
  });
});
