"use client";

import { ExternalLinkIcon, LoaderIcon, XCircleIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type GenerationStatus,
  getGenerationStatus,
} from "@/app/actions/artifacts";

type GenerationStatusBannerProps = {
  artifactId: string;
  onComplete?: () => void;
};

const MIN_POLL_INTERVAL = 2000; // 2 seconds
const MAX_POLL_INTERVAL = 30_000; // 30 seconds
const BACKOFF_MULTIPLIER = 1.5;

function getStatusMessage(
  status: GenerationStatus["status"],
  command: GenerationStatus["command"]
): string {
  const isExecute = command === "execute";
  switch (status) {
    case "PENDING":
      return "Waiting to start...";
    case "QUEUED":
      return isExecute ? "Queued for execution..." : "Queued for generation...";
    case "RUNNING":
      return isExecute
        ? "Executing plan and creating PR..."
        : "Generating implementation plan...";
    case "FAILURE":
      return isExecute ? "Plan execution failed" : "Plan generation failed";
    default:
      return "";
  }
}

/** Terminal statuses that should stop polling */
function isTerminalStatus(
  status: GenerationStatus["status"]
): status is "SUCCESS" | "FAILURE" | "NONE" {
  return status === "SUCCESS" || status === "FAILURE" || status === "NONE";
}

export function GenerationStatusBanner({
  artifactId,
  onComplete,
}: GenerationStatusBannerProps) {
  const [status, setStatus] = useState<GenerationStatus | null>(null);
  const [isPolling, setIsPolling] = useState(true);
  const pollIntervalRef = useRef(MIN_POLL_INTERVAL);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const onCompleteRef = useRef(onComplete);
  // Track if we've seen an active generation state - only call onComplete
  // if we transition FROM active TO success (not if already success on load)
  const sawActiveStateRef = useRef(false);
  const completedRef = useRef(false);

  // Keep onComplete ref updated
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const applyBackoff = useCallback(() => {
    pollIntervalRef.current = Math.min(
      pollIntervalRef.current * BACKOFF_MULTIPLIER,
      MAX_POLL_INTERVAL
    );
  }, []);

  const handleStatusResult = useCallback(
    (data: GenerationStatus) => {
      setStatus(data);

      // Terminal statuses stop polling
      if (isTerminalStatus(data.status)) {
        setIsPolling(false);
        // Only call onComplete for SUCCESS if we saw an active state first
        // (i.e., generation actually happened during this session, not already done on page load)
        const shouldNotify =
          data.status === "SUCCESS" &&
          sawActiveStateRef.current &&
          !completedRef.current;
        if (shouldNotify) {
          completedRef.current = true;
          onCompleteRef.current?.();
        }
        return;
      }

      // Active statuses (PENDING, QUEUED, RUNNING) - track and continue polling
      sawActiveStateRef.current = true;
      completedRef.current = false;
      applyBackoff();
    },
    [applyBackoff]
  );

  const fetchStatus = useCallback(async () => {
    try {
      const result = await getGenerationStatus(artifactId);
      if (result.success) {
        handleStatusResult(result.data);
      }
    } catch (error) {
      console.error("Failed to fetch generation status:", error);
      applyBackoff();
    }
  }, [artifactId, handleStatusResult, applyBackoff]);

  useEffect(() => {
    // Initial fetch
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!isPolling) {
      return;
    }

    const poll = () => {
      timeoutRef.current = setTimeout(() => {
        fetchStatus().then(() => {
          if (isPolling) {
            poll();
          }
        });
      }, pollIntervalRef.current);
    };

    poll();

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [isPolling, fetchStatus]);

  // Don't render if no status or status is NONE/SUCCESS
  if (!status || status.status === "NONE" || status.status === "SUCCESS") {
    return null;
  }

  const isActive =
    status.status === "PENDING" ||
    status.status === "QUEUED" ||
    status.status === "RUNNING";
  const isFailed = status.status === "FAILURE";

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
        <span>{getStatusMessage(status.status, status.command)}</span>
      </div>

      {status.htmlUrl ? (
        <a
          className="flex items-center gap-1 text-xs underline hover:no-underline"
          href={status.htmlUrl}
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
