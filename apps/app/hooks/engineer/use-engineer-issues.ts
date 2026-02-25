"use client";

import { getRoutePrefixForType } from "@repo/api/src/types/artifact";
import type { IssueStatus } from "@repo/api/src/types/issue";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEngineerMcp } from "@/contexts/engineer-mcp-context";
import { McpScopeError } from "@/hooks/engineer/use-mcp-client";
import type {
  EngineerTicket,
  EngineerTicketsResult,
  McpArtifact,
  McpIssue,
  McpUser,
} from "@/types/engineer";
import {
  artifactStatusDisplayName,
  artifactTypeToSourceType,
  mapArtifactStatusToType,
  mapIssueStatusToType,
  priorityToLabel,
  priorityToNumber,
  statusDisplayName,
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
  ) => Promise<boolean>;
  getFullTicket: (ticketId: string) => Promise<FullTicketDetails>;
  postComment: (ticketIdentifier: string, body: string) => Promise<void>;
};

/** Map closedloop-dev status names to Symphony IssueStatus */
function mapToSymphonyStatus(status: string): IssueStatus {
  const lower = status.toLowerCase();
  if (lower === "done" || lower === "completed") {
    return "COMPLETED";
  }
  if (lower === "in progress" || lower === "started") {
    return "IN_PROGRESS";
  }
  if (lower === "in review") {
    return "IN_REVIEW";
  }
  if (lower === "todo" || lower === "to do" || lower === "unstarted") {
    return "NOT_STARTED";
  }
  return "NOT_STARTED";
}

/**
 * Hook to fetch Symphony issues and PRDs assigned to/owned by the current user
 * via the MCP server. Drop-in replacement — same return shape as before.
 */
export function useEngineerIssues(): EngineerIssuesResultWithUser {
  const mcp = useEngineerMcp();

  const [mcpUser, setMcpUser] = useState<McpUser | null>(null);
  const [mcpIssues, setMcpIssues] = useState<McpIssue[]>([]);
  const [mcpArtifacts, setMcpArtifacts] = useState<McpArtifact[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [refetchCounter, setRefetchCounter] = useState(0);

  // Holds resolve callbacks for pending refetch() promises
  const refetchResolversRef = useRef<Array<() => void>>([]);

  // Track previous ready state to avoid refetching on every render
  const prevReadyRef = useRef(false);

  // Fetch data when MCP becomes ready or refetchCounter changes
  useEffect(() => {
    if (!mcp.isReady) {
      // Reset loading state when MCP disconnects
      if (prevReadyRef.current) {
        setIsLoading(true);
        prevReadyRef.current = false;
      }
      return;
    }
    prevReadyRef.current = true;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    async function fetchAll() {
      setIsFetching(true);
      setError(null);
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= 2; attempt++) {
        if (cancelled) {
          return;
        }
        try {
          // Step 1: fetch current user
          const user = await mcp.getMe();
          if (cancelled) {
            return;
          }
          setMcpUser(user);

          // Step 2: fetch all pages of issues and artifacts in parallel
          const [allIssues, allArtifacts] = await Promise.all([
            fetchAllMcpPages((offset) =>
              mcp.listIssues({ assigneeId: user.id, limit: 100, offset })
            ),
            fetchAllMcpPages((offset) =>
              mcp.listArtifacts({ assigneeId: user.id, limit: 100, offset })
            ),
          ]);
          if (cancelled) {
            return;
          }

          setMcpIssues(allIssues);
          setMcpArtifacts(allArtifacts);
          lastError = null;
          break;
        } catch (err) {
          if (cancelled) {
            return;
          }
          const msg = err instanceof Error ? err.message : "";
          if (attempt < 2 && msg.includes("not ready")) {
            await new Promise<void>((resolve) => {
              retryTimer = setTimeout(resolve, 500);
            });
            continue;
          }
          lastError =
            err instanceof Error ? err : new Error("Failed to fetch data");
          break;
        }
      }

      if (!cancelled) {
        if (lastError) {
          setError(lastError);
        }
        setIsLoading(false);
        setIsFetching(false);

        // Settle all pending refetch() promises
        refetchResolversRef.current.splice(0).forEach((r) => r());
      }
    }

    fetchAll();
    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      // Settle any pending refetch() promises so callers don't hang
      refetchResolversRef.current.splice(0).forEach((r) => r());
    };
  }, [mcp.isReady, refetchCounter]);

  // Combine issues and artifacts into tickets
  const tickets: EngineerTicket[] = useMemo(() => {
    const issueTickets = mcpIssues.map(mcpIssueToEngineerTicket);
    const artifactTickets = mcpArtifacts.map(mcpArtifactToEngineerTicket);
    return [...issueTickets, ...artifactTickets];
  }, [mcpIssues, mcpArtifacts]);

  const user = mcpUser
    ? {
        id: mcpUser.id,
        name: [mcpUser.firstName, mcpUser.lastName].filter(Boolean).join(" "),
        email: mcpUser.email,
        avatarUrl: mcpUser.avatarUrl ?? undefined,
      }
    : null;

  // Update issue status via MCP
  const updateTicketStatus = useCallback(
    async (ticketIdentifier: string, status: string): Promise<boolean> => {
      const ticket = tickets.find((t) => t.identifier === ticketIdentifier);
      if (!ticket) {
        throw new Error(`Ticket ${ticketIdentifier} not found`);
      }

      if (!ticket.issueId) {
        return false;
      }

      const symphonyStatus = mapToSymphonyStatus(status);
      try {
        await mcp.updateIssue(ticket.issueId, { status: symphonyStatus });
        return true;
      } catch (err) {
        if (err instanceof McpScopeError) {
          return false;
        }
        throw err;
      }
    },
    [tickets, mcp]
  );

  // Get full ticket details — fetch full content for artifacts via MCP
  const getFullTicket = useCallback(
    async (ticketId: string): Promise<FullTicketDetails> => {
      const ticket = tickets.find(
        (t) => t.id === ticketId || t.identifier === ticketId
      );

      // For artifact-sourced tickets, fetch full content via get-artifact
      if (ticket && ticket.sourceType !== "Issue") {
        try {
          const detail = await mcp.getArtifact(ticket.id);
          return {
            identifier: ticket.identifier,
            title: ticket.title,
            description: detail.version.content || ticket.description || "",
            url: ticket.url,
          };
        } catch (err) {
          console.warn(
            `[getFullTicket] Failed to fetch artifact content for ${ticket.identifier}, using snippet:`,
            err
          );
          return {
            identifier: ticket.identifier,
            title: ticket.title,
            description: ticket.description || "",
            url: ticket.url,
          };
        }
      }

      // Issue-sourced tickets already have full description from list endpoint
      if (ticket) {
        return {
          identifier: ticket.identifier,
          title: ticket.title,
          description: ticket.description || "",
          url: ticket.url,
        };
      }

      // Fetch from MCP if not in local cache
      const issue = await mcp.getIssue(ticketId);
      return {
        identifier: issue.slug,
        title: issue.title,
        description: issue.description || "",
        url: `/issues/${issue.slug}`,
      };
    },
    [tickets, mcp]
  );

  // Post a comment via MCP
  const postComment = useCallback(
    async (ticketIdentifier: string, body: string) => {
      const ticket = tickets.find((t) => t.identifier === ticketIdentifier);
      if (!ticket) {
        console.warn(
          `[postComment] Ticket ${ticketIdentifier} not found, skipping`
        );
        return;
      }

      if (!ticket.issueId) {
        console.warn(
          `[postComment] Ticket ${ticketIdentifier} is not an issue, skipping`
        );
        return;
      }

      try {
        await mcp.createIssueComment(ticket.issueId, body);
      } catch (err) {
        if (err instanceof McpScopeError) {
          console.warn(
            "[postComment] Write not available (read-only key), skipping"
          );
          return;
        }
        console.error(
          `[postComment] Failed to post comment on ${ticketIdentifier}:`,
          err
        );
      }
    },
    [tickets, mcp]
  );

  // Disconnect MCP and navigate home
  const logout = useCallback(() => {
    mcp.disconnect();
    globalThis.location.href = "/";
  }, [mcp]);

  // Trigger a refetch — returned promise settles when the fetch completes
  const refetch = useCallback(() => {
    if (!mcp.isReady) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      refetchResolversRef.current.push(resolve);
      setRefetchCounter((c) => c + 1);
    });
  }, [mcp.isReady]);

  return {
    tickets,
    isLoading: isLoading || !mcp.isReady,
    isFetching,
    error,
    refetch,
    user,
    logout,
    updateTicketStatus,
    getFullTicket,
    postComment,
  };
}

