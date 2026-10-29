import { TableCustomFieldType } from "@repo/design-system/components/ui/table-add-field-dialog";
import { describe, expect, it } from "vitest";
import { ArtifactKind, genericArtifacts } from "../../fixtures";
import { customFieldReferenceValues } from "../artifact-list-custom-field-model";

describe("custom field reference population", () => {
  it("derives candidates only from the host-provided artifacts", () => {
    const issue = genericArtifacts.find(
      (artifact) => artifact.kind === ArtifactKind.Issue
    )!;

    expect(
      customFieldReferenceValues(
        {
          id: "issue-reference",
          label: "Issue",
          sources: ["Issues"],
          type: TableCustomFieldType.Reference,
        },
        [issue]
      )
    ).toEqual([issue.slug]);
  });
});
