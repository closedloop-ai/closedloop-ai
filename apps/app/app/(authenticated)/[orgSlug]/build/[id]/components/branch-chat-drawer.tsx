"use client";

import { buildBranchChatContext } from "@repo/app/chat/lib/contexts/branch-context";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ChatDrawerPanel } from "@/components/chat/ChatDrawerPanel";
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
  /**
   * Render the chat panel without the standard border and width so it
   * fills its parent. Used when the drawer is mounted inside the
   * FeedSidebar's chat tab slot.
   */
  fillParent?: boolean;
  onClearComment?: () => void;
  showFilesystemNotice: boolean;
  worktreePath: string | null;
};

function getBranchWelcomeMessage(prTitle: string): string {
  return `Ask me anything about the branch "${prTitle}".`;
}

export function BranchChatDrawer({
  data,
  contextSelection,
  fillParent = false,
  onClearComment,
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
    ? "No local checkout was found for this branch. Chat will continue without filesystem access."
    : null;
  const contextSlot = contextSelection ? (
    <PrCommentContextCard context={contextSelection} />
  ) : null;

  return (
    <ChatDrawerPanel
      chatKey={chatKey}
      context={context}
      contextSelection={contextSelection}
      contextSlot={contextSlot}
      cwd={worktreePath ?? undefined}
      fillParent={fillParent}
      notice={notice}
      onContextConsumed={() => onClearComment?.()}
      welcomeMessage={welcomeMessage}
    />
  );
}
