"use client";

/**
 * The flag gate and org binding for the artifact in-flight treatment.
 *
 * The treatment itself lives in `@repo/app` so it can be storied and shared;
 * this is the `apps/app` seam that supplies the two things only the app knows —
 * the PostHog flag and the org slug the session link is built from.
 *
 * Closed by default: `useFeatureFlag` returns undefined when the flag is absent
 * or off, so `?.enabled === true` renders nothing until the flag is deliberately
 * turned on.
 */

import { useFeatureFlag } from "@repo/analytics/client";
import type { GenerationStatus } from "@repo/api/src/types/document";
import { ArtifactRunInFlight } from "@repo/app/documents/components/artifact-run-in-flight";
import { ARTIFACT_RUN_IN_FLIGHT_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { useOrgSlug } from "@/hooks/use-org-slug";

type ArtifactRunInFlightSlotProps = {
  generationStatus: GenerationStatus | undefined;
  variant: "panel" | "banner";
};

export function ArtifactRunInFlightSlot({
  generationStatus,
  variant,
}: Readonly<ArtifactRunInFlightSlotProps>) {
  const enabled =
    useFeatureFlag(ARTIFACT_RUN_IN_FLIGHT_FEATURE_FLAG_KEY)?.enabled === true;
  const orgSlug = useOrgSlug();
  if (!(enabled && orgSlug)) {
    return null;
  }
  return (
    <ArtifactRunInFlight
      generationStatus={generationStatus}
      orgSlug={orgSlug}
      variant={variant}
    />
  );
}
