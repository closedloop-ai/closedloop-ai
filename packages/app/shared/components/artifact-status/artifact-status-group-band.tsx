import { ArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import {
  type ArtifactStatusFacet,
  ArtifactStatusVariant,
} from "@repo/app/shared/lib/artifact-status-view-contract";
import type { ReactNode } from "react";

/**
 * One status band drawn by its universal status facet. The band keeps the
 * option-scale mark, glyph and word, so it takes the bulk-option variant: the
 * filter-option mark is the word alone since filter menus dropped their icons
 * (ISS-12919), and the lane mark would raise the word to the heading scale.
 * The mark already speaks the status, so the band's own label is cleared rather
 * than read twice; every other band field is kept.
 */
export function presentArtifactStatusBand<
  T extends { label: string; icon?: ReactNode },
>(band: T, facet: ArtifactStatusFacet): T {
  return {
    ...band,
    icon: (
      <ArtifactStatus
        facet={facet}
        variant={ArtifactStatusVariant.BulkOption}
      />
    ),
    label: "",
  };
}
