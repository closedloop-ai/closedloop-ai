"use client";

import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { sectionIcon } from "@repo/app/documents/components/table/group-section-icon";
import type { DocumentGridGroup } from "@repo/app/documents/lib/documents-grid-groups";
import type { GroupSectionDescriptor } from "@repo/app/documents/lib/group-by";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { presentArtifactStatusBand } from "@repo/app/shared/components/artifact-status/artifact-status-group-band";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  branchPullRequestStatusFacet,
  documentStatusFacet,
  sessionStatusFacet,
} from "@repo/app/shared/lib/artifact-status-adapter";
import { useMemo } from "react";

/** Selects the universal status group mark and suppresses its duplicate label. */
export function useUniversalStatusGroupPresentation(
  groupBy: GroupByMode,
  sections: DocumentGridGroup[]
) {
  const enabled = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  return useMemo(
    () =>
      sections.map((section) => {
        const facet =
          enabled && groupBy === GroupByMode.Status
            ? statusGroupFacet(section.descriptor)
            : null;
        return facet
          ? presentArtifactStatusBand(section, facet)
          : { ...section, icon: sectionIcon(section.descriptor) };
      }),
    [enabled, groupBy, sections]
  );
}

function statusGroupFacet(descriptor: GroupSectionDescriptor) {
  if (
    descriptor.mode !== GroupByMode.Status ||
    descriptor.status === undefined
  ) {
    return null;
  }
  const raw = descriptor.status;
  if (raw === IssueStatus.InReview) {
    return documentStatusFacet(DocumentType.Feature, raw);
  }
  switch (descriptor.artifactType) {
    case DocumentType.Feature:
      return documentStatusFacet(DocumentType.Feature, raw);
    case DocumentType.Prd:
    case DocumentType.Doc:
    case DocumentType.ImplementationPlan:
    case DocumentType.Template:
      return documentStatusFacet(descriptor.artifactType, raw);
    case ArtifactType.Branch:
      return branchPullRequestStatusFacet(raw);
    case ArtifactType.Session:
      return sessionStatusFacet(raw);
    default:
      return null;
  }
}
