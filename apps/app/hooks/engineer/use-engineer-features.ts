"use client";

import {
  type DocumentDetail,
  DocumentType,
  type DocumentWithWorkstream,
  getRoutePrefixForType,
} from "@repo/api/src/types/document";
import type {
  FeatureStatus,
  FeatureWithWorkstream,
} from "@repo/api/src/types/feature";
import type { User } from "@repo/api/src/types/user";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApiClient } from "@/hooks/use-api-client";
import { ApiError } from "@/lib/api-error";
import type { EngineerTicket, EngineerTicketsResult } from "@/types/engineer";
import {
  artifactStatusDisplayName,
  documentTypeToSourceType,
  mapDocumentStatusToType,
  mapFeatureStatusToType,
  priorityToLabel,
  priorityToNumber,
  statusDisplayName,
} from "@/types/engineer";

export type FullTicketDetails = {
  identifier: string;
  title: string;
  description: string;
  url: string;
  featureId?: string;
  additionalContext?: string;
  contextRepoPaths?: string[];
  mentionedFiles?: { repoPath: string; filePath: string }[];
};

export type EngineerFeaturesResultWithUser = EngineerTicketsResult & {
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

/** Map closedloop-dev status names to Symphony FeatureStatus */
function mapToSymphonyStatus(status: string): FeatureStatus {
  const lower = status.toLowerCase();
  if (lower === "done" || lower === "completed") {
    return "DONE";
  }
  if (lower === "in progress" || lower === "started") {
    return "IN_PROGRESS";
  }
  if (lower === "in review") {
    return "IN_REVIEW";
  }
  if (lower === "todo" || lower === "to do" || lower === "unstarted") {
    return "DRAFT";
  }
  return "DRAFT";
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

export function useEngineerFeatures(): EngineerFeaturesResultWithUser {
  const apiClient = useApiClient();

  const [apiUser, setApiUser] = useState<User | null>(null);
  const [apiFeatures, setApiFeatures] = useState<FeatureWithWorkstream[]>([]);
  const [apiArtifacts, setApiArtifacts] = useState<DocumentWithWorkstream[]>(
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
        const [features, artifacts] = await Promise.all([
          apiClient.get<FeatureWithWorkstream[]>(
            `/features?${params.toString()}`
          ),
          apiClient.get<DocumentWithWorkstream[]>(
            `/documents?${params.toString()}&type=${DocumentType.ImplementationPlan}`
          ),
        ]);
        if (cancelled) {
          return;
        }

        setApiFeatures(features);
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
    const featureTickets = apiFeatures.map(apiFeatureToEngineerTicket);
    const artifactTickets = apiArtifacts.map(apiArtifactToEngineerTicket);
    return [...featureTickets, ...artifactTickets];
  }, [apiFeatures, apiArtifacts]);

  const user = apiUser ? toEngineerUser(apiUser) : null;

  const updateTicketStatus = useCallback(
    async (ticketIdentifier: string, status: string): Promise<boolean> => {
      const ticket = tickets.find(
        (candidate) => candidate.identifier === ticketIdentifier
      );
      if (!ticket) {
        throw new Error(`Ticket ${ticketIdentifier} not found`);
      }
      if (!ticket.featureId) {
        return false;
      }

      const symphonyStatus = mapToSymphonyStatus(status);
      try {
        await apiClient.put<FeatureWithWorkstream>(
          `/features/${ticket.featureId}`,
          {
            status: symphonyStatus,
          }
        );
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

      if (ticket && ticket.sourceType !== "Feature") {
        try {
          const detail = await apiClient.get<DocumentDetail>(
            `/documents/${ticket.id}`
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
          featureId: ticket.featureId,
        };
      }

      const feature = await apiClient.get<FeatureWithWorkstream>(
        `/features/${ticketId}`
      );
      return {
        identifier: feature.slug,
        title: feature.title,
        description: feature.description || "",
        url: `/features/${feature.slug}`,
        featureId: feature.id,
      };
    },
    [tickets, apiClient]
  );

  const postComment = useCallback(
    async (ticketIdentifier: string, body: string) => {
      const ticket = tickets.find(
        (candidate) => candidate.identifier === ticketIdentifier
      );
      if (!ticket?.featureId) {
        return;
      }

      try {
        await apiClient.post<{ created: boolean }>(
          `/features/${ticket.featureId}/comments`,
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

function apiFeatureToEngineerTicket(
  feature: FeatureWithWorkstream
): EngineerTicket {
  const assignee = feature.assignee
    ? {
        id: feature.assignee.id,
        name: toDisplayName(
          feature.assignee.firstName,
          feature.assignee.lastName
        ),
        email: feature.assignee.email,
        avatarUrl: feature.assignee.avatarUrl ?? undefined,
      }
    : undefined;

  return {
    id: feature.id,
    identifier: feature.slug,
    title: feature.title,
    description: feature.description ?? undefined,
    sourceType: "Feature",
    status: {
      id: feature.status,
      name: statusDisplayName(feature.status),
      type: mapFeatureStatusToType(feature.status),
    },
    assignee,
    priority: priorityToNumber(feature.priority),
    priorityLabel: priorityToLabel(feature.priority),
    createdAt: toTimestamp(feature.createdAt),
    updatedAt: toTimestamp(feature.updatedAt),
    url: `/features/${feature.slug}`,
    featureId: feature.id,
    projectName: feature.project?.name ?? undefined,
    workstreamTitle: feature.workstream?.title ?? undefined,
  };
}

function apiArtifactToEngineerTicket(
  artifact: DocumentWithWorkstream
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

  const routePrefix = getRoutePrefixForType(artifact.type) ?? "documents";

  return {
    id: artifact.id,
    identifier: artifact.slug,
    title: artifact.title,
    description: artifact.snippet ?? undefined,
    sourceType: documentTypeToSourceType(artifact.type),
    status: {
      id: artifact.status,
      name: artifactStatusDisplayName(artifact.status),
      type: mapDocumentStatusToType(artifact.status),
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
