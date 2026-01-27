"use client";

import { toast } from "@repo/design-system/components/ui/sonner";
import { ExternalLinkIcon, LoaderIcon, XCircleIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useArtifactGenerationStatus } from "@/hooks/queries/use-artifacts";

type GenerationStatus = {
  status: "NONE" | "PENDING" | "QUEUED" | "RUNNING" | "SUCCESS" | "FAILURE";
  htmlUrl: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  correlationId: string | null;
};

type GenerationStatusBannerProps = {
  artifactId: string;
};

const MIN_POLL_INTERVAL = 2000; // 2 seconds
const MAX_POLL_INTERVAL = 30_000; // 30 seconds
const BACKOFF_MULTIPLIER = 1.5;

function getStatusMessage(status: GenerationStatus["status"]): string {
  switch (status) {
    case "PENDING":
      return "Waiting to start...";
    case "QUEUED":
      return "Queued for generation...";
    case "RUNNING":
      return "Generating implementation plan...";
    case "FAILURE":
      return "Plan generation failed";
    default:
      return "";
  }
}

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
      toast.success("Plan generation completed successfully");
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

    // Continue polling with backoff for active statuses
    pollIntervalRef.current = Math.min(
      pollIntervalRef.current * BACKOFF_MULTIPLIER,
      MAX_POLL_INTERVAL
    );
  }, [isLoading, generationStatus]);

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

  const isActive =
    generationStatus.status === "PENDING" ||
    generationStatus.status === "QUEUED" ||
    generationStatus.status === "RUNNING";
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
        <span>{getStatusMessage(generationStatus.status)}</span>
      </div>

      {generationStatus.htmlUrl ? (
        <a
          className="flex items-center gap-1 text-xs underline hover:no-underline"
          href={generationStatus.htmlUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          View workflow
          <ExternalLinkIcon className="h-3 w-3" />
        </a>
      ) : null}
    </div>
  );
}
