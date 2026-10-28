import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useMyTasksViewStateKeys } from "../my-tasks-view-state-keys";

// ISS-9726 wiring: a sentinel namespace. `page.tsx` reads every persisted key
// from this hook and nowhere else, so an entry that stopped routing through
// `useViewStateKey` would come back as its raw base literal here.
vi.mock("@repo/app/shared/hooks/use-view-state-key", () => ({
  useViewStateKey: (baseKey: string) => `ns::${baseKey}`,
}));

describe("useMyTasksViewStateKeys (ISS-9726)", () => {
  it("namespaces every persisted My Tasks key", () => {
    const { result } = renderHook(() => useMyTasksViewStateKeys());

    // deepEqual over the whole record rather than key-by-key: a key added to
    // the type without being namespaced fails here instead of going unnoticed.
    expect(result.current).toEqual({
      columnVisibility: "ns::table:columns:my-tasks",
      columnOrder: "ns::table:column-order:my-tasks",
      search: "ns::table:search:my-tasks",
      scroll: "ns::table:scroll:my-tasks",
      sort: "ns::table:sort:my-tasks",
      filters: "ns::table:filters:my-tasks",
      expansion: "ns::my-tasks-artifacts",
    });
  });

  it("resolves one key per persisted value, with no two sharing a namespace slot", () => {
    const { result } = renderHook(() => useMyTasksViewStateKeys());

    const keys = Object.values(result.current);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
