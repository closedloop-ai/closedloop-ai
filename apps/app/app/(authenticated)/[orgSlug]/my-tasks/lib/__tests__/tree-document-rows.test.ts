import type { Artifact } from "@repo/api/src/types/artifact";
import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { IssueStatus } from "@repo/api/src/types/document";
import type {
  ProjectTreeResponse,
  TreeChild,
} from "@repo/api/src/types/project-tree";
import { describe, expect, it } from "vitest";
import { type ProjectsById, treeDocumentRows } from "../tree-document-rows";

const PROJECT_A = { id: "p-a", name: "Project A", slug: "project-a" };
const PROJECTS: ProjectsById = new Map([[PROJECT_A.id, PROJECT_A]]);

function artifact(overrides: Partial<Artifact> & { id: string }): Artifact {
  return {
    assignee: null,
    assigneeId: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    createdById: null,
    dueDate: null,
    externalUrl: null,
    name: `artifact ${overrides.id}`,
    organizationId: "org-1",
    priority: null,
    projectId: PROJECT_A.id,
    slug: `slug-${overrides.id}`,
    sortOrder: null,
    status: IssueStatus.Todo,
    subtype: ArtifactSubtype.Feature,
    type: ArtifactType.Document,
    updatedAt: new Date("2026-10-02T00:00:00.000Z"),
    ...overrides,
  };
}

function tree(
  nodes: Array<{ root: Artifact; children?: Artifact[] }>
): ProjectTreeResponse {
  return {
    externalParents: [],
    nodes: nodes.map((node) => ({
      children: (node.children ?? []).map(
        (child) => ({ ...child, depth: 1, parentId: node.root.id }) as TreeChild
      ),
      root: node.root,
    })),
  };
}

describe("treeDocumentRows", () => {
  it("builds a row for each document, roots and descendants alike", () => {
    const rows = treeDocumentRows(
      tree([
        {
          children: [artifact({ id: "child" })],
          root: artifact({ id: "root" }),
        },
      ]),
      PROJECTS
    );

    expect(rows.map((row) => row.id)).toEqual(["root", "child"]);
  });

  it("resolves each row's project from the map", () => {
    const rows = treeDocumentRows(
      tree([{ root: artifact({ id: "a" }) }]),
      PROJECTS
    );

    expect(rows[0].project).toEqual(PROJECT_A);
  });

  it("emits a row for a PROJECT-LESS artifact rather than dropping it", () => {
    // `project_id` is nullable for every artifact type (FEA-1749). Hiding the
    // row would remove an assigned task from the assignee's own board.
    const rows = treeDocumentRows(
      tree([{ root: artifact({ id: "orphan", projectId: null }) }]),
      PROJECTS
    );

    expect(rows.map((row) => row.id)).toEqual(["orphan"]);
    expect(rows[0].project).toBeNull();
  });

  it("emits a row when the project id is absent from the map", () => {
    // The projects read is a separate request and can lag or be narrowed; a row
    // whose project has not arrived still belongs on the board.
    const rows = treeDocumentRows(
      tree([{ root: artifact({ id: "unknown-project", projectId: "p-zzz" }) }]),
      PROJECTS
    );

    expect(rows.map((row) => row.id)).toEqual(["unknown-project"]);
    expect(rows[0].project).toBeNull();
  });

  it("emits one row for an artifact reachable twice", () => {
    const shared = artifact({ id: "shared" });
    const rows = treeDocumentRows(
      tree([
        { children: [shared], root: artifact({ id: "r1" }) },
        { children: [shared], root: artifact({ id: "r2" }) },
      ]),
      PROJECTS
    );

    expect(rows.filter((row) => row.id === "shared")).toHaveLength(1);
  });

  it("skips a non-document artifact", () => {
    const rows = treeDocumentRows(
      tree([
        {
          root: artifact({
            id: "branch",
            subtype: null,
            type: ArtifactType.Branch,
          }),
        },
      ]),
      PROJECTS
    );

    expect(rows).toEqual([]);
  });

  it("returns nothing for an unread tree", () => {
    expect(treeDocumentRows(null, PROJECTS)).toEqual([]);
  });
});
