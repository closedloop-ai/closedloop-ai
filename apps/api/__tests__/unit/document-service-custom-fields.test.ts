import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { DocumentWithProject } from "@repo/api/src/types/document";
import { afterEach, describe, expect, it, vi } from "vitest";
import { customFieldValuesService } from "@/app/custom-fields/values-service";
import { documentService } from "@/app/documents/document-service";

vi.mock("@/app/custom-fields/values-service", () => ({
  customFieldValuesService: {
    getValuesForEntity: vi.fn(),
  },
}));

const ORG_ID = "org-1";

function makeDocument(id: string): DocumentWithProject {
  return { id, title: id } as DocumentWithProject;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("documentService.findAllWithCustomFields", () => {
  it("returns early without querying custom fields when there are no documents", async () => {
    vi.spyOn(documentService, "findAll").mockResolvedValue([]);

    const result = await documentService.findAllWithCustomFields({
      organizationId: ORG_ID,
    });

    expect(result).toEqual([]);
    expect(customFieldValuesService.getValuesForEntity).not.toHaveBeenCalled();
  });

  it("attaches an empty customFields array to documents without values", async () => {
    vi.spyOn(documentService, "findAll").mockResolvedValue([
      makeDocument("doc-1"),
      makeDocument("doc-2"),
    ]);
    vi.mocked(customFieldValuesService.getValuesForEntity).mockResolvedValue(
      []
    );

    const result = await documentService.findAllWithCustomFields({
      organizationId: ORG_ID,
      projectId: "proj-1",
    });

    expect(result.map((d) => d.customFields)).toEqual([[], []]);
    expect(customFieldValuesService.getValuesForEntity).toHaveBeenCalledWith(
      CustomFieldEntityType.Document,
      ["doc-1", "doc-2"],
      ORG_ID
    );
  });

  it("groups multiple custom field values by entityId onto the right documents", async () => {
    vi.spyOn(documentService, "findAll").mockResolvedValue([
      makeDocument("doc-1"),
      makeDocument("doc-2"),
      makeDocument("doc-3"),
    ]);
    const values = [
      { entityId: "doc-1", fieldId: "f1", value: "a" },
      { entityId: "doc-1", fieldId: "f2", value: "b" },
      { entityId: "doc-3", fieldId: "f1", value: "c" },
    ];
    vi.mocked(customFieldValuesService.getValuesForEntity).mockResolvedValue(
      values as never
    );

    const result = await documentService.findAllWithCustomFields({
      organizationId: ORG_ID,
      projectId: "proj-1",
    });

    expect(result[0].customFields).toEqual([values[0], values[1]]);
    expect(result[1].customFields).toEqual([]);
    expect(result[2].customFields).toEqual([values[2]]);
  });
});
