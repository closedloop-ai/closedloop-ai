import { ArtifactStatusVocabulary } from "@repo/api/src/types/artifact-status-contract";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { presentArtifactStatusBand } from "@repo/app/shared/components/artifact-status/artifact-status-group-band";
import { artifactStatusFacet } from "@repo/app/shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import type { GridTableV2Group } from "@repo/design-system/lib/grid-table-v2-types";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

const FACET = artifactStatusFacet(
  ArtifactStatusVocabulary.Document,
  DocumentStatus.InReview
);

describe("presentArtifactStatusBand", () => {
  it("keeps every band field except the label and icon", () => {
    const band: GridTableV2Group<string> = {
      count: 12,
      droppable: true,
      icon: "old-icon",
      isContinued: true,
      items: ["row-1", "row-2"],
      key: "status:in_review",
      label: "In review",
      subgroups: [{ items: ["row-1"], key: "alex", label: "Alex" }],
      value: "in_review",
    };

    const presented = presentArtifactStatusBand(band, FACET);

    expect(presented).toEqual({ ...band, icon: presented.icon, label: "" });
    expect(presented.icon).not.toBe(band.icon);
  });

  it("draws the facet's option-scale mark, glyph included, as the band icon", () => {
    const band: GridTableV2Group<string> = {
      items: [],
      key: "k",
      label: "In review",
    };
    const presented = presentArtifactStatusBand(band, FACET);

    expect(renderIcon(presented.icon)).toBe(
      renderIcon(
        <ArtifactStatus
          facet={FACET}
          variant={ArtifactStatusVariant.BulkOption}
        />
      )
    );
    expect(renderIcon(presented.icon)).toContain("<svg");
    // The band word stays at the option scale; the lane mark would enlarge it.
    expect(renderIcon(presented.icon)).not.toContain("text-sm");
  });
});

function renderIcon(icon: ReactNode): string {
  const { container, unmount } = render(icon);
  const html = container.innerHTML;
  unmount();
  return html;
}
