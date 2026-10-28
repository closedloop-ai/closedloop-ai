import { describe, expect, it } from "vitest";
import { canBulkMoveDocumentsSelection } from "../documents-view-helpers";

describe("DocumentsView bulk move admission", () => {
  it("offers Move to Project for a selected My Tasks All result", () => {
    expect(
      canBulkMoveDocumentsSelection({
        canUseDocumentBulkActions: true,
        filterCategory: "all",
        hierarchyPlacementEnabled: false,
      })
    ).toBe(true);
  });

  it("does not offer Move to Project without an eligible selection", () => {
    expect(
      canBulkMoveDocumentsSelection({
        canUseDocumentBulkActions: false,
        filterCategory: "all",
        hierarchyPlacementEnabled: true,
      })
    ).toBe(false);
  });
});
