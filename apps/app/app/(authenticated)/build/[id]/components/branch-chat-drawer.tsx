"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ChatDrawerPanel } from "@/components/chat/ChatDrawerPanel";
import { buildBranchChatContext } from "@/lib/chat/contexts/branch-context";
import {
  getHealthCheckTargetKey,
  healthCheckOptions,
} from "@/lib/engineer/queries/health-check";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";
import type { PrCommentContext } from "../comment-context";
import type { BranchViewData } from "../types";
import { PrCommentContextCard } from "./pr-comment-context-card";

export type BranchChatDrawerProps = {
  data: BranchViewData;
  contextSelection: PrCommentContext | null;
  showFilesystemNotice: boolean;
  worktreePath: string | null;
};

function getBranchWelcomeMessage(prTitle: string): string {
  return `Ask me anything about the pull request "${prTitle}".`;
}

export function BranchChatDrawer({
  data,
  contextSelection,
  showFilesystemNotice,
  worktreePath,
}: Readonly<BranchChatDrawerProps>) {
  const routing = useEngineerRoutingSelection();
  const healthCheckTargetKey = getHealthCheckTargetKey(routing);
  const healthCheckQuery = useQuery(healthCheckOptions(healthCheckTargetKey));
  const mcpAvailability = healthCheckQuery.data?.mcpServers?.claude ?? null;

  const context = useMemo(
    () =>
      buildBranchChatContext(
        {
          externalLinkId: data.externalLinkId,
          prTitle: data.prTitle,
          prHtmlUrl: data.prHtmlUrl,
          repoFullName: data.repoFullName,
          headBranch: data.headBranch,
          baseBranch: data.baseBranch,
          featureSlug: data.featureSlug,
          featureTitle: data.featureTitle,
          producedByPlanSlug: data.producedByPlanSlug,
          producedByPlanTitle: data.producedByPlanTitle,
          worktreePath,
        },
        mcpAvailability
      ),
    [data, worktreePath, mcpAvailability]
  );

  const chatKey = `branch:${data.externalLinkId}`;
  const welcomeMessage = getBranchWelcomeMessage(data.prTitle);
  const notice = showFilesystemNotice
    ? "No local checkout was found for this PR branch. Chat will continue without filesystem access."
    : null;
  const contextSlot = contextSelection ? (
    <PrCommentContextCard context={contextSelection} />
  ) : null;

  return (
    <ChatDrawerPanel
      chatKey={chatKey}
      context={context}
      contextSlot={contextSlot}
      cwd={worktreePath ?? undefined}
      notice={notice}
      welcomeMessage={welcomeMessage}
    />
  );
}
