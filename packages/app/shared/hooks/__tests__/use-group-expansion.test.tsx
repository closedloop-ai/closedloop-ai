import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  GROUP_EXPANSION_STORAGE_LIMIT,
  useGroupExpansion,
} from "../use-group-expansion";

const STORAGE_KEY = "test:group-expansion";

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY);
});

/**
 * Seeds are the EXACT bytes localStorage holds, because that is what `JSON.parse`
 * receives — `5` is the number five, not the string "5".
 *
 * RED cases fail against unfixed `main`: `new Set(5)` and `new Set({a:1})` throw
 * `TypeError: ... is not iterable` DURING RENDER, so the grouped table hits the error
 * boundary and blanks until the user clears site data. PIN cases already pass and
 * guard against a fix that is wrong in the other direction.
 */
describe("useGroupExpansion", () => {
  it("keeps expansion callbacks stable when no preference is persisted", () => {
    const { result, rerender } = renderHook(() =>
      useGroupExpansion(STORAGE_KEY)
    );
    const initialIsExpanded = result.current.isExpanded;

    expect(initialIsExpanded("group-1")).toBe(false);

    rerender();

    expect(result.current.isExpanded).toBe(initialIsExpanded);
  });

  it("RED: a stored number renders as nothing-expanded instead of throwing", () => {
    localStorage.setItem(STORAGE_KEY, "5");

    const { result } = renderHook(() => useGroupExpansion(STORAGE_KEY));

    expect(result.current.isExpanded("group-1")).toBe(false);
  });

  it("RED: a stored object renders as nothing-expanded instead of throwing", () => {
    localStorage.setItem(STORAGE_KEY, '{"a":1}');

    const { result } = renderHook(() => useGroupExpansion(STORAGE_KEY));

    expect(result.current.isExpanded("group-1")).toBe(false);
  });

  it("PIN: a stored null still renders as nothing-expanded", () => {
    // `new Set(null)` is a legal empty Set and never threw, so this case is green
    // today. It guards a coercion that breaks the one malformed value that worked.
    localStorage.setItem(STORAGE_KEY, "null");

    const { result } = renderHook(() => useGroupExpansion(STORAGE_KEY));

    expect(result.current.isExpanded("group-1")).toBe(false);
  });

  it("PIN(cf): a stored array of numbers expands nothing", () => {
    // Already false today, because `new Set([1,2]).has("1")` is a strict-equality
    // miss. The mutation it kills is a coercion that STRINGIFIES members, which
    // would resurrect a key the user never toggled.
    localStorage.setItem(STORAGE_KEY, "[1,2]");

    const { result } = renderHook(() => useGroupExpansion(STORAGE_KEY));

    expect(result.current.isExpanded("1")).toBe(false);
  });

  it("PIN: a valid stored array keeps exactly the toggled keys", () => {
    // The constraint the whole ticket is bounded by: a VALID stored value must
    // behave identically. Kills a coercion that throws valid state away.
    localStorage.setItem(STORAGE_KEY, '["a","b"]');

    const { result } = renderHook(() => useGroupExpansion(STORAGE_KEY));

    expect(result.current.isExpanded("a")).toBe(true);
    expect(result.current.isExpanded("b")).toBe(true);
    expect(result.current.isExpanded("c")).toBe(false);
  });

  it("prunes toggled keys that disappeared from the authoritative scope", () => {
    localStorage.setItem(STORAGE_KEY, '["kept","removed"]');
    const { result } = renderHook(() => useGroupExpansion(STORAGE_KEY));

    act(() => {
      result.current.pruneGroups(new Set(["kept"]));
    });

    expect(result.current.isExpanded("kept")).toBe(true);
    expect(result.current.isExpanded("removed")).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(
      '{"toggledKeys":["kept"],"version":1}'
    );
  });

  it("RED: defaultExpanded inverts a malformed value to everything-expanded", () => {
    // The hook's two modes read the SAME set with opposite meaning, so a fix that
    // returns the wrong empty value is only visible in this arm.
    localStorage.setItem(STORAGE_KEY, "5");

    const { result } = renderHook(() =>
      useGroupExpansion(STORAGE_KEY, { defaultExpanded: true })
    );

    expect(result.current.isExpanded("group-1")).toBe(true);
  });

  it("PIN: defaultExpanded inverts a valid value correctly", () => {
    localStorage.setItem(STORAGE_KEY, '["a"]');

    const { result } = renderHook(() =>
      useGroupExpansion(STORAGE_KEY, { defaultExpanded: true })
    );

    expect(result.current.isExpanded("a")).toBe(false);
    expect(result.current.isExpanded("b")).toBe(true);
  });

  it("RED: toggling from a malformed stored value writes a clean array", () => {
    // Setup order is load-bearing. Seeding `5` before the first render makes that
    // render throw, so `toggleGroup` is never reachable — the write path has to be
    // entered from a mounted hook whose key is overwritten underneath it. That path
    // is a SECOND `new Set(prev)` over the same unvalidated value.
    const { result } = renderHook(() => useGroupExpansion(STORAGE_KEY));
    localStorage.setItem(STORAGE_KEY, "5");

    act(() => {
      result.current.toggleGroup("group-1");
    });

    expect(localStorage.getItem(STORAGE_KEY)).toBe(
      '{"toggledKeys":["group-1"],"version":1}'
    );
    expect(result.current.isExpanded("group-1")).toBe(true);
  });

  it("accepts the versioned payload and falls back from corrupt versions", () => {
    localStorage.setItem(STORAGE_KEY, '{"toggledKeys":["kept"],"version":1}');
    const { result, rerender } = renderHook(() =>
      useGroupExpansion(STORAGE_KEY)
    );
    expect(result.current.isExpanded("kept")).toBe(true);

    localStorage.setItem(
      STORAGE_KEY,
      '{"toggledKeys":["corrupt"],"version":99}'
    );
    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY })
      );
    });
    rerender();
    expect(result.current.isExpanded("corrupt")).toBe(false);
  });

  it("caps legacy growth deterministically on the next write", () => {
    const legacy = Array.from(
      { length: GROUP_EXPANSION_STORAGE_LIMIT + 2 },
      (_, index) => `key-${index}`
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));
    const { result } = renderHook(() => useGroupExpansion(STORAGE_KEY));

    act(() => result.current.toggleGroup("new-key"));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as {
      toggledKeys: string[];
      version: number;
    };
    expect(stored.version).toBe(1);
    expect(stored.toggledKeys).toHaveLength(GROUP_EXPANSION_STORAGE_LIMIT);
    expect(stored.toggledKeys.at(-1)).toBe("new-key");
    expect(stored.toggledKeys).not.toContain("key-0");
  });

  it("restores expansion after the owning page unmounts and remounts", () => {
    const first = renderHook(() => useGroupExpansion(STORAGE_KEY));
    act(() => first.result.current.toggleGroup("persisted"));
    first.unmount();

    const second = renderHook(() => useGroupExpansion(STORAGE_KEY));

    expect(second.result.current.isExpanded("persisted")).toBe(true);
  });
});
