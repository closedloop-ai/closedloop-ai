"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useArtifacts } from "@/hooks/queries/use-artifacts";
import { useIssues, useUpdateIssue } from "@/hooks/queries/use-issues";
import { useCurrentUser } from "@/hooks/queries/use-users";
import { useApiClient } from "@/hooks/use-api-client";
import {
  artifactToEngineerTicket,
  type EngineerTicket,
  type EngineerTicketsResult,
  issueToEngineerTicket,
} from "@/types/engineer";

export type FullTicketDetails = {
  identifier: string;
  title: string;
  description: string;
  url: string;
  additionalContext?: string;
  contextRepoPaths?: string[];
  mentionedFiles?: { repoPath: string; filePath: string }[];
};

export type EngineerIssuesResultWithUser = EngineerTicketsResult & {
  isFetching: boolean;
  user: { id: string; name: string; email: string; avatarUrl?: string } | null;
  logout: () => void;
  updateTicketStatus: (
    ticketIdentifier: string,
    status: string
  ) => Promise<void>;
  getFullTicket: (ticketId: string) => Promise<FullTicketDetails>;
  postComment: (ticketIdentifier: string, body: string) => Promise<void>;
};

/** Map closedloop-dev status names to Symphony IssueStatus */
function mapToSymphonyStatus(
  status: string
): "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "CLOSED" {
  const lower = status.toLowerCase();
  if (lower === "done" || lower === "completed") {
    return "CLOSED";
  }
  if (lower === "in progress" || lower === "started") {
    return "IN_PROGRESS";
  }
  if (lower === "in review") {
    return "IN_REVIEW";
  }
  if (lower === "todo" || lower === "to do" || lower === "unstarted") {
    return "TODO";
  }
  return "TODO";
}

/**
 * Hook to fetch Symphony issues and PRDs assigned to/owned by the current user.
 * Drop-in replacement for useEngineerTickets — same return shape.
 */
export function useEngineerIssues(): EngineerIssuesResultWithUser {
  const { data: currentUser, isLoading: isUserLoading } = useCurrentUser();
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const updateIssueMutation = useUpdateIssue();

  // Fetch issues assigned to the current user
  const {
    data: issues = [],
    isLoading: isIssuesLoading,
    isFetching: isIssuesFetching,
    error: issuesError,
    refetch: refetchIssues,
  } = useIssues(
    { assigneeId: currentUser?.id },
    { enabled: !!currentUser?.id }
  );

  // Fetch PRDs owned by the current user
  const {
    data: artifacts = [],
    isLoading: isArtifactsLoading,
    isFetching: isArtifactsFetching,
    error: artifactsError,
    refetch: refetchArtifacts,
  } = useArtifacts(
    { ownerId: currentUser?.id },
    { enabled: !!currentUser?.id }
  );

  // Combine issues and PRDs into a single tickets list
  const tickets: EngineerTicket[] = useMemo(() => {
    const issueTickets = issues.map(issueToEngineerTicket);
    const artifactTickets = artifacts.map(artifactToEngineerTicket);
    return [...issueTickets, ...artifactTickets];
  }, [issues, artifacts]);

  const isLoading = isUserLoading || isIssuesLoading || isArtifactsLoading;
  const isFetching = isIssuesFetching || isArtifactsFetching;
  const error =
    (issuesError instanceof Error ? issuesError : null) ??
    (artifactsError instanceof Error ? artifactsError : null);

  const user = currentUser
    ? {
        id: currentUser.id,
        name: [currentUser.firstName, currentUser.lastName]
          .filter(Boolean)
          .join(" "),
        email: currentUser.email,
        avatarUrl: currentUser.avatarUrl ?? undefined,
      }
    : null;

  // Update issue status in Symphony
  const updateTicketStatus = useCallback(
    async (ticketIdentifier: string, status: string) => {
      const ticket = tickets.find((t) => t.identifier === ticketIdentifier);
      if (!ticket) {
        throw new Error(`Ticket ${ticketIdentifier} not found`);
      }

      const symphonyStatus = mapToSymphonyStatus(status);
      await updateIssueMutation.mutateAsync({
        id: ticket.issueId,
        status: symphonyStatus,
      });
    },
    [tickets, updateIssueMutation]
  );

  // Get full ticket details
  const getFullTicket = useCallback(
    async (ticketId: string): Promise<FullTicketDetails> => {
      const ticket = tickets.find(
        (t) => t.id === ticketId || t.identifier === ticketId
      );
      if (ticket) {
        return {
          identifier: ticket.identifier,
          title: ticket.title,
          description: ticket.description || "",
          url: ticket.url,
        };
      }

      // Fetch from API if not in local cache
      const issue = await apiClient.get<{
        id: string;
        slug: string;
        title: string;
        description: string | null;
      }>(`/issues/${ticketId}`);

      return {
        identifier: issue.slug,
        title: issue.title,
        description: issue.description || "",
        url: `/issues/${issue.slug}`,
      };
    },
    [tickets, apiClient]
  );

  // Post a comment on an issue (fire-and-forget)
  const postComment = useCallback(
    async (ticketIdentifier: string, body: string) => {
      const ticket = tickets.find((t) => t.identifier === ticketIdentifier);
      if (!ticket) {
        console.warn(
          `[postComment] Ticket ${ticketIdentifier} not found, skipping`
        );
        return;
      }

      try {
        await apiClient.post(`/issues/${ticket.issueId}/comments`, { body });
      } catch (err) {
        console.error(
          `[postComment] Failed to post comment on ${ticketIdentifier}:`,
          err
        );
      }
    },
    [tickets, apiClient]
  );

  // Logout is a no-op since we use Clerk auth
  const logout = useCallback(() => {
    queryClient.clear();
    window.location.href = "/";
  }, [queryClient]);

  return {
    tickets,
    isLoading,
    isFetching,
    error,
    refetch: async () => {
      await Promise.all([refetchIssues(), refetchArtifacts()]);
    },
    user,
    logout,
    updateTicketStatus,
    getFullTicket,
    postComment,
  };
}
