import {
  type Artifact,
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  type GenerationStatus,
} from "@repo/api/src/types/document";
import type {
  DetailedArtifact,
  ProjectTreeDetailsResponse,
} from "@repo/api/src/types/project-tree";
import { TagColor } from "@repo/api/src/types/tag";
import { describe, expect, it } from "vitest";
import {
  collectDocumentRowsFromTree,
  documentRowFromArtifact,
  treeHasActiveGeneration,
} from "../artifact-row-adapter";

const PROJECT = { id: "proj-1", name: "Project One" };

function makeArtifact(overrides: Partial<DetailedArtifact>): DetailedArtifact {
  const base: Artifact = {
    id: "a-1",
    organizationId: "org-1",
    projectId: "proj-1",
    type: ArtifactType.Document,
    subtype: ArtifactSubtype.Prd,
    name: "Some PRD",
    slug: "PRD-1",
    status: DocumentStatus.Draft,
    priority: Priority.High,
    assigneeId: "user-1",
    assignee: null,
    dueDate: null,
    externalUrl: null,
    sortOrder: 1000,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    createdById: null,
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
  };
  return { ...base, ...overrides };
}

describe("documentRowFromArtifact", () => {
  it("maps a document artifact onto the table row shape", () => {
    const row = documentRowFromArtifact(
      makeArtifact({
        tags: [{ id: "t1", name: "infra", color: TagColor.Red }],
      }),
      PROJECT
    );

    expect(row).toEqual({
      id: "a-1",
      slug: "PRD-1",
      title: "Some PRD",
      type: DocumentType.Prd,
      status: DocumentStatus.Draft,
      priority: Priority.High,
      assigneeId: "user-1",
      assignee: null,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-02T00:00:00.000Z"),
      projectId: "proj-1",
      sortOrder: 1000,
      tags: [{ id: "t1", name: "infra", color: TagColor.Red }],
      project: PROJECT,
    });
  });

  it.each([
    [ArtifactSubtype.Prd, DocumentType.Prd],
    [ArtifactSubtype.ImplementationPlan, DocumentType.ImplementationPlan],
    [ArtifactSubtype.Feature, DocumentType.Feature],
    [ArtifactSubtype.Template, DocumentType.Template],
  ])("maps subtype %s to document type %s", (subtype, expected) => {
    const row = documentRowFromArtifact(makeArtifact({ subtype }), null);
    expect(row?.type).toBe(expected);
  });

  it("returns null for non-document artifacts and documents without subtype", () => {
    expect(
      documentRowFromArtifact(
        makeArtifact({ type: ArtifactType.Branch, subtype: null }),
        null
      )
    ).toBeNull();
    expect(
      documentRowFromArtifact(makeArtifact({ subtype: null }), null)
    ).toBeNull();
  });

  it("falls back to Draft for an out-of-contract status string", () => {
    const row = documentRowFromArtifact(
      makeArtifact({ status: "SOMETHING_NEW" }),
      null
    );
    expect(row?.status).toBe(DocumentStatus.Draft);
  });
});

describe("collectDocumentRowsFromTree", () => {
  it("collects each document artifact once across roots and children, newest first", () => {
    const child = makeArtifact({
      id: "a-2",
      slug: "FEA-2",
      subtype: ArtifactSubtype.Feature,
      createdAt: new Date("2026-06-05T00:00:00.000Z"),
    });
    const tree: ProjectTreeDetailsResponse = {
      nodes: [
        {
          root: makeArtifact({}),
          children: [
            {
              ...child,
              linkType: LinkType.Produces,
              depth: 1,
              parentId: "a-1",
            },
          ],
        },
        // Branch root and a duplicate child appearance are both ignored.
        {
          root: makeArtifact({
            id: "br-1",
            type: ArtifactType.Branch,
            subtype: null,
          }),
          children: [
            {
              ...child,
              linkType: LinkType.Produces,
              depth: 1,
              parentId: "br-1",
            },
          ],
        },
      ],
      externalParents: [],
    };

    const rows = collectDocumentRowsFromTree(tree, PROJECT);

    expect(rows.map((r) => r.id)).toEqual(["a-2", "a-1"]);
  });

  it("returns an empty list for an undefined tree", () => {
    expect(collectDocumentRowsFromTree(undefined, null)).toEqual([]);
  });
});

describe("treeHasActiveGeneration", () => {
  it("detects an active generation status on any node", () => {
    const tree: ProjectTreeDetailsResponse = {
      nodes: [
        {
          root: makeArtifact({
            generationStatus: { status: "RUNNING" } as GenerationStatus,
          }),
          children: [],
        },
      ],
      externalParents: [],
    };
    expect(treeHasActiveGeneration(tree)).toBe(true);
  });

  it("is false for trees without active generations", () => {
    const tree: ProjectTreeDetailsResponse = {
      nodes: [{ root: makeArtifact({}), children: [] }],
      externalParents: [],
    };
    expect(treeHasActiveGeneration(tree)).toBe(false);
    expect(treeHasActiveGeneration(undefined)).toBe(false);
  });
});
