"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { useLinkedPlanId } from "@repo/app/documents/hooks/use-artifact-links";

/**
 * Derives issue workflow state from the FEATURE-subtyped document's entity links.
 *
 * Centralizes the plan-link query and derived values (`hasPlan`,
 * `linkedPlanId`) so issue-editor, PlanSection, and BranchesSection don't each
 * compute them independently.
 */
export function useIssueState(
  feature: DocumentDetail,
  options?: { enabled?: boolean }
) {
  const { resolvedLinks, linkedPlanLink, linkedPlanId } = useLinkedPlanId(
    feature.id,
    options
  );

  const hasPlan = !!linkedPlanId;

  return {
    resolvedLinks,
    linkedPlanLink,
    linkedPlanId,
    hasPlan,
  };
}
