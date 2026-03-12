"use client";

import { ArtifactStatus } from "@repo/api/src/types/artifact";
import { useArtifact } from "@/hooks/queries/use-artifacts";
import { useLinkedPlanId } from "@/hooks/queries/use-entity-links";
import type { EngineerTicket } from "@/types/engineer";

/**
 * Resolves the implementation plan artifact for an engineer ticket.
 *
 * For Issue-sourced tickets: follows Issue → EntityLink(PRODUCES) → Artifact.
 * For Implementation Plan tickets: the ticket itself IS the artifact, so we
 * use the ticket's own ID directly.
 */
export function useTicketPlanArtifact(ticket: EngineerTicket) {
  const isDirectPlan = ticket.sourceType === "Implementation Plan";
  const issueId = ticket.issueId ?? "";

  // For Issue-sourced tickets, resolve via entity link chain
  const { linkedPlanId } = useLinkedPlanId(issueId, {
    enabled: !!issueId && !isDirectPlan,
  });

  // For Implementation Plan tickets, the ticket ID is the artifact ID
  const resolvedArtifactId = isDirectPlan ? ticket.id : linkedPlanId;

  const { data: artifact, isLoading: isArtifactLoading } = useArtifact(
    resolvedArtifactId,
    undefined,
    { enabled: !!resolvedArtifactId }
  );

  const isApproved = artifact?.status === ArtifactStatus.Approved;
  const isExecuted = artifact?.status === ArtifactStatus.Executed;
  const isStatusLoaded = !!resolvedArtifactId && !isArtifactLoading;

  return {
    artifactId: resolvedArtifactId || null,
    isApproved,
    isExecuted,
    isStatusLoaded,
    hasLinkedPlan: !!resolvedArtifactId,
  };
}
