"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { EntityType } from "@repo/api/src/types/entity-link";
import { useMemo } from "react";
import type { PlanSource } from "@/app/(authenticated)/implementation-plans/components/plan-source";
import { useLinkedPlanId } from "@/hooks/queries/use-entity-links";

/**
 * Derives feature workflow state from the feature-typed document's entity links.
 *
 * Centralizes the plan-link query and derived booleans (`hasPlan`, `isReady`,
 * `linkedPlanId`) so feature-page, PlanSection, and BranchesSection don't each
 * compute them independently.
 */
export function useFeatureState(feature: DocumentDetail) {
  const { targetLinks, linkedPlanLink, linkedPlanId } = useLinkedPlanId(
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
      sourceType: EntityType.Document,
    };
  }, [feature.id, feature.title, feature.projectId, feature.workstreamId]);

  return {
    targetLinks,
    linkedPlanLink,
    linkedPlanId,
    hasPlan,
    isReady,
    newPlanSource,
  };
}
