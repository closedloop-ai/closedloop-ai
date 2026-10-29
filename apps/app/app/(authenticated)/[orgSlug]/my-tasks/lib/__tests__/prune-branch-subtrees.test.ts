import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import type {
  ProjectTreeResponse,
  TreeChild,
} from "@repo/api/src/types/project-tree";
import { describe, expect, it } from "vitest";
import { pruneBranchSubtrees } from "../prune-branch-subtrees";

const ORGANIZATION_ID = "org-1";
const PROJECT_ID = "project-1";

describe("pruneBranchSubtrees (ISS-10470)", () => {
  it("drops a branch root", () => {
    const tree = treeOf([
      { root: artifact("branch-1", ArtifactType.Branch), children: [] },
      { root: artifact("issue-1", ArtifactType.Document), children: [] },
    ]);

    expect(rootIds(pruneBranchSubtrees(tree))).toEqual(["issue-1"]);
  });

  it("drops a branch nested under an assigned document, which is the route the kept downward walk leaves open", () => {
    const tree = treeOf([
      {
        root: artifact("issue-1", ArtifactType.Document),
        children: [child("branch-1", ArtifactType.Branch, "issue-1", 1)],
      },
    ]);

    const pruned = pruneBranchSubtrees(tree);

    expect(rootIds(pruned)).toEqual(["issue-1"]);
    expect(childIds(pruned)).toEqual([]);
  });

  it("takes the removed branch's sessions with it rather than orphaning them", () => {
    // A session's canonical parent IS its branch, so a session left behind
    // would render with a `parentId` naming a row that is no longer present.
    const tree = treeOf([
      {
        root: artifact("issue-1", ArtifactType.Document),
        children: [
          child("branch-1", ArtifactType.Branch, "issue-1", 1),
          child("session-1", ArtifactType.Session, "branch-1", 2),
          child("plan-1", ArtifactType.Document, "issue-1", 1),
        ],
      },
    ]);

    expect(childIds(pruneBranchSubtrees(tree))).toEqual(["plan-1"]);
  });

  it("removes a grandchild of the branch too, not just its direct children", () => {
    // `pruneBranchChildren` accumulates removed ids rather than comparing each
    // child against the branch directly. A direct `parentId === branchId` check
    // passes the one-level case above and still orphans this row.
    const tree = treeOf([
      {
        root: artifact("issue-1", ArtifactType.Document),
        children: [
          child("branch-1", ArtifactType.Branch, "issue-1", 1),
          child("session-1", ArtifactType.Session, "branch-1", 2),
          child("deployment-1", ArtifactType.Deployment, "session-1", 3),
        ],
      },
    ]);

    expect(childIds(pruneBranchSubtrees(tree))).toEqual([]);
  });

  it("drops an external parent that is a branch", () => {
    const tree: ProjectTreeResponse = {
      nodes: [
        { root: artifact("issue-1", ArtifactType.Document), children: [] },
      ],
      externalParents: [
        {
          childId: "issue-1",
          linkType: LinkType.Produces,
          parent: artifact("branch-1", ArtifactType.Branch),
        },
        {
          childId: "issue-1",
          linkType: LinkType.Produces,
          parent: artifact("prd-1", ArtifactType.Document),
        },
      ],
    };

    expect(
      pruneBranchSubtrees(tree)?.externalParents.map((l) => l.parent.id)
    ).toEqual(["prd-1"]);
  });

  it("returns the same object when there was no branch to remove", () => {
    const tree = treeOf([
      { root: artifact("issue-1", ArtifactType.Document), children: [] },
    ]);

    expect(pruneBranchSubtrees(tree)).toBe(tree);
  });

  // Both absent shapes are reachable: the source's contract says `null`, the
  // query hooks under it hand back `undefined` until the first response lands.
  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("passes %s through untouched", (_label, absent) => {
    expect(
      pruneBranchSubtrees(absent as unknown as ProjectTreeResponse | null)
    ).toBe(absent);
  });
});

function treeOf(nodes: ProjectTreeResponse["nodes"]): ProjectTreeResponse {
  return { nodes, externalParents: [] };
}

function rootIds(tree: ProjectTreeResponse | null): string[] {
  return (tree?.nodes ?? []).map((node) => node.root.id);
}

function childIds(tree: ProjectTreeResponse | null): string[] {
  return (tree?.nodes ?? []).flatMap((node) => node.children.map((c) => c.id));
}

function artifact(id: string, type: ArtifactType) {
  return {
    id,
    name: id,
    type,
    subtype: null,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    assigneeId: null,
    assignee: null,
    sortOrder: 0,
    createdAt: new Date(2026, 0, 1),
  } as unknown as ProjectTreeResponse["nodes"][number]["root"];
}

function child(
  id: string,
  type: ArtifactType,
  parentId: string,
  depth: number
): TreeChild {
  return {
    ...artifact(id, type),
    depth,
    linkType: LinkType.Produces,
    parentId,
  } as unknown as TreeChild;
}
