"use client";

import { DocumentStatus } from "@repo/api/src/types/document";
import { useLinkedPlanId } from "@/hooks/queries/use-artifact-links";
import { useDocument } from "@/hooks/queries/use-documents";
import { type EngineerTicket, TicketSourceType } from "@/types/engineer";

/**
 * Resolves the implementation plan document for an engineer ticket.
 *
 * For Feature-sourced tickets: follows Feature → EntityLink(PRODUCES) → Document.
 * For Implementation Plan tickets: the ticket itself IS the document, so we
 * use the ticket's own ID directly.
 */
export function useTicketPlanDocument(ticket: EngineerTicket) {
  const isDirectPlan =
    ticket.sourceType === TicketSourceType.ImplementationPlan;
  const featureId = ticket.featureId ?? "";

  // For Feature-sourced tickets, resolve via entity link chain
  const { linkedPlanId } = useLinkedPlanId(featureId, {
    enabled: !!featureId && !isDirectPlan,
  });

  // For Implementation Plan tickets, the ticket ID is the document ID
  const resolvedDocumentId = isDirectPlan ? ticket.id : linkedPlanId;

  const { data: doc, isLoading: isDocumentLoading } = useDocument(
    resolvedDocumentId,
    undefined,
    { enabled: !!resolvedDocumentId }
  );

  const isApproved = doc?.status === DocumentStatus.Approved;
  const isExecuted = doc?.status === DocumentStatus.Executed;
  const isStatusLoaded = !!resolvedDocumentId && !isDocumentLoading;

  return {
    documentId: resolvedDocumentId || null,
    isApproved,
    isExecuted,
    isStatusLoaded,
    hasLinkedPlan: !!resolvedDocumentId,
  };
}
