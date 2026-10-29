import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  reviveDates,
  useViewStatePersistence,
} from "../use-view-state-persistence";

describe("useViewStatePersistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  test("restores state saved exactly ttlMs ago and leaves it in storage", () => {
    const savedAt = FIXED_NOW - SHORT_TTL_MS;
    localStorage.setItem(
      "test-key",
      JSON.stringify({ savedAt, data: "saved" })
    );

    const { result } = renderHook(() =>
      useViewStatePersistence("test-key", "default", { ttlMs: SHORT_TTL_MS })
    );

    expect(result.current[0]).toBe("saved");
    expect(readEnvelope("test-key")).toEqual({ savedAt, data: "saved" });
  });

  test("returns defaultValue and clears state saved one ms past ttlMs", () => {
    const savedAt = FIXED_NOW - SHORT_TTL_MS - 1;
    localStorage.setItem(
      "test-key",
      JSON.stringify({ savedAt, data: "stale" })
    );

    const { result } = renderHook(() =>
      useViewStatePersistence("test-key", "default", { ttlMs: SHORT_TTL_MS })
    );

    expect(result.current[0]).toBe("default");
    expect(readEnvelope("test-key")).toBeNull();
  });

  // The clearing effect drives the settled value to defaultValue on its own, so
  // asserting only result.current cannot tell the read-path check apart from
  // the effect. The first render is the read path's own answer, and a stale
  // value there would reach the user as a flash before the effect wiped it.
  test("read path rejects an expired envelope on its first render", () => {
    const savedAt = FIXED_NOW - SHORT_TTL_MS - 1;
    localStorage.setItem(
      "test-key",
      JSON.stringify({ savedAt, data: "stale" })
    );

    const renders: string[] = [];
    renderHook(() => {
      const state = useViewStatePersistence("test-key", "default", {
        ttlMs: SHORT_TTL_MS,
      });
      renders.push(state[0]);
      return state;
    });

    expect(renders[0]).toBe("default");
  });

  // The seven-day figure is written out rather than imported from the hook so
  // it acts as an independent oracle: importing DEFAULT_TTL_MS would move both
  // sides of the assertion together and let a change to the default go green.
  test("default ttl restores state saved exactly seven days ago", () => {
    const savedAt = FIXED_NOW - SEVEN_DAYS_MS;
    localStorage.setItem(
      "test-key",
      JSON.stringify({ savedAt, data: "saved" })
    );

    const { result } = renderHook(() =>
      useViewStatePersistence("test-key", "default")
    );

    expect(result.current[0]).toBe("saved");
    expect(readEnvelope("test-key")).toEqual({ savedAt, data: "saved" });
  });

  test("default ttl clears state saved one ms past seven days", () => {
    const savedAt = FIXED_NOW - SEVEN_DAYS_MS - 1;
    localStorage.setItem(
      "test-key",
      JSON.stringify({ savedAt, data: "stale" })
    );

    const { result } = renderHook(() =>
      useViewStatePersistence("test-key", "default")
    );

    expect(result.current[0]).toBe("default");
    expect(readEnvelope("test-key")).toBeNull();
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

  test("clear stores a null envelope and returns defaultValue", () => {
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
    // Asserted raw rather than through readEnvelope: clear writes JSON null and
    // leaves the key in place, and only the unparsed string tells that apart
    // from removal.
    expect(localStorage.getItem("test-key")).toBe("null");
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

  // Advancing the clock after mount ages the stored envelope without producing
  // a re-render, so the clearing effect never runs and the write path is the
  // first code to see it as expired. That is the only way to reach the
  // freshness guard inside setPersistedValue with a well-formed envelope.
  test("functional updater receives persisted value at exactly ttlMs", () => {
    localStorage.setItem(
      "test-key",
      JSON.stringify({ savedAt: FIXED_NOW, data: { count: 10 } })
    );

    const { result } = renderHook(() =>
      useViewStatePersistence("test-key", { count: 0 }, { ttlMs: SHORT_TTL_MS })
    );

    vi.setSystemTime(FIXED_NOW + SHORT_TTL_MS);

    act(() => {
      result.current[1]((prev) => ({ ...prev, count: prev.count + 1 }));
    });

    expect(result.current[0]).toEqual({ count: 11 });
  });

  test("functional updater receives defaultValue one ms past ttlMs", () => {
    localStorage.setItem(
      "test-key",
      JSON.stringify({ savedAt: FIXED_NOW, data: { count: 10 } })
    );

    const { result } = renderHook(() =>
      useViewStatePersistence("test-key", { count: 0 }, { ttlMs: SHORT_TTL_MS })
    );

    vi.setSystemTime(FIXED_NOW + SHORT_TTL_MS + 1);

    act(() => {
      result.current[1]((prev) => ({ ...prev, count: prev.count + 1 }));
    });

    expect(result.current[0]).toEqual({ count: 1 });
    expect(readEnvelope("test-key")).toEqual({
      savedAt: FIXED_NOW + SHORT_TTL_MS + 1,
      data: { count: 1 },
    });
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

const FIXED_NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const SHORT_TTL_MS = 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// A cleared envelope is stored as the string "null" rather than removed, so
// parsing is what makes "cleared" and "absent" assert the same way.
function readEnvelope(key: string): unknown {
  const raw = localStorage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}
