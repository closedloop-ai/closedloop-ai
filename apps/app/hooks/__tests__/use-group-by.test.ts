import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { GroupByMode } from "@/lib/group-by";
import { useGroupBy } from "../use-group-by";

describe("useGroupBy", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("defaults to 'none' when nothing is stored", () => {
    const { result } = renderHook(() => useGroupBy("test:group-by"));
    expect(result.current.groupBy).toBe(GroupByMode.None);
  });

  test("returns the stored valid mode", () => {
    localStorage.setItem("test:group-by", JSON.stringify(GroupByMode.Priority));
    const { result } = renderHook(() => useGroupBy("test:group-by"));
    expect(result.current.groupBy).toBe(GroupByMode.Priority);
  });

  test("migrates legacy 'true' (group-by-status) to Status mode", () => {
    localStorage.setItem("test:group-by", "true");
    const { result } = renderHook(() => useGroupBy("test:group-by"));
    expect(result.current.groupBy).toBe(GroupByMode.Status);
  });

  test("migrates legacy 'false' to None mode", () => {
    localStorage.setItem("test:group-by", "false");
    const { result } = renderHook(() => useGroupBy("test:group-by"));
    expect(result.current.groupBy).toBe(GroupByMode.None);
  });

  test("falls back to None for unrecognized stored values", () => {
    localStorage.setItem("test:group-by", JSON.stringify("bogus"));
    const { result } = renderHook(() => useGroupBy("test:group-by"));
    expect(result.current.groupBy).toBe(GroupByMode.None);
  });

  test("persists the selected mode to localStorage", () => {
    const { result } = renderHook(() => useGroupBy("test:group-by"));

    act(() => {
      result.current.setGroupBy(GroupByMode.Assignee);
    });

    expect(result.current.groupBy).toBe(GroupByMode.Assignee);
    expect(localStorage.getItem("test:group-by")).toBe(
      JSON.stringify(GroupByMode.Assignee)
    );
  });
});