// ---------------------------------------------------------------------------
// MCP → EngineerTicket mapping functions
// ---------------------------------------------------------------------------

function mcpIssueToEngineerTicket(issue: McpIssue): EngineerTicket {
  const assignee = issue.assignee
    ? {
        id: issue.assignee.id ?? "",
        name: [issue.assignee.firstName, issue.assignee.lastName]
          .filter(Boolean)
          .join(" "),
        email: "",
        avatarUrl: issue.assignee.avatarUrl ?? undefined,
      }
    : undefined;

  return {
    id: issue.id,
    identifier: issue.slug,
    title: issue.title,
    description: issue.description ?? undefined,
    sourceType: "Issue",
    status: {
      id: issue.status,
      name: statusDisplayName(issue.status),
      type: mapIssueStatusToType(issue.status),
    },
    assignee,
    priority: priorityToNumber(issue.priority),
    priorityLabel: priorityToLabel(issue.priority),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: `/issues/${issue.slug}`,
    issueId: issue.id,
    projectName: issue.project?.name ?? undefined,
    workstreamTitle: issue.workstream?.title ?? undefined,
  };
}

function mcpArtifactToEngineerTicket(artifact: McpArtifact): EngineerTicket {
  const assignee = artifact.assignee
    ? {
        id: artifact.assignee.id ?? "",
        name: [artifact.assignee.firstName, artifact.assignee.lastName]
          .filter(Boolean)
          .join(" "),
        email: "",
        avatarUrl: artifact.assignee.avatarUrl ?? undefined,
      }
    : undefined;

  const routePrefix = getRoutePrefixForType(artifact.type) ?? "artifacts";

  return {
    id: artifact.id,
    identifier: artifact.slug,
    title: artifact.title,
    description: artifact.snippet ?? undefined,
    sourceType: artifactTypeToSourceType(artifact.type),
    status: {
      id: artifact.status,
      name: artifactStatusDisplayName(artifact.status),
      type: mapArtifactStatusToType(artifact.status),
    },
    assignee,
    priority: 3,
    priorityLabel: "Medium",
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    url: `/${routePrefix}/${artifact.slug}`,
    projectName: artifact.project?.name ?? undefined,
    workstreamTitle: artifact.workstream?.title ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------

async function fetchAllMcpPages<T>(
  fetchPage: (offset: number) => Promise<{
    items: T[];
    hasMore: boolean;
    nextOffset: number | null;
  }>
): Promise<T[]> {
  const allItems: T[] = [];
  let offset = 0;
  while (true) {
    const page = await fetchPage(offset);
    allItems.push(...page.items);
    if (!page.hasMore || page.nextOffset === null) {
      break;
    }
    offset = page.nextOffset;
  }
  return allItems;
}
