"use client";

import { EntityType } from "@repo/api/src/types/entity-link";
import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { useMemo } from "react";
import type { PlanSource } from "@/app/(authenticated)/implementation-plans/components/plan-source";
import { useLinkedPlanId } from "@/hooks/queries/use-entity-links";

/**
 * Derives feature workflow state from the issue's entity links.
 *
 * Centralizes the plan-link query and derived booleans (`hasPlan`, `isReady`,
 * `linkedPlanId`) so that feature-page, PlanSection, and BranchesSection
 * don't each compute them independently.
 */
export function useFeatureState(issue: IssueWithWorkstream) {
  const { targetLinks, linkedPlanLink, linkedPlanId } = useLinkedPlanId(
    issue.id
  );

  const hasPlan = !!linkedPlanId;
  const isReady = !!issue.description?.trim();

  const newPlanSource: PlanSource = useMemo(() => {
    return {
      ...issue,
      sourceType: EntityType.Issue,
    };
  }, [issue]);

  return {
    targetLinks,
    linkedPlanLink,
    linkedPlanId,
    hasPlan,
    isReady,
    newPlanSource,
  };
}
