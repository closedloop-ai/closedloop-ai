import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import { describe, expect, it } from "vitest";
import { initialCustomFieldValue } from "../../../packages/app/shared/components/generic-artifact-surface/custom-field-cells";
import {
  initialArtifactRows,
  initialCustomFields,
} from "../../../packages/app/shared/components/generic-artifact-surface/fixtures";

const [firstArtifact, secondArtifact, thirdArtifact] = initialArtifactRows;

function fieldById(id: string): CustomFieldDefinition {
  const field = initialCustomFields.find((candidate) => candidate.id === id);
  if (!field) {
    throw new Error(`Missing fixture field: ${id}`);
  }
  return field;
}

describe("initialCustomFieldValue", () => {
  it("returns null for rowIndex 2 regardless of field type", () => {
    expect(
      initialCustomFieldValue(fieldById("custom-stage"), thirdArtifact, 2)
    ).toBeNull();
    expect(
      initialCustomFieldValue(
        fieldById("custom-revision-count"),
        thirdArtifact,
        2
      )
    ).toBeNull();
  });

  describe("Single-select", () => {
    const stageField = fieldById("custom-stage");

    it("picks the option at rowIndex modulo the options length", () => {
      expect(initialCustomFieldValue(stageField, firstArtifact, 0)).toBe(
        "Discovery"
      );
      expect(initialCustomFieldValue(stageField, firstArtifact, 1)).toBe(
        "Build"
      );
      expect(initialCustomFieldValue(stageField, firstArtifact, 4)).toBe(
        "Build"
      );
    });

    it("returns null when options is undefined", () => {
      const field: CustomFieldDefinition = {
        id: "custom-no-options-single-select",
        label: "No Options",
        type: "Single-select",
      };

      expect(initialCustomFieldValue(field, firstArtifact, 0)).toBeNull();
    });

    it("falls back through the `|| 1` divisor and returns null when options is an empty array", () => {
      const field: CustomFieldDefinition = {
        id: "custom-empty-options-single-select",
        label: "Empty Options",
        options: [],
        type: "Single-select",
      };

      expect(initialCustomFieldValue(field, firstArtifact, 0)).toBeNull();
    });
  });

  describe("Multi-select", () => {
    const capabilitiesField = fieldById("custom-capabilities");

    it("slices the first two options", () => {
      expect(
        initialCustomFieldValue(capabilitiesField, firstArtifact, 0)
      ).toEqual(["Grid", "Editing"]);
    });

    it("returns an empty array when options is undefined", () => {
      const field: CustomFieldDefinition = {
        id: "custom-no-options-multi-select",
        label: "No Options",
        type: "Multi-select",
      };

      expect(initialCustomFieldValue(field, firstArtifact, 0)).toEqual([]);
    });
  });

  describe("Date", () => {
    const dueDateField = fieldById("custom-due-date");

    it("returns a fixed date for rowIndex 0 and a different fixed date otherwise", () => {
      expect(initialCustomFieldValue(dueDateField, firstArtifact, 0)).toBe(
        "2026-08-13"
      );
      expect(initialCustomFieldValue(dueDateField, secondArtifact, 1)).toBe(
        "2026-08-09"
      );
    });
  });

  describe("People", () => {
    const reviewerField = fieldById("custom-reviewer");

    it("returns the passed artifact's owner name", () => {
      expect(initialCustomFieldValue(reviewerField, firstArtifact, 0)).toBe(
        "Ottilie Eastwick"
      );
      expect(initialCustomFieldValue(reviewerField, secondArtifact, 1)).toBe(
        "Pascoe Birchall"
      );
    });
  });

  describe("Reference", () => {
    it("returns the artifact reference list when sources includes Artifacts", () => {
      const field = fieldById("custom-is-implemented-by");

      expect(initialCustomFieldValue(field, firstArtifact, 0)).toEqual([
        "FEA-2481",
        "BRN-grid-table-v2",
        "SES-7B91",
      ]);
    });

    it("returns the single reference id when sources does not include Artifacts", () => {
      const field = fieldById("custom-parent-artifact");

      expect(initialCustomFieldValue(field, firstArtifact, 0)).toBe("FEA-2481");
    });

    it("returns the single reference id when the field has no sources at all", () => {
      const field: CustomFieldDefinition = {
        id: "custom-reference-no-sources",
        label: "No Sources",
        type: "Reference",
      };

      expect(initialCustomFieldValue(field, firstArtifact, 0)).toBe("FEA-2481");
    });
  });

  describe("Reference (multi)", () => {
    it("always returns the fixed reference list, regardless of sources", () => {
      const field: CustomFieldDefinition = {
        id: "custom-related-artifacts",
        label: "Related Artifacts",
        sources: ["Issues"],
        type: "Reference (multi)",
      };

      expect(initialCustomFieldValue(field, firstArtifact, 0)).toEqual([
        "FEA-2481",
        "BRN-grid-table-v2",
        "SES-7B91",
      ]);
    });
  });

  describe("Time", () => {
    const cycleTimeField = fieldById("custom-cycle-time");

    it("returns a fixed time for rowIndex 0 and a different fixed time otherwise", () => {
      expect(initialCustomFieldValue(cycleTimeField, firstArtifact, 0)).toBe(
        "02:14"
      );
      expect(initialCustomFieldValue(cycleTimeField, secondArtifact, 1)).toBe(
        "00:48"
      );
    });
  });

  describe("Text", () => {
    it("returns the fixed placeholder text", () => {
      const summaryField = fieldById("custom-summary");

      expect(initialCustomFieldValue(summaryField, firstArtifact, 0)).toBe(
        "Custom text value"
      );
    });
  });

  describe("Number", () => {
    const revisionCountField = fieldById("custom-revision-count");

    it("derives the value from 184 + rowIndex * 37", () => {
      expect(
        initialCustomFieldValue(revisionCountField, firstArtifact, 0)
      ).toBe(184);
      expect(
        initialCustomFieldValue(revisionCountField, firstArtifact, 1)
      ).toBe(221);
      expect(
        initialCustomFieldValue(revisionCountField, firstArtifact, 3)
      ).toBe(295);
    });
  });
});
