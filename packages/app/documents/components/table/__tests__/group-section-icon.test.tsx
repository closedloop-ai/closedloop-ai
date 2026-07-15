import {
  DocumentStatus,
  DocumentType,
  FeatureStatus,
} from "@repo/api/src/types/document";
import { FeatureStatusIcon } from "@repo/app/documents/components/feature-status-icon";
import { sectionIcon } from "@repo/app/documents/components/table/group-section-icon";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("sectionIcon", () => {
  it("renders shared IN_REVIEW status groups with the canonical feature icon", () => {
    const section = render(
      sectionIcon({
        artifactType: DocumentType.Prd,
        key: DocumentStatus.InReview,
        label: "In Review",
        mode: GroupByMode.Status,
        status: DocumentStatus.InReview,
      })
    );
    const canonicalFeatureIcon = render(
      <FeatureStatusIcon status={FeatureStatus.InReview} />
    );

    expect(section.container.innerHTML).toBe(
      canonicalFeatureIcon.container.innerHTML
    );
  });
});
