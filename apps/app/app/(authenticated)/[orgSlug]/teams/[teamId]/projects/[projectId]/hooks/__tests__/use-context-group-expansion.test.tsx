import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useContextGroupExpansion } from "../use-context-group-expansion";

function setup(contextExpandedIds: Set<string>, expandedKeys: string[] = []) {
  const expanded = new Set(expandedKeys);
  const toggleGroup = vi.fn((key: string) => {
    if (expanded.has(key)) {
      expanded.delete(key);
    } else {
      expanded.add(key);
    }
  });
  const hook = renderHook(
    (props: { contextExpandedIds: Set<string> }) =>
      useContextGroupExpansion({
        contextExpandedIds: props.contextExpandedIds,
        isGroupExpanded: (key) => expanded.has(key),
        toggleGroup,
      }),
    { initialProps: { contextExpandedIds } }
  );
  return { ...hook, toggleGroup };
}

describe("useContextGroupExpansion", () => {
  it("defaults context nodes to expanded regardless of stored state", () => {
    const { result } = setup(new Set(["context-1"]));
    expect(result.current.isTreeGroupExpanded("context-1")).toBe(true);
    expect(result.current.isTreeGroupExpanded("regular-1")).toBe(false);
  });

  it("collapses a context node when the user toggles it", () => {
    const { result, toggleGroup } = setup(new Set(["context-1"]));

    act(() => result.current.toggleTreeGroup("context-1"));

    expect(result.current.isTreeGroupExpanded("context-1")).toBe(false);
    // Context toggles must not write to the persisted expansion store.
    expect(toggleGroup).not.toHaveBeenCalled();
  });

  it("re-expands a collapsed context node on a second toggle", () => {
    const { result } = setup(new Set(["context-1"]));

    act(() => result.current.toggleTreeGroup("context-1"));
    act(() => result.current.toggleTreeGroup("context-1"));

    expect(result.current.isTreeGroupExpanded("context-1")).toBe(true);
  });

  it("delegates non-context nodes to the persisted expansion state", () => {
    const { result, toggleGroup } = setup(new Set(["context-1"]), ["stored-1"]);

    expect(result.current.isTreeGroupExpanded("stored-1")).toBe(true);

    act(() => result.current.toggleTreeGroup("regular-1"));

    expect(toggleGroup).toHaveBeenCalledWith("regular-1");
    expect(result.current.isTreeGroupExpanded("regular-1")).toBe(true);
  });

  it("falls back to stored state once a node is no longer filter context", () => {
    const { result, rerender } = setup(new Set(["context-1"]));

    act(() => result.current.toggleTreeGroup("context-1"));
    expect(result.current.isTreeGroupExpanded("context-1")).toBe(false);

    rerender({ contextExpandedIds: new Set<string>() });

    // No longer context: persisted state (collapsed by default) applies and
    // the local override is ignored.
    expect(result.current.isTreeGroupExpanded("context-1")).toBe(false);

    rerender({ contextExpandedIds: new Set(["context-1"]) });

    // Context again: the earlier explicit collapse still wins.
    expect(result.current.isTreeGroupExpanded("context-1")).toBe(false);
  });
});
