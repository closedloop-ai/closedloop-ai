"use client";

import {
  type GenerationStatus,
  isActiveGenerationStatus,
} from "@repo/api/src/types/artifact";
import { toast } from "@repo/design-system/components/ui/sonner";
import { ExternalLinkIcon, LoaderIcon, XCircleIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useArtifactGenerationStatus } from "@/hooks/queries/use-artifacts";
import { getStatusMessage } from "@/lib/generation-status-utils";

type GenerationStatusBannerProps = {
  artifactId: string;
};

const MIN_POLL_INTERVAL = 2000; // 2 seconds
const MAX_POLL_INTERVAL = 30_000; // 30 seconds
const BACKOFF_MULTIPLIER = 1.5;

// Module-level set to track which correlationIds have already shown a success
// toast. Survives component unmount/remount cycles caused by cache invalidation
// triggering parent re-renders.
export const toastedCorrelationIds = new Set<string>();

export function GenerationStatusBanner({
  artifactId,
}: Readonly<GenerationStatusBannerProps>) {
  const [isPolling, setIsPolling] = useState(true);
  const pollIntervalRef = useRef(MIN_POLL_INTERVAL);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const {
    data: generationStatus,
    isLoading,
    refetch,
    invalidateCache,
  } = useArtifactGenerationStatus(artifactId);
  const handleGenerationSuccess = useEffectEvent(invalidateCache);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    // Handle completion
    if (generationStatus?.status === "SUCCESS") {
      setIsPolling(false);
      handleGenerationSuccess();
      const corrId = generationStatus.correlationId ?? artifactId;
      if (!toastedCorrelationIds.has(corrId)) {
        toastedCorrelationIds.add(corrId);
        toast.success("Generation completed successfully");
      }
      return;
    }

    // Handle failure - stop polling but keep showing banner
    if (generationStatus?.status === "FAILURE") {
      setIsPolling(false);
      return;
    }

    // Handle no status - stop polling and hide
    if (generationStatus?.status === "NONE") {
      setIsPolling(false);
      return;
    }

    // Active status (PENDING/QUEUED/RUNNING) — clear previous toast key so a
    // new generation cycle for the same artifact can show a fresh toast.
    toastedCorrelationIds.delete(generationStatus?.correlationId ?? artifactId);
    pollIntervalRef.current = Math.min(
      pollIntervalRef.current * BACKOFF_MULTIPLIER,
      MAX_POLL_INTERVAL
    );
  }, [isLoading, generationStatus, artifactId]);

  useEffect(() => {
    if (!isPolling) {
      return;
    }

    const poll = () => {
      timeoutRef.current = setTimeout(async () => {
        await refetch();

        if (isPolling) {
          poll();
        }
      }, pollIntervalRef.current);
    };

    poll();

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [isPolling, refetch]);

  // Don't render if no status or status is NONE/SUCCESS
  if (
    !generationStatus ||
    generationStatus.status === "NONE" ||
    generationStatus.status === "SUCCESS"
  ) {
    return null;
  }

  const isActive = isActiveGenerationStatus(generationStatus.status);
  const isFailed = generationStatus.status === "FAILURE";

  return (
    <div
      className={`flex items-center justify-between gap-4 px-4 py-3 text-sm ${
        isFailed
          ? "border-destructive/20 bg-destructive/10 text-destructive"
          : "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300"
      } border-b`}
    >
      <div className="flex items-center gap-2">
        {isActive ? (
          <LoaderIcon className="h-4 w-4 animate-spin" />
        ) : (
          <XCircleIcon className="h-4 w-4" />
        )}
        <span>
          {getStatusMessage(
            generationStatus.status,
            generationStatus.command,
            generationStatus.initiatedBy
          )}
        </span>
      </div>

      <BannerLink generationStatus={generationStatus} />
    </div>
  );
}

/** Renders the appropriate link for the banner: internal Loop link, external GitHub link, or nothing. */
function BannerLink({
  generationStatus,
}: {
  generationStatus: GenerationStatus;
}) {
  if (generationStatus.source === "loop" && generationStatus.loopId) {
    return (
      <Link
        className="flex items-center gap-1 text-xs underline hover:no-underline"
        href={`/loops/${generationStatus.loopId}`}
      >
        View loop
      </Link>
    );
  }

  if (generationStatus.htmlUrl) {
    return (
      <a
        className="flex items-center gap-1 text-xs underline hover:no-underline"
        href={generationStatus.htmlUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        View workflow
        <ExternalLinkIcon className="h-3 w-3" />
      </a>
    );
  }

  return null;
}
