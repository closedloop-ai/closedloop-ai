import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { type GenericArtifact, genericArtifacts } from "../../fixtures";
import { useArtifactHierarchyView } from "../artifact-hierarchy-view";

const root = { ...genericArtifacts[0]!, id: "root", parentArtifactId: null };
const child = { ...root, id: "child", parentArtifactId: root.id };
const artifacts: GenericArtifact[] = [root, child];
const compareArtifacts = () => 0;

beforeEach(() => globalThis.localStorage.clear());

describe("hierarchy expansion during asynchronous reads", () => {
  it("uses a controlled expansion owner without writing the legacy storage path", () => {
    const storageKey = "controlled-project:expansion";
    const { result } = renderHook(() => {
      const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
        new Set()
      );
      return useArtifactHierarchyView({
        artifacts,
        filteredArtifacts: artifacts,
        filtersActive: false,
        compareArtifacts,
        hierarchy: {
          maxVisibleLevels: 4,
          expansionStorageKey: storageKey,
          controlledExpansion: { expandedIds, onChange: setExpandedIds },
        },
        sortActive: false,
      });
    });

    expect(result.current.isExpanded(root.id)).toBe(false);
    act(() => result.current.toggleExpanded(root.id));
    expect(result.current.isExpanded(root.id)).toBe(true);
    expect(result.current.orderedArtifacts.map((row) => row.id)).toEqual([
      root.id,
      child.id,
    ]);
    expect(globalThis.localStorage.getItem(storageKey)).toBeNull();
  });

  it.each([null, "project-a:expansion"])(
    "waits for rows before initializing expansion (%s)",
    async (storageKey) => {
      const { result, rerender } = renderHook(
        ({ rows }: { rows: GenericArtifact[] }) =>
          useArtifactHierarchyView({
            artifacts: rows,
            filteredArtifacts: rows,
            filtersActive: false,
            compareArtifacts,
            hierarchy: { maxVisibleLevels: 4, expansionStorageKey: storageKey },
            sortActive: false,
          }),
        { initialProps: { rows: emptyArtifacts } }
      );
      if (storageKey) {
        expect(globalThis.localStorage.getItem(storageKey)).toBeNull();
      }
      rerender({ rows: artifacts });
      await waitFor(() =>
        expect(result.current.isExpanded(root.id)).toBe(true)
      );
      expect(result.current.orderedArtifacts.map((row) => row.id)).toEqual([
        root.id,
        child.id,
      ]);
      act(() => result.current.toggleExpanded(root.id));
      rerender({ rows: emptyArtifacts });
      rerender({ rows: [...artifacts] });
      expect(result.current.isExpanded(root.id)).toBe(false);
      expect(result.current.orderedArtifacts.map((row) => row.id)).toEqual([
        root.id,
      ]);
    }
  );

  it("does not persist the empty loading result when a filter is already active", async () => {
    const storageKey = "filtered-project:expansion";
    const { result, rerender } = renderHook(
      ({ rows, filtering }: { rows: GenericArtifact[]; filtering: boolean }) =>
        useArtifactHierarchyView({
          artifacts: rows,
          filteredArtifacts: rows.filter((row) => row.id === child.id),
          filtersActive: filtering,
          compareArtifacts,
          hierarchy: { maxVisibleLevels: 4, expansionStorageKey: storageKey },
          sortActive: false,
        }),
      { initialProps: { rows: emptyArtifacts, filtering: true } }
    );
    expect(globalThis.localStorage.getItem(storageKey)).toBeNull();
    rerender({ rows: artifacts, filtering: true });
    await waitFor(() => expect(result.current.isExpanded(root.id)).toBe(true));
    rerender({ rows: artifacts, filtering: false });
    expect(result.current.isExpanded(root.id)).toBe(true);
  });

  it("initializes a different project after its empty loading render and retains the first project's collapse", async () => {
    const { result, rerender } = renderHook(
      ({ rows, storageKey }: { rows: GenericArtifact[]; storageKey: string }) =>
        useArtifactHierarchyView({
          artifacts: rows,
          filteredArtifacts: rows,
          filtersActive: false,
          compareArtifacts,
          hierarchy: { maxVisibleLevels: 4, expansionStorageKey: storageKey },
          sortActive: false,
        }),
      { initialProps: { rows: artifacts, storageKey: "project-a:expansion" } }
    );
    await waitFor(() => expect(result.current.isExpanded(root.id)).toBe(true));
    act(() => result.current.toggleExpanded(root.id));
    rerender({ rows: emptyArtifacts, storageKey: "project-b:expansion" });
    expect(globalThis.localStorage.getItem("project-b:expansion")).toBeNull();
    rerender({ rows: artifacts, storageKey: "project-b:expansion" });
    await waitFor(() => expect(result.current.isExpanded(root.id)).toBe(true));
    rerender({ rows: artifacts, storageKey: "project-a:expansion" });
    expect(result.current.isExpanded(root.id)).toBe(false);
  });
});

const emptyArtifacts: GenericArtifact[] = [];
