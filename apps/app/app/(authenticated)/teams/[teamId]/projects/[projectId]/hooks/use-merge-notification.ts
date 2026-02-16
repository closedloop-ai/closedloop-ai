"use client";

import type { ActivityResponse } from "@repo/api/src/types/activity";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Hook to detect new GITHUB_PR_MERGED events in activity feed and show toast notifications.
 * Seeds seen IDs on first data load so only events arriving after page load trigger toasts.
 */
export function useMergeNotification(
  activityData: ActivityResponse | undefined,
  projectId: string,
  teamId: string
): void {
  const router = useRouter();
  const seenEventIds = useRef<Set<string>>(new Set());
  const initialized = useRef(false);

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

    for (const activity of activityData.activities) {
      // Only process GITHUB_PR_MERGED events we haven't seen before
      if (
        activity.type === "GITHUB_PR_MERGED" &&
        !seenEventIds.current.has(activity.id)
      ) {
        seenEventIds.current.add(activity.id);

        const { prTitle, slug } = activity.metadata as {
          prTitle?: string;
          slug?: string;
        };

        // Build route to implementation plan if we have slug
        const fallbackRoute = `/teams/${teamId}/projects/${projectId}`;
        const artifactRoute = slug
          ? `/implementation-plans/${slug}`
          : fallbackRoute;

        toast.success(prTitle || "Pull request merged", {
          description: "Pull request has been merged",
          action: {
            label: "View Artifact",
            onClick: (event: React.MouseEvent) => {
              event.preventDefault();
              router.push(artifactRoute);
            },
          },
        });
      }
    }
  }, [activityData, projectId, teamId, router]);
}
