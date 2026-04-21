"use client";

import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ChatDrawerPanel } from "@/components/chat/ChatDrawerPanel";
import { buildDocumentChatContext } from "@/lib/chat/contexts/document-context";
import { useElectronDetection } from "@/lib/engineer/electron-detection";
import {
  getHealthCheckTargetKey,
  healthCheckOptions,
} from "@/lib/engineer/queries/health-check";
import { repoPathOptions } from "@/lib/engineer/queries/repo-path";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";

export type DocumentChatDrawerProps = {
  documentId: string;
  documentSlug: string;
  documentTitle: string;
  documentType: string;
  targetRepo?: string | null;
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
  targetRepo,
  fillParent = false,
}: Readonly<DocumentChatDrawerProps>) {
  const routing = useEngineerRoutingSelection();
  const healthCheckTargetKey = getHealthCheckTargetKey(routing);
  const healthCheckQuery = useQuery(healthCheckOptions(healthCheckTargetKey));
  const mcpAvailability = healthCheckQuery.data?.mcpServers?.claude ?? null;

  const electronDetection = useElectronDetection(
    routing.mode === EngineerRoutingMode.LocalElectron
  );
  const routingKey = `${routing.mode}:${routing.computeTargetId ?? "none"}`;
  const routeable =
    (routing.mode === EngineerRoutingMode.LocalElectron &&
      electronDetection.detected) ||
    (routing.mode === EngineerRoutingMode.CloudRelay &&
      routing.computeTargetId !== null);

  const repoPathQuery = useQuery({
    ...repoPathOptions(targetRepo ?? null, routingKey),
    enabled: !!targetRepo && routeable,
  });
  const repoPath = repoPathQuery.data?.path ?? null;
  const notice =
    repoPathQuery.isSuccess && repoPath === null && !!targetRepo
      ? "No local checkout was found for this repo. Chat will continue without filesystem access."
      : null;

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
      cwd={repoPath ?? undefined}
      fillParent={fillParent}
      notice={notice}
      welcomeMessage={welcomeMessage}
    />
  );
}
