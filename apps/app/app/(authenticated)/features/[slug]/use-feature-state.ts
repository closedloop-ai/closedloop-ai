"use client";

import { EntityType } from "@repo/api/src/types/entity-link";
import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
import { useMemo } from "react";
import type { PlanSource } from "@/app/(authenticated)/implementation-plans/components/plan-source";
import { useLinkedPlanId } from "@/hooks/queries/use-entity-links";

/**
 * Derives feature workflow state from the feature's entity links.
 *
 * Centralizes the plan-link query and derived booleans (`hasPlan`, `isReady`,
 * `linkedPlanId`) so that feature-page, PlanSection, and BranchesSection
 * don't each compute them independently.
 */
export function useFeatureState(feature: FeatureWithWorkstream) {
  const { targetLinks, linkedPlanLink, linkedPlanId } = useLinkedPlanId(
    feature.id
  );

  const hasPlan = !!linkedPlanId;
  const isReady = !!feature.description?.trim();

  const newPlanSource: PlanSource = useMemo(() => {
    return {
      ...feature,
      sourceType: EntityType.Feature,
    };
  }, [feature]);

  return {
    targetLinks,
    linkedPlanLink,
    linkedPlanId,
    hasPlan,
    isReady,
    newPlanSource,
  };
}
