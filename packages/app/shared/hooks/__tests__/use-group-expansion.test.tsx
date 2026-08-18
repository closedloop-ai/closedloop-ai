import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useGroupExpansion } from "../use-group-expansion";

const STORAGE_KEY = "test:group-expansion";

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY);
});

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
});
