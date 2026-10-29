import { describe, expect, it } from "vitest";
import { genericArtifacts } from "../../fixtures";
import {
  buildArtifactHierarchyForest,
  canMoveArtifactHierarchySelection,
  canMoveArtifactHierarchySubtree,
  expansionAfterArtifactHierarchyMove,
  flattenVisibleArtifactHierarchy,
  groupVisibleHierarchyRowsByRoot,
  moveArtifactHierarchySelectionToProject,
  moveArtifactHierarchySubtree,
  normalizeArtifactHierarchySelection,
  retainArtifactMatchesWithAncestors,
  sortArtifactHierarchyRoots,
} from "../artifact-hierarchy";

const template = genericArtifacts[0]!;

function artifact(id: string, parentArtifactId: string | null = null) {
  return {
    ...template,
    id,
    parentArtifactId,
    slug: id.toUpperCase(),
    title: id,
  };
}

describe("artifact hierarchy", () => {
  it("preserves Asana-style expansion state after hierarchy moves", () => {
    const movedArtifacts = [
      artifact("root-a"),
      artifact("child-a", "root-a"),
      artifact("root-b"),
      artifact("child-b", "root-b"),
      artifact("former-parent"),
    ];

    expect(
      expansionAfterArtifactHierarchyMove(
        movedArtifacts,
        new Set(["root-a", "former-parent"])
      )
    ).toEqual(new Set(["root-a"]));
    expect(
      expansionAfterArtifactHierarchyMove(
        movedArtifacts,
        new Set(["root-a"]),
        "root-b"
      )
    ).toEqual(new Set(["root-a", "root-b"]));
  });

  it("renders four expanded levels in stable depth-first order", () => {
    const artifacts = [
      artifact("document"),
      artifact("issue", "document"),
      artifact("sub-issue", "issue"),
      artifact("branch", "sub-issue"),
    ];
    const rows = flattenVisibleArtifactHierarchy(
      buildArtifactHierarchyForest(artifacts),
      new Set(artifacts.map(({ id }) => id)),
      4
    );

    expect(
      rows.map(({ artifact: rowArtifact, depth }) => [rowArtifact.id, depth])
    ).toEqual([
      ["document", 0],
      ["issue", 1],
      ["sub-issue", 2],
      ["branch", 3],
    ]);
  });

  it("hides descendants below a collapsed artifact", () => {
    const artifacts = [
      artifact("document"),
      artifact("issue", "document"),
      artifact("branch", "issue"),
    ];
    const rows = flattenVisibleArtifactHierarchy(
      buildArtifactHierarchyForest(artifacts),
      new Set(["document"]),
      4
    );

    expect(rows.map(({ artifact: rowArtifact }) => rowArtifact.id)).toEqual([
      "document",
      "issue",
    ]);
  });

  it("does not render beyond the configured fourth level", () => {
    const artifacts = [
      artifact("level-1"),
      artifact("level-2", "level-1"),
      artifact("level-3", "level-2"),
      artifact("level-4", "level-3"),
      artifact("level-5", "level-4"),
    ];
    const rows = flattenVisibleArtifactHierarchy(
      buildArtifactHierarchyForest(artifacts),
      new Set(artifacts.map(({ id }) => id)),
      4
    );

    expect(rows.map(({ artifact: rowArtifact }) => rowArtifact.id)).toEqual([
      "level-1",
      "level-2",
      "level-3",
      "level-4",
    ]);
    expect(rows.at(-1)?.hasChildren).toBe(false);
  });

  it("keeps descendants attached to their root grouping unit", () => {
    const artifacts = [
      artifact("document-a"),
      artifact("issue-a", "document-a"),
      artifact("branch-a", "issue-a"),
      artifact("document-b"),
      artifact("issue-b", "document-b"),
    ];
    const rows = flattenVisibleArtifactHierarchy(
      buildArtifactHierarchyForest(artifacts),
      new Set(artifacts.map(({ id }) => id)),
      4
    );

    expect(
      groupVisibleHierarchyRowsByRoot(rows).map((group) => ({
        artifacts: group.artifacts.map(({ id }) => id),
        root: group.root.id,
      }))
    ).toEqual([
      {
        artifacts: ["document-a", "issue-a", "branch-a"],
        root: "document-a",
      },
      { artifacts: ["document-b", "issue-b"], root: "document-b" },
    ]);
  });

  it("retains matching descendants and their undisguised ancestor path", () => {
    const artifacts = [
      artifact("document"),
      artifact("matching-issue", "document"),
      artifact("matching-branch", "matching-issue"),
      artifact("nonmatching-sibling", "document"),
      artifact("other-root"),
    ];

    const result = retainArtifactMatchesWithAncestors(
      artifacts,
      new Set(["matching-branch"])
    );

    expect(result.artifacts.map(({ id }) => id)).toEqual([
      "document",
      "matching-issue",
      "matching-branch",
    ]);
    expect([...result.ancestorIds]).toEqual(["matching-issue", "document"]);
  });

  it("sorts roots without reordering descendants", () => {
    const artifacts = [
      artifact("root-z"),
      artifact("child-b", "root-z"),
      artifact("child-a", "root-z"),
      artifact("root-a"),
    ];
    const sorted = sortArtifactHierarchyRoots(
      buildArtifactHierarchyForest(artifacts),
      (left, right) => left.id.localeCompare(right.id)
    );

    expect(sorted.map(({ artifact: root }) => root.id)).toEqual([
      "root-a",
      "root-z",
    ]);
    expect(sorted[1]?.children.map(({ artifact: child }) => child.id)).toEqual([
      "child-b",
      "child-a",
    ]);
  });

  it("reorders siblings without detaching their descendants", () => {
    const artifacts = [
      artifact("root"),
      artifact("child-a", "root"),
      artifact("grandchild", "child-a"),
      artifact("child-b", "root"),
    ];

    const result = moveArtifactHierarchySubtree(
      artifacts,
      "child-a",
      "child-b",
      "after",
      4
    );

    expect(result.changed).toBe(true);
    expect(result.descendantCount).toBe(1);
    expect(result.artifacts.map(({ id }) => id)).toEqual([
      "root",
      "child-b",
      "child-a",
      "grandchild",
    ]);
  });

  // The pure move only. The shell cannot reach this path: `manualOrdering`
  // without `hierarchy` is unrepresentable in its props (ISS-10480).
  it("reorders a flat artifact set and refuses nesting at one level", () => {
    const artifacts = [
      artifact("first"),
      artifact("second"),
      artifact("third"),
    ];

    const reordered = moveArtifactHierarchySubtree(
      artifacts,
      "third",
      "first",
      "before",
      1
    );

    expect(reordered.artifacts.map(({ id }) => id)).toEqual([
      "third",
      "first",
      "second",
    ]);
    expect(
      canMoveArtifactHierarchySubtree(artifacts, "third", "first", "inside", 1)
    ).toBe(false);
  });

  it("moves complete subtrees across projects and promotes selected children", () => {
    const artifacts = [
      artifact("root-a"),
      artifact("child-a", "root-a"),
      artifact("grandchild-a", "child-a"),
      artifact("root-b"),
    ];

    const result = moveArtifactHierarchySelectionToProject(
      artifacts,
      ["child-a"],
      "8/17-21"
    );

    expect(result.remainingArtifacts.map(({ id }) => id)).toEqual([
      "root-a",
      "root-b",
    ]);
    expect(
      result.movedArtifacts.map(({ id, parentArtifactId, project }) => ({
        id,
        parentArtifactId,
        project,
      }))
    ).toEqual([
      { id: "child-a", parentArtifactId: null, project: "8/17-21" },
      {
        id: "grandchild-a",
        parentArtifactId: "child-a",
        project: "8/17-21",
      },
    ]);
    expect(result.descendantCount).toBe(1);
    expect(result.parentClearedCount).toBe(1);
  });

  it("reparents a complete subtree under another root", () => {
    const artifacts = [
      artifact("root-a"),
      artifact("child", "root-a"),
      artifact("grandchild", "child"),
      artifact("root-b"),
      artifact("existing-child", "root-b"),
    ];

    const result = moveArtifactHierarchySubtree(
      artifacts,
      "child",
      "root-b",
      "inside",
      4
    );

    expect(
      result.artifacts.map(({ id, parentArtifactId }) => [id, parentArtifactId])
    ).toEqual([
      ["root-a", null],
      ["root-b", null],
      ["child", "root-b"],
      ["grandchild", "child"],
      ["existing-child", "root-b"],
    ]);
  });

  it("inserts at an exact sibling position across parents and deep levels", () => {
    const artifacts = [
      artifact("root-a"),
      artifact("moving-child", "root-a"),
      artifact("root-b"),
      artifact("child-b-1", "root-b"),
      artifact("child-b-2", "root-b"),
      artifact("grandchild-b-1", "child-b-2"),
      artifact("grandchild-b-2", "child-b-2"),
    ];

    const betweenChildren = moveArtifactHierarchySubtree(
      artifacts,
      "moving-child",
      "child-b-2",
      "before",
      4
    );
    expect(
      betweenChildren.artifacts.map(({ id, parentArtifactId }) => [
        id,
        parentArtifactId,
      ])
    ).toEqual([
      ["root-a", null],
      ["root-b", null],
      ["child-b-1", "root-b"],
      ["moving-child", "root-b"],
      ["child-b-2", "root-b"],
      ["grandchild-b-1", "child-b-2"],
      ["grandchild-b-2", "child-b-2"],
    ]);

    const betweenGrandchildren = moveArtifactHierarchySubtree(
      betweenChildren.artifacts,
      "moving-child",
      "grandchild-b-2",
      "before",
      4
    );
    expect(
      betweenGrandchildren.artifacts.map(({ id, parentArtifactId }) => [
        id,
        parentArtifactId,
      ])
    ).toEqual([
      ["root-a", null],
      ["root-b", null],
      ["child-b-1", "root-b"],
      ["child-b-2", "root-b"],
      ["grandchild-b-1", "child-b-2"],
      ["moving-child", "child-b-2"],
      ["grandchild-b-2", "child-b-2"],
    ]);
  });

  it("promotes a child to the root level", () => {
    const artifacts = [
      artifact("root-a"),
      artifact("child", "root-a"),
      artifact("root-b"),
    ];

    const result = moveArtifactHierarchySubtree(
      artifacts,
      "child",
      "root-b",
      "before",
      4
    );

    expect(
      result.artifacts.map(({ id, parentArtifactId }) => [id, parentArtifactId])
    ).toEqual([
      ["root-a", null],
      ["child", null],
      ["root-b", null],
    ]);
  });

  it("rejects cycles and moves that exceed four levels", () => {
    const artifacts = [
      artifact("root"),
      artifact("child", "root"),
      artifact("grandchild", "child"),
      artifact("other-root"),
      artifact("other-child", "other-root"),
      artifact("other-grandchild", "other-child"),
    ];

    expect(
      moveArtifactHierarchySubtree(artifacts, "root", "grandchild", "inside", 4)
        .error
    ).toBe("cycle");
    expect(
      moveArtifactHierarchySubtree(
        artifacts,
        "child",
        "other-grandchild",
        "inside",
        4
      ).error
    ).toBe("depth");
  });

  it("normalizes selected descendants behind their selected ancestor", () => {
    const artifacts = [
      artifact("root"),
      artifact("child", "root"),
      artifact("grandchild", "child"),
      artifact("other-root"),
    ];

    expect(
      normalizeArtifactHierarchySelection(
        artifacts,
        new Set(["root", "child", "grandchild", "other-root"])
      )
    ).toEqual(["root", "other-root"]);
  });

  it("silently excludes cycles, self drops, and fifth-level targets from eligibility", () => {
    const artifacts = [
      artifact("root"),
      artifact("child", "root"),
      artifact("grandchild", "child"),
      artifact("great-grandchild", "grandchild"),
      artifact("other-root"),
    ];

    expect(
      canMoveArtifactHierarchySubtree(
        artifacts,
        "root",
        "grandchild",
        "inside",
        4
      )
    ).toBe(false);
    expect(
      canMoveArtifactHierarchySubtree(artifacts, "child", "child", "inside", 4)
    ).toBe(false);
    expect(
      canMoveArtifactHierarchySubtree(
        artifacts,
        "other-root",
        "great-grandchild",
        "inside",
        4
      )
    ).toBe(false);
  });

  it("validates a multi-selection as one atomic move", () => {
    const artifacts = [
      artifact("root-a"),
      artifact("child-a", "root-a"),
      artifact("root-b"),
      artifact("root-c"),
    ];

    expect(
      canMoveArtifactHierarchySelection(
        artifacts,
        ["root-a", "root-b"],
        "root-c",
        "before",
        4
      )
    ).toBe(true);
    expect(
      canMoveArtifactHierarchySelection(
        artifacts,
        ["root-a", "root-b"],
        "child-a",
        "inside",
        4
      )
    ).toBe(false);
    expect(
      canMoveArtifactHierarchySelection(
        artifacts,
        ["root-a", "root-c"],
        "root-c",
        "after",
        4
      )
    ).toBe(false);
  });
});
