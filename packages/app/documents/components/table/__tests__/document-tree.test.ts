import {
  type Artifact,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  collectArtifactRowItems,
  type DisplayGroup,
  filterDisplayGroups,
  groupByProjectTree,
} from "@repo/app/documents/components/table/document-tree";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { describe, expect, it } from "vitest";

// ---- Fixtures ----

function makeItem(
  id: string,
  assigneeId: string | null,
  children?: DocumentRowItem[]
): DocumentRowItem {
  return {
    kind: "document",
    data: createMockDocument({ id, slug: id, title: id, assigneeId }),
    children,
  };
}

/** Predicate mirroring how the view derives matches from assignee filters. */
function assignedTo(target: string): (item: DocumentRowItem) => boolean {
  return (item) => item.data.assigneeId === target;
}

// ---- Tests ----

describe("filterDisplayGroups", () => {
  it("keeps a group whose root matches and preserves its full subtree", () => {
    const groups: DisplayGroup[] = [
      {
        groupKey: "prd-daniel",
        root: makeItem("prd-daniel", "daniel"),
        children: [makeItem("fea-kris", "kris"), makeItem("fea-bob", "bob")],
      },
    ];

    const { groups: result } = filterDisplayGroups(
      groups,
      assignedTo("daniel")
    );

    expect(result).toHaveLength(1);
    // Matching root retains all children regardless of their assignee.
    expect(result[0].children.map((c) => c.data.id)).toEqual([
      "fea-kris",
      "fea-bob",
    ]);
  });

  it("surfaces a matching child whose parent is assigned to someone else", () => {
    // PRD-430 (Kris) -> FEA-1515 (daniel) + FEA-1516 (bob). Filtering for daniel
    // must still reveal FEA-1515, with PRD-430 kept as context.
    const groups: DisplayGroup[] = [
      {
        groupKey: "prd-430",
        root: makeItem("prd-430", "kris"),
        children: [makeItem("fea-1515", "daniel"), makeItem("fea-1516", "bob")],
      },
    ];

    const { groups: result, contextExpandedIds } = filterDisplayGroups(
      groups,
      assignedTo("daniel")
    );

    expect(result).toHaveLength(1);
    expect(result[0].groupKey).toBe("prd-430");
    // The non-matching sibling is pruned; only the matching child remains.
    expect(result[0].children.map((c) => c.data.id)).toEqual(["fea-1515"]);
    // The context root is force-expanded so the match is visible.
    expect(contextExpandedIds.has("prd-430")).toBe(true);
  });

  it("drops a group with no matching root or descendant", () => {
    const groups: DisplayGroup[] = [
      {
        groupKey: "prd-kris",
        root: makeItem("prd-kris", "kris"),
        children: [makeItem("fea-bob", "bob")],
      },
    ];

    const { groups: result } = filterDisplayGroups(
      groups,
      assignedTo("daniel")
    );

    expect(result).toHaveLength(0);
  });

  it("surfaces a matching grandchild and force-expands the context path", () => {
    const groups: DisplayGroup[] = [
      {
        groupKey: "prd-430",
        root: makeItem("prd-430", "kris", [
          makeItem("fea-mid", "bob", [makeItem("task-deep", "daniel")]),
          makeItem("fea-other", "bob"),
        ]),
        children: [
          makeItem("fea-mid", "bob", [makeItem("task-deep", "daniel")]),
          makeItem("fea-other", "bob"),
        ],
      },
    ];

    const { groups: result, contextExpandedIds } = filterDisplayGroups(
      groups,
      assignedTo("daniel")
    );

    expect(result).toHaveLength(1);
    expect(result[0].children.map((c) => c.data.id)).toEqual(["fea-mid"]);
    expect(result[0].children[0].children?.map((c) => c.data.id)).toEqual([
      "task-deep",
    ]);
    // Both the root and the intermediate node must be expanded to reach the match.
    expect(contextExpandedIds.has("prd-430")).toBe(true);
    expect(contextExpandedIds.has("fea-mid")).toBe(true);
  });

  it("does not mutate the input groups", () => {
    const children = [
      makeItem("fea-1515", "daniel"),
      makeItem("fea-1516", "bob"),
    ];
    const groups: DisplayGroup[] = [
      { groupKey: "prd-430", root: makeItem("prd-430", "kris"), children },
    ];

    filterDisplayGroups(groups, assignedTo("daniel"));

    expect(children).toHaveLength(2);
    expect(groups[0].children).toBe(children);
  });
});

