import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  HierarchyAvailability,
  type ProjectTreeDetailsResponse,
} from "@repo/api/src/types/project-tree";
import { HIERARCHY_EXPANDED_PARAM } from "@repo/app/shared/lib/hierarchy-expanded-param";
import {
  createMemoryNavigation,
  type MemoryNavigation,
} from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTreeArtifact } from "../../../documents/lib/__tests__/tree-fixtures";
import { useProjectArtifactHierarchyExpansion } from "../use-project-artifact-hierarchy-expansion";

const STORAGE_KEY = "table:expand:project-hierarchy-test";
const ROOT = makeTreeArtifact("root", ArtifactType.Document);
const BASE_HIERARCHY = {
  contractVersion: 1,
  capabilities: {
    childPaging: true,
    exactPlacement: true,
    maxVisibleLevels: 4,
    mutationVersion: "version-1",
  },
  diagnostics: [],
  diagnosticsComplete: true,
};
const COMPLETE_TREE: ProjectTreeDetailsResponse = {
  nodes: [
    {
      root: ROOT,
      children: [],
      hierarchy: {
        availability: HierarchyAvailability.Complete,
        childCount: 0,
      },
    },
  ],
  externalParents: [],
  hierarchy: BASE_HIERARCHY,
};
const PARTIAL_TREE: ProjectTreeDetailsResponse = {
  ...COMPLETE_TREE,
  hierarchy: { ...BASE_HIERARCHY, diagnosticsComplete: false },
};

beforeEach(() => globalThis.localStorage.clear());

describe("useProjectArtifactHierarchyExpansion", () => {
  it("restores linked state and prunes only after an authoritative complete snapshot", () => {
    const navigation = createMemoryNavigation({
      initialPath: `/projects/project-1?${HIERARCHY_EXPANDED_PARAM}=root&${HIERARCHY_EXPANDED_PARAM}=missing`,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NavigationProvider adapter={navigation.adapter}>
        {children}
      </NavigationProvider>
    );
    const { result, rerender } = renderHook(
      ({ tree }: { tree: ProjectTreeDetailsResponse }) =>
        useProjectArtifactHierarchyExpansion(STORAGE_KEY, tree),
      { initialProps: { tree: PARTIAL_TREE }, wrapper }
    );

    expect([...result.current.expandedArtifactIds]).toEqual([
      "root",
      "missing",
    ]);
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull();
    rerender({ tree: COMPLETE_TREE });
    expect([...result.current.expandedArtifactIds]).toEqual(["root"]);
    expect(currentParams(navigation).getAll(HIERARCHY_EXPANDED_PARAM)).toEqual([
      "root",
    ]);
  });

  it("routes controlled toggles through the bounded shared owner", () => {
    const { result } = renderHook(() =>
      useProjectArtifactHierarchyExpansion(STORAGE_KEY, PARTIAL_TREE)
    );
    act(() => {
      result.current.controlledExpansion.onChange(new Set(["root"]));
    });
    expect(result.current.expandedArtifactIds.has("root")).toBe(true);
    expect(
      JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? "null")
    ).toEqual({ toggledKeys: ["root"], version: 1 });
  });
});

function currentParams(navigation: MemoryNavigation): URLSearchParams {
  return new URL(navigation.getCurrentHref(), "http://localhost").searchParams;
}
