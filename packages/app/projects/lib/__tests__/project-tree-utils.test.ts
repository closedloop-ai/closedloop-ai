import { ArtifactType } from "@repo/api/src/types/artifact";
import type { TreeChild, TreeNode } from "@repo/api/src/types/project-tree";
import { describe, expect, it } from "vitest";
import { addNodeParentEntries, type ParentEntry } from "../project-tree-utils";

// Non-document artifacts so getArtifactRoute returns null — this test exercises
// the parent-resolution logic, not the route format (covered by document-navigation).
function child(id: string, parentId: string, name: string): TreeChild {
  return {
    id,
    parentId,
    name,
    type: ArtifactType.Branch,
  } as unknown as TreeChild;
}

describe("addNodeParentEntries", () => {
  it("maps depth-1 children to the root and deeper children to their parent", () => {
    const node = {
      root: { id: "root", name: "Root", type: ArtifactType.Branch },
      children: [
        child("a", "root", "A"),
        child("b", "a", "B"),
        child("c", "missing", "C"),
      ],
    } as unknown as TreeNode;

    const map = new Map<string, ParentEntry>();
    addNodeParentEntries(node, map, "acme");

    expect(map.get("a")).toEqual({ title: "Root", href: null });
    expect(map.get("b")).toEqual({ title: "A", href: null });
    // Child whose parentId resolves to neither the root nor a sibling is skipped.
    expect(map.has("c")).toBe(false);
  });

  it("does not mutate entries for an empty child list", () => {
    const node = {
      root: { id: "root", name: "Root", type: ArtifactType.Branch },
      children: [],
    } as unknown as TreeNode;

    const map = new Map<string, ParentEntry>();
    addNodeParentEntries(node, map, "acme");

    expect(map.size).toBe(0);
  });
});