describe("groupByProjectTree — SESSION artifacts (FEA-1699)", () => {
  it("renders SESSION nodes as first-class session rows instead of dropping them", () => {
    const doc = createMockDocument({
      id: "doc-1",
      slug: "PRD-1",
      title: "Source PRD",
    });
    const sessionChild = makeArtifact("ses-child", ArtifactType.Session);
    const sessionRoot = makeArtifact("ses-root", ArtifactType.Session);

    const groups = groupByProjectTree(
      [
        {
          root: makeArtifact("doc-1", ArtifactType.Document),
          children: [
            {
              ...sessionChild,
              linkType: LinkType.Produces,
              depth: 1,
              parentId: "doc-1",
            },
          ],
        },
        // An unlinked session attributed to the project surfaces as its own
        // root group rather than being filtered out of the tree.
        { root: sessionRoot, children: [] },
      ],
      [doc]
    );

    const docGroup = groups.find((group) => group.groupKey === "doc-1");
    expect(
      docGroup?.children.some(
        (child) => child.kind === "session" && child.data.id === "ses-child"
      )
    ).toBe(true);

    const sessionGroup = groups.find((group) => group.groupKey === "ses-root");
    expect(sessionGroup?.root.kind).toBe("session");
    expect(
      sessionGroup?.root.kind === "session"
        ? sessionGroup.root.data.type
        : undefined
    ).toBe(ArtifactType.Session);
  });
});

describe("groupByProjectTree — DEPLOYMENT artifacts (FEA-1763)", () => {
  it("excludes DEPLOYMENT nodes from the tree, both as children and as roots", () => {
    const doc = createMockDocument({
      id: "doc-1",
      slug: "PRD-1",
      title: "Source PRD",
    });
    const deploymentChild = makeArtifact("dep-child", ArtifactType.Deployment);

    const groups = groupByProjectTree(
      [
        {
          root: makeArtifact("doc-1", ArtifactType.Document),
          children: [
            {
              ...deploymentChild,
              linkType: LinkType.Produces,
              depth: 1,
              parentId: "doc-1",
            },
          ],
        },
        {
          root: makeArtifact("dep-root", ArtifactType.Deployment),
          children: [],
        },
      ],
      [doc]
    );

    const docGroup = groups.find((group) => group.groupKey === "doc-1");
    expect(docGroup).toBeDefined();
    expect(docGroup?.children).toHaveLength(0);
    expect(groups.some((group) => group.groupKey === "dep-root")).toBe(false);
  });
});

describe("collectArtifactRowItems (FEA-1763 Phase 2)", () => {
  it("collects artifacts of the requested type from roots and children, deduplicated", () => {
    const branchRoot = makeArtifact("br-root", ArtifactType.Branch);
    const branchChild = makeArtifact("br-child", ArtifactType.Branch);
    const session = makeArtifact("ses-1", ArtifactType.Session);

    const items = collectArtifactRowItems(
      [
        {
          root: makeArtifact("doc-1", ArtifactType.Document),
          children: [
            {
              ...branchChild,
              linkType: LinkType.Produces,
              depth: 1,
              parentId: "doc-1",
            },
            {
              ...session,
              linkType: LinkType.Produces,
              depth: 1,
              parentId: "doc-1",
            },
          ],
        },
        { root: branchRoot, children: [] },
        // The same branch can be reachable under two parents — collected once.
        {
          root: makeArtifact("doc-2", ArtifactType.Document),
          children: [
            {
              ...branchChild,
              linkType: LinkType.Produces,
              depth: 1,
              parentId: "doc-2",
            },
          ],
        },
      ],
      ArtifactType.Branch
    );

    expect(items.map((i) => i.data.id)).toEqual(["br-child", "br-root"]);
    expect(items.every((i) => i.kind === "branch")).toBe(true);
  });
});

function makeArtifact(id: string, type: ArtifactType): Artifact {
  return {
    id,
    organizationId: "org-1",
    projectId: "proj-1",
    type,
    subtype: null,
    name: id,
    slug: id.toUpperCase(),
    status: "active",
    priority: null,
    assigneeId: null,
    assignee: null,
    dueDate: null,
    externalUrl: null,
    sortOrder: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    createdById: null,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  };
}
