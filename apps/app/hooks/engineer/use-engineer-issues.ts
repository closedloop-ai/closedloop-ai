"use client";

import {
  type ArtifactDetail,
  ArtifactType,
  type ArtifactWithWorkstream,
  getRoutePrefixForType,
} from "@repo/api/src/types/artifact";
import type {
  IssueStatus,
  IssueWithWorkstream,
} from "@repo/api/src/types/issue";
import type { User } from "@repo/api/src/types/user";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApiClient } from "@/hooks/use-api-client";
import { ApiError } from "@/lib/api-error";
import type { EngineerTicket, EngineerTicketsResult } from "@/types/engineer";
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

function toDisplayName(
  firstName?: string | null,
  lastName?: string | null,
  fallback = "Unknown"
): string {
  const name = [firstName, lastName].filter(Boolean).join(" ").trim();
  return name || fallback;
}

function toTimestamp(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

function toEngineerUser(user: {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email: string;
  avatarUrl?: string | null;
}): {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
} {
  return {
    id: user.id,
    name: toDisplayName(user.firstName, user.lastName, user.email),
    email: user.email,
    avatarUrl: user.avatarUrl ?? undefined,
  };
}

export function useEngineerIssues(): EngineerIssuesResultWithUser {
  const apiClient = useApiClient();

  const [apiUser, setApiUser] = useState<User | null>(null);
  const [apiIssues, setApiIssues] = useState<IssueWithWorkstream[]>([]);
  const [apiArtifacts, setApiArtifacts] = useState<ArtifactWithWorkstream[]>(
    []
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [refetchCounter, setRefetchCounter] = useState(0);

  const refetchResolversRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    let cancelled = false;

    async function fetchAll() {
      setIsFetching(true);
      setError(null);
      try {
        const user = await apiClient.get<User>("/me");
        if (cancelled) {
          return;
        }
        setApiUser(user);

        const params = new URLSearchParams({ assigneeId: user.id });
        const [issues, artifacts] = await Promise.all([
          apiClient.get<IssueWithWorkstream[]>(`/issues?${params.toString()}`),
          apiClient.get<ArtifactWithWorkstream[]>(
            `/artifacts?${params.toString()}&type=${ArtifactType.ImplementationPlan}`
          ),
        ]);
        if (cancelled) {
          return;
        }

        setApiIssues(issues);
        setApiArtifacts(artifacts);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err : new Error("Failed to fetch data")
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
          setIsFetching(false);
          refetchResolversRef.current.splice(0).forEach((resolve) => resolve());
        }
      }
    }

    fetchAll();
    return () => {
      cancelled = true;
      refetchResolversRef.current.splice(0).forEach((resolve) => resolve());
    };
  }, [apiClient, refetchCounter]);

  const tickets: EngineerTicket[] = useMemo(() => {
    const issueTickets = apiIssues.map(apiIssueToEngineerTicket);
    const artifactTickets = apiArtifacts.map(apiArtifactToEngineerTicket);
    return [...issueTickets, ...artifactTickets];
  }, [apiIssues, apiArtifacts]);

  const user = apiUser ? toEngineerUser(apiUser) : null;

  const updateTicketStatus = useCallback(
    async (ticketIdentifier: string, status: string): Promise<boolean> => {
      const ticket = tickets.find(
        (candidate) => candidate.identifier === ticketIdentifier
      );
      if (!ticket) {
        throw new Error(`Ticket ${ticketIdentifier} not found`);
      }
      if (!ticket.issueId) {
        return false;
      }

      const symphonyStatus = mapToSymphonyStatus(status);
      try {
        await apiClient.put<IssueWithWorkstream>(`/issues/${ticket.issueId}`, {
          status: symphonyStatus,
        });
        return true;
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.isForbidden() || err.isUnauthorized())
        ) {
          return false;
        }
        throw err;
      }
    },
    [tickets, apiClient]
  );

  const getFullTicket = useCallback(
    async (ticketId: string): Promise<FullTicketDetails> => {
      const ticket = tickets.find(
        (candidate) =>
          candidate.id === ticketId || candidate.identifier === ticketId
      );

      if (ticket && ticket.sourceType !== "Issue") {
        try {
          const detail = await apiClient.get<ArtifactDetail>(
            `/artifacts/${ticket.id}`
          );
          return {
            identifier: ticket.identifier,
            title: ticket.title,
            description: detail.version.content || ticket.description || "",
            url: ticket.url,
          };
        } catch {
          return {
            identifier: ticket.identifier,
            title: ticket.title,
            description: ticket.description || "",
            url: ticket.url,
          };
        }
      }

      if (ticket) {
        return {
          identifier: ticket.identifier,
          title: ticket.title,
          description: ticket.description || "",
          url: ticket.url,
        };
      }

      const issue = await apiClient.get<IssueWithWorkstream>(
        `/issues/${ticketId}`
      );
      return {
        identifier: issue.slug,
        title: issue.title,
        description: issue.description || "",
        url: `/issues/${issue.slug}`,
      };
    },
    [tickets, apiClient]
  );

  const postComment = useCallback(
    async (ticketIdentifier: string, body: string) => {
      const ticket = tickets.find(
        (candidate) => candidate.identifier === ticketIdentifier
      );
      if (!ticket?.issueId) {
        return;
      }

      try {
        await apiClient.post<{ created: boolean }>(
          `/issues/${ticket.issueId}/comments`,
          { body }
        );
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.isForbidden() || err.isUnauthorized())
        ) {
          return;
        }
        console.error(
          `[postComment] Failed to post comment on ${ticketIdentifier}:`,
          err
        );
      }
    },
    [tickets, apiClient]
  );

  const logout = useCallback(() => {
    globalThis.location.href = "/";
  }, []);

  const refetch = useCallback(() => {
    return new Promise<void>((resolve) => {
      refetchResolversRef.current.push(resolve);
      setRefetchCounter((counter) => counter + 1);
    });
  }, []);

  return {
    tickets,
    isLoading,
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

function apiIssueToEngineerTicket(issue: IssueWithWorkstream): EngineerTicket {
  const assignee = issue.assignee
    ? {
        id: issue.assignee.id,
        name: toDisplayName(issue.assignee.firstName, issue.assignee.lastName),
        email: issue.assignee.email,
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
    createdAt: toTimestamp(issue.createdAt),
    updatedAt: toTimestamp(issue.updatedAt),
    url: `/issues/${issue.slug}`,
    issueId: issue.id,
    projectName: issue.project?.name ?? undefined,
    workstreamTitle: issue.workstream?.title ?? undefined,
  };
}

function apiArtifactToEngineerTicket(
  artifact: ArtifactWithWorkstream
): EngineerTicket {
  const assignee = artifact.assignee
    ? {
        id: artifact.assignee.id,
        name: toDisplayName(
          artifact.assignee.firstName,
          artifact.assignee.lastName
        ),
        email: artifact.assignee.email,
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
    createdAt: toTimestamp(artifact.createdAt),
    updatedAt: toTimestamp(artifact.updatedAt),
    url: `/${routePrefix}/${artifact.slug}`,
    projectName: artifact.project?.name ?? undefined,
    workstreamTitle: artifact.workstream?.title ?? undefined,
  };
}
