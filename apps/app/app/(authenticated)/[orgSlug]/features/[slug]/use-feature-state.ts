"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { useLinkedPlanId } from "@repo/app/documents/hooks/use-artifact-links";
import { useMemo } from "react";
import type { PlanSource } from "@/app/(authenticated)/[orgSlug]/implementation-plans/components/plan-source";

/**
 * Derives feature workflow state from the feature-typed document's entity links.
 *
 * Centralizes the plan-link query and derived booleans (`hasPlan`, `isReady`,
 * `linkedPlanId`) so feature-editor, PlanSection, and BranchesSection don't each
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
    };
  }, [feature.id, feature.title, feature.projectId]);

  return {
    resolvedLinks,
    linkedPlanLink,
    linkedPlanId,
    hasPlan,
    isReady,
    newPlanSource,
  };
}
