import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { TagColor } from "@repo/api/src/types/tag";
import { describe, expect, it } from "vitest";
import { shapeGetDocumentPayload } from "../tools/get-document.js";
import { shapeListDocumentItem } from "../tools/list-documents.js";

const routeRow = {
  id: "doc-1",
  title: "Feature",
  slug: "FEA-1031",
  type: DocumentType.Feature,
  status: DocumentStatus.Approved,
  projectId: "project-1",
  assigneeId: "user-1",
  createdAt: "2026-05-13T00:00:00.000Z",
  updatedAt: "2026-05-13T00:00:00.000Z",
  assignee: null,
  project: { name: "Project" },
};

const detailRow = {
  ...routeRow,
  latestVersion: 5,
  version: {
    id: "version-1",
    version: 5,
    createdAt: "2026-05-13T00:00:00.000Z",
    createdById: "user-1",
    content: "hello world",
  },
};

describe("MCP document tag shaping", () => {
  it("surfaces tag summaries on list and detail rows", () => {
    const tags = [
      {
        id: "tag-1",
        name: "groomed",
        color: TagColor.Green,
        ignoredExtraField: "not serialized",
      },
    ];
    const expectedTags = [
      { id: "tag-1", name: "groomed", color: TagColor.Green },
    ];

    expect(shapeListDocumentItem({ ...routeRow, tags })).toMatchObject({
      tags: expectedTags,
    });
    expect(shapeGetDocumentPayload({ ...detailRow, tags })).toMatchObject({
      tags: expectedTags,
    });
  });

  it("emits empty tags for untagged list and detail rows", () => {
    expect(shapeListDocumentItem({ ...routeRow, tags: [] })).toMatchObject({
      tags: [],
    });
    expect(shapeGetDocumentPayload({ ...detailRow, tags: [] })).toMatchObject({
      tags: [],
    });
    expect(shapeListDocumentItem(routeRow)).toMatchObject({ tags: [] });
    expect(shapeGetDocumentPayload(detailRow)).toMatchObject({ tags: [] });
  });

  it("drops unsupported tag values instead of widening the MCP contract", () => {
    const tags = [
      { id: "tag-1", name: "groomed", color: TagColor.Green },
      { id: "tag-2", name: "missing color" },
      { id: "tag-3", name: "unknown color", color: "chartreuse" },
      null,
    ];

    expect(shapeListDocumentItem({ ...routeRow, tags })).toMatchObject({
      tags: [{ id: "tag-1", name: "groomed", color: TagColor.Green }],
    });
    expect(
      shapeGetDocumentPayload({ ...detailRow, tags: "unsupported" })
    ).toMatchObject({ tags: [] });
  });
});
