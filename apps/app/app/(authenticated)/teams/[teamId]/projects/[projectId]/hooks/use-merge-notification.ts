"use client";

import type { ActivityResponse } from "@repo/api/src/types/activity";
import type { ExternalLink } from "@repo/api/src/types/external-link";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { documentKeys } from "@/hooks/queries/use-documents";
import { useApiClient } from "@/hooks/use-api-client";

type MergeMetadata = {
  prTitle?: string;
  slug?: string;
  documentId?: string;
};

function showMergeToast(
  activity: ActivityResponse["activities"][number],
  previewDeploymentMap: Map<string, ExternalLink>,
  projectId: string,
  teamId: string
): void {
  const {
    prTitle,
    slug,
    documentId: eventArtifactId,
  } = activity.metadata as MergeMetadata;

  const fallbackRoute = `/teams/${teamId}/projects/${projectId}`;
  const artifactRoute = slug ? `/implementation-plans/${slug}` : fallbackRoute;

  const previewDeployment = eventArtifactId
    ? previewDeploymentMap.get(eventArtifactId)
    : undefined;
  const hasPreview = !!previewDeployment?.externalUrl;

  const description = hasPreview
    ? `Preview deployment: ${previewDeployment.externalUrl}`
    : "Pull request has been merged";

  toast.success(prTitle || "Pull request merged", {
    description,
    action: {
      label: hasPreview ? "View Preview" : "View Artifact",
      onClick: (event: React.MouseEvent) => {
        event.preventDefault();
        if (hasPreview) {
          window.open(previewDeployment.externalUrl, "_blank");
        } else {
          window.open(artifactRoute, "_blank");
        }
      },
    },
  });
}

/**
 * Hook to detect new GITHUB_PR_MERGED events in activity feed and show toast notifications.
 * Seeds seen IDs on first data load so only events arriving after page load trigger toasts.
 */
export function useMergeNotification(
  activityData: ActivityResponse | undefined,
  projectId: string,
  teamId: string
): void {
  const seenEventIds = useRef<Set<string>>(new Set());
  const initialized = useRef(false);
  const apiClient = useApiClient();

  // Extract documentIds from ALL unseen GITHUB_PR_MERGED events
  const unseenArtifactIds = useMemo(() => {
    if (!activityData?.activities) {
      return [];
    }

    const ids: string[] = [];
    for (const activity of activityData.activities) {
      if (
        activity.type === "GITHUB_PR_MERGED" &&
        !seenEventIds.current.has(activity.id)
      ) {
        const documentId = (activity.metadata as MergeMetadata)?.documentId;
        if (documentId) {
          ids.push(documentId);
        }
      }
    }
    return ids;
  }, [activityData]);

  // Fetch preview deployments for all unseen merge events
  const previewDeploymentQueries = useQueries({
    queries: unseenArtifactIds.map((documentId) => ({
      queryKey: documentKeys.previewDeployment(documentId),
      queryFn: () =>
        apiClient.get<ExternalLink | null>(
          `/documents/${documentId}/preview-deployment`
        ),
      enabled: !!documentId,
      staleTime: 0, // Always fetch fresh
    })),
  });

  // Build documentId → previewDeployment map
  const queryData = previewDeploymentQueries.map((q) => q.data);
  const previewDeploymentMap = useMemo(() => {
    const map = new Map<string, ExternalLink>();
    for (let i = 0; i < unseenArtifactIds.length; i++) {
      const documentId = unseenArtifactIds[i];
      const data = queryData[i];
      if (data?.externalUrl) {
        map.set(documentId, data);
      }
    }
    return map;
  }, [unseenArtifactIds, queryData]);

  useEffect(() => {
    if (!activityData?.activities) {
      return;
    }

    // On first load, seed all existing event IDs without toasting
    if (!initialized.current) {
      initialized.current = true;
      for (const activity of activityData.activities) {
        seenEventIds.current.add(activity.id);
      }
      return;
    }

    // Wait for all preview deployment queries to finish before showing toasts
    if (
      unseenArtifactIds.length > 0 &&
      previewDeploymentQueries.some((q) => q.isLoading)
    ) {
      return;
    }

    for (const activity of activityData.activities) {
      if (
        activity.type === "GITHUB_PR_MERGED" &&
        !seenEventIds.current.has(activity.id)
      ) {
        seenEventIds.current.add(activity.id);
        showMergeToast(activity, previewDeploymentMap, projectId, teamId);
      }
    }
  }, [
    activityData,
    projectId,
    teamId,
    previewDeploymentMap,
    unseenArtifactIds,
    previewDeploymentQueries,
  ]);
}
