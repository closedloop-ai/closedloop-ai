"use client";

import { ArtifactStatus } from "@repo/api/src/types/artifact";
import { useArtifact } from "@/hooks/queries/use-artifacts";
import { useLinkedPlanId } from "@/hooks/queries/use-entity-links";
import type { EngineerTicket } from "@/types/engineer";

/**
 * Resolves the linked implementation plan artifact for an engineer ticket.
 *
 * Follows the Issue → EntityLink(PRODUCES) → Artifact lookup chain.
 * Returns the artifact's approval status and ID so callers can drive
 * approve / execute buttons without knowing the entity-link plumbing.
 */
export function useTicketPlanArtifact(ticket: EngineerTicket) {
  const issueId = ticket.issueId ?? "";

  const { linkedPlanId } = useLinkedPlanId(issueId, {
    enabled: !!issueId,
  });

  const { data: artifact, isLoading: isArtifactLoading } = useArtifact(
    linkedPlanId,
    undefined,
    { enabled: !!linkedPlanId }
  );

  const isApproved = artifact?.status === ArtifactStatus.Approved;
  const isExecuted = artifact?.status === ArtifactStatus.Executed;
  const isStatusLoaded = !!linkedPlanId && !isArtifactLoading;

  return {
    artifactId: linkedPlanId || null,
    isApproved,
    isExecuted,
    isStatusLoaded,
    hasLinkedPlan: !!linkedPlanId,
  };
}
