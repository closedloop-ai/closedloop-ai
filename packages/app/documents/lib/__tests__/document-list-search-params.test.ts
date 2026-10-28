import { CustomFieldFilterOperator } from "@repo/api/src/types/custom-field-list-query";
import { DocumentType } from "@repo/api/src/types/document";
import { describe, expect, it } from "vitest";
import { buildDocumentListSearchParams } from "../document-list-search-params";

const OWNER_A = "00000000-0000-4000-8000-0000000000a1";
const OWNER_B = "00000000-0000-4000-8000-0000000000a2";
const FIELD = "00000000-0000-4000-8000-0000000000f1";

describe("buildDocumentListSearchParams (ISS-12600 card scope)", () => {
  it("repeats id facets, spells booleans, and JSON-encodes custom-field facets", () => {
    const facets = [
      {
        fieldId: FIELD,
        operator: CustomFieldFilterOperator.IsAnyOf,
        values: ["opt"],
      },
    ];
    const query = new URLSearchParams(
      buildDocumentListSearchParams({
        types: [DocumentType.Prd],
        assigneeIds: [OWNER_A, OWNER_B],
        includeUnassigned: true,
        tagIds: [OWNER_B],
        favoritesOnly: true,
        customFieldFilters: facets,
      })
    );
    expect(query.getAll("assigneeIds")).toEqual([OWNER_A, OWNER_B]);
    expect(query.getAll("tagIds")).toEqual([OWNER_B]);
    expect(query.get("includeUnassigned")).toBe("true");
    expect(query.get("favoritesOnly")).toBe("true");
    expect(JSON.parse(query.get("customFieldFilters") ?? "null")).toEqual(
      facets
    );
  });
});
