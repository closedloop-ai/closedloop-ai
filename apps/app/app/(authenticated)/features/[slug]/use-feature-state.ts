"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { useMemo } from "react";
import type { PlanSource } from "@/app/(authenticated)/implementation-plans/components/plan-source";
import { useLinkedPlanId } from "@/hooks/queries/use-artifact-links";

/**
 * Derives feature workflow state from the feature-typed document's entity links.
 *
 * Centralizes the plan-link query and derived booleans (`hasPlan`, `isReady`,
 * `linkedPlanId`) so feature-page, PlanSection, and BranchesSection don't each
 * compute them independently.
 */
export function useFeatureState(feature: DocumentDetail) {
  const { resolvedLinks, linkedPlanLink, linkedPlanId } = useLinkedPlanId(
    feature.id
  );

  const hasPlan = !!linkedPlanId;
  const isReady = !!feature.version.content?.trim();

  const newPlanSource: PlanSource = useMemo(() => {
    return {
      id: feature.id,
      title: feature.title,
      projectId: feature.projectId,
      workstreamId: feature.workstreamId,
    };
  }, [feature.id, feature.title, feature.projectId, feature.workstreamId]);

  return {
    resolvedLinks,
    linkedPlanLink,
    linkedPlanId,
    hasPlan,
    isReady,
    newPlanSource,
  };
}
