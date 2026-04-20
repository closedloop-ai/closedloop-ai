"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ChatDrawerPanel } from "@/components/chat/ChatDrawerPanel";
import { buildDocumentChatContext } from "@/lib/chat/contexts/document-context";
import {
  getHealthCheckTargetKey,
  healthCheckOptions,
} from "@/lib/engineer/queries/health-check";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";

export type DocumentChatDrawerProps = {
  documentId: string;
  documentSlug: string;
  documentTitle: string;
  documentType: string;
  fillParent?: boolean;
};

const DOCUMENT_LABELS: Record<string, string> = {
  plan: "this plan",
  prd: "this PRD",
  issue: "this issue",
  feature: "this feature",
};

function getDocumentWelcomeMessage(documentType: string): string {
  const label = DOCUMENT_LABELS[documentType] ?? "this document";
  return `Ask me anything about ${label}.`;
}

export function DocumentChatDrawer({
  documentId,
  documentSlug,
  documentTitle,
  documentType,
  fillParent = false,
}: Readonly<DocumentChatDrawerProps>) {
  const routing = useEngineerRoutingSelection();
  const healthCheckTargetKey = getHealthCheckTargetKey(routing);
  const healthCheckQuery = useQuery(healthCheckOptions(healthCheckTargetKey));
  const mcpAvailability = healthCheckQuery.data?.mcpServers?.claude ?? null;

  const context = useMemo(() => {
    const url = globalThis.window === undefined ? "" : globalThis.location.href;
    return buildDocumentChatContext(
      {
        type: documentType,
        slug: documentSlug,
        title: documentTitle,
        url,
      },
      mcpAvailability
    );
  }, [documentType, documentSlug, documentTitle, mcpAvailability]);

  const chatKey = `artifact:${documentId}`;
  const welcomeMessage = getDocumentWelcomeMessage(documentType);

  return (
    <ChatDrawerPanel
      chatKey={chatKey}
      context={context}
      fillParent={fillParent}
      welcomeMessage={welcomeMessage}
    />
  );
}
