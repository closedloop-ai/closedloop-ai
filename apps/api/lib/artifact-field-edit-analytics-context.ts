import type {
  ArtifactStatusEditSurface,
  ArtifactStatusProvenance,
} from "@repo/api/src/types/artifact-status-contract";
import {
  type ArtifactFieldEditAnalyticsInput,
  captureArtifactFieldEditAnalytics,
} from "./artifact-field-edit-analytics";
import {
  type ArtifactEditAuthMethod,
  resolveStatusProvenance,
} from "./artifact-status-provenance";

type BoundArtifactFieldEditAnalyticsInput = Omit<
  ArtifactFieldEditAnalyticsInput,
  "organizationId" | "userId" | "provenance" | "surface" | "commitGroupId"
>;

export type ArtifactFieldEditAnalyticsContext = {
  provenance?: ArtifactStatusProvenance;
  receiptContext?: { provenance: ArtifactStatusProvenance };
  capture: (input: BoundArtifactFieldEditAnalyticsInput) => void;
};

/** Resolve trusted provenance once and bind it to every receipt and outcome. */
export function createArtifactFieldEditAnalyticsContext(params: {
  organizationId: string;
  userId: string;
  authMethod: ArtifactEditAuthMethod;
  surface?: ArtifactStatusEditSurface;
  commitGroupId?: string;
}): ArtifactFieldEditAnalyticsContext {
  const provenance = resolveStatusProvenance(params);
  const receiptContext = provenance === undefined ? undefined : { provenance };
  return {
    provenance,
    receiptContext,
    capture(input): void {
      captureArtifactFieldEditAnalytics({
        organizationId: params.organizationId,
        userId: params.userId,
        ...input,
        ...(provenance === undefined ? {} : { provenance }),
        ...(params.commitGroupId === undefined
          ? {}
          : { commitGroupId: params.commitGroupId }),
      });
    },
  };
}
