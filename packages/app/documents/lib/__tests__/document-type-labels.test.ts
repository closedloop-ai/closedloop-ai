import { DocumentType } from "@repo/api/src/types/document";
import {
  DOCUMENT_TYPE_BADGE_LABELS,
  DOCUMENT_TYPE_LABELS,
} from "@repo/app/documents/lib/document-type-labels";
import { DOCUMENT_TYPE_BADGE_LABELS as PROJECT_BADGE_LABELS } from "@repo/app/projects/lib/project-constants";
import { describe, expect, test } from "vitest";

describe("document-type labels (FEA-3954: Features → Issues copy, SSOT)", () => {
  test("the FEATURE artifact type displays as 'Issue' in both maps", () => {
    expect(DOCUMENT_TYPE_LABELS[DocumentType.Feature]).toBe("Issue");
    expect(DOCUMENT_TYPE_BADGE_LABELS[DocumentType.Feature]).toBe("Issue");
  });

  test("other artifact type labels are unchanged", () => {
    expect(DOCUMENT_TYPE_LABELS[DocumentType.Prd]).toBe("PRD");
    expect(DOCUMENT_TYPE_LABELS[DocumentType.ImplementationPlan]).toBe(
      "Implementation Plan"
    );
    expect(DOCUMENT_TYPE_LABELS[DocumentType.Template]).toBe("Template");
    expect(DOCUMENT_TYPE_BADGE_LABELS[DocumentType.ImplementationPlan]).toBe(
      "Plan"
    );
  });

  test("project-constants re-exports the canonical map (no drift-by-copy)", () => {
    // The project-scoped alias must be the same reference as the canonical
    // documents-slice map so the label copy can never diverge between owners.
    expect(PROJECT_BADGE_LABELS).toBe(DOCUMENT_TYPE_BADGE_LABELS);
  });
});
