"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ChatDrawerPanel } from "@/components/chat/ChatDrawerPanel";
import { buildArtifactChatContext } from "@/lib/chat/contexts/artifact-context";
import {
  getHealthCheckTargetKey,
  healthCheckOptions,
} from "@/lib/engineer/queries/health-check";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";

export type ArtifactChatDrawerProps = {
  artifactId: string;
  artifactSlug: string;
  artifactTitle: string;
  artifactType: string;
};

const ARTIFACT_LABELS: Record<string, string> = {
  plan: "this plan",
  prd: "this PRD",
  issue: "this issue",
  feature: "this feature",
};

function getArtifactWelcomeMessage(artifactType: string): string {
  const label = ARTIFACT_LABELS[artifactType] ?? "this artifact";
  return `Ask me anything about ${label}.`;
}

export function ArtifactChatDrawer({
  artifactId,
  artifactSlug,
  artifactTitle,
  artifactType,
}: Readonly<ArtifactChatDrawerProps>) {
  const routing = useEngineerRoutingSelection();
  const healthCheckTargetKey = getHealthCheckTargetKey(routing);
  const healthCheckQuery = useQuery(healthCheckOptions(healthCheckTargetKey));
  const mcpAvailability = healthCheckQuery.data?.mcpServers?.claude ?? null;

  const context = useMemo(() => {
    const url = globalThis.window === undefined ? "" : globalThis.location.href;
    return buildArtifactChatContext(
      {
        type: artifactType,
        slug: artifactSlug,
        title: artifactTitle,
        url,
      },
      mcpAvailability
    );
  }, [artifactType, artifactSlug, artifactTitle, mcpAvailability]);

  const chatKey = `artifact:${artifactId}`;
  const welcomeMessage = getArtifactWelcomeMessage(artifactType);

  return (
    <ChatDrawerPanel
      chatKey={chatKey}
      context={context}
      welcomeMessage={welcomeMessage}
    />
  );
}
