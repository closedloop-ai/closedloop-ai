import { DocumentType } from "@repo/api/src/types/document";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { describe, expect, it } from "vitest";
import { canGeneratePrdFromRow } from "../documents-view";

function docRow(type: DocumentType): DocumentRowItem {
  return {
    kind: "document",
    data: { id: "doc-1", title: "Strategy Doc", type },
  } as DocumentRowItem;
}

describe("canGeneratePrdFromRow (FEA-3952)", () => {
  it("offers the action for an evergreen Document (Doc) row", () => {
    expect(canGeneratePrdFromRow(docRow(DocumentType.Doc))).toBe(true);
  });

  it("hides the action for non-Doc document rows", () => {
    expect(canGeneratePrdFromRow(docRow(DocumentType.Prd))).toBe(false);
    expect(canGeneratePrdFromRow(docRow(DocumentType.ImplementationPlan))).toBe(
      false
    );
  });

  it("hides the action for non-document rows (branch/session)", () => {
    const branchRow = {
      kind: "branch",
      data: { id: "branch-1", name: "feat/x" },
    } as unknown as DocumentRowItem;
    expect(canGeneratePrdFromRow(branchRow)).toBe(false);
  });
});
