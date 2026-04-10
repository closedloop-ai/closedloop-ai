"use client";

import {
  type GenerationStatus,
  isActiveGenerationStatus,
} from "@repo/api/src/types/artifact";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  CircleAlertIcon,
  ExternalLinkIcon,
  LoaderIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { getStatusMessage } from "@/lib/generation-status-utils";

type GenerationStatusBannerProps = {
  generationStatus: GenerationStatus | undefined;
  onGenerationComplete?: () => void;
};

const UNKNOWN_FAILURE_RUN_KEY = "__unknown_failure_run__";

function stringifyDate(date: Date | null): string | null {
  if (!date) {
    return null;
  }
  return date instanceof Date ? date.toISOString() : String(date);
}

function getGenerationRunKey(
  generationStatus: GenerationStatus | undefined
): string | null {
  if (!generationStatus) {
    return null;
  }
  if (generationStatus.correlationId) {
    return `corr:${generationStatus.correlationId}`;
  }
  const startedAt = stringifyDate(generationStatus.startedAt);
  if (startedAt) {
    return `started:${startedAt}`;
  }
  const completedAt = stringifyDate(generationStatus.completedAt);
  if (completedAt) {
    return `completed:${completedAt}`;
  }
  return null;
}

export function GenerationStatusBanner({
  generationStatus,
  onGenerationComplete,
}: Readonly<GenerationStatusBannerProps>) {
  const toastShownRef = useRef(false);
  const prevStatusRef = useRef<GenerationStatus["status"] | undefined>(
    undefined
  );
  const [dismissedFailureRunKey, setDismissedFailureRunKey] = useState<
    string | null
  >(null);
  const runKey = getGenerationRunKey(generationStatus);

  const handleGenerationComplete = useEffectEvent(() => {
    onGenerationComplete?.();
  });

  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    const currentStatus = generationStatus?.status;
    prevStatusRef.current = currentStatus;

    if (
      currentStatus === "SUCCESS" &&
      prevStatus &&
      prevStatus !== "SUCCESS" &&
      !toastShownRef.current
    ) {
      toastShownRef.current = true;
      toast.success("Generation completed successfully");
      handleGenerationComplete();
    }

    // Reset toast guard and dismiss state when generation becomes active again
    if (currentStatus && isActiveGenerationStatus(currentStatus)) {
      toastShownRef.current = false;
      setDismissedFailureRunKey(null);
    }
  }, [generationStatus]);

  useEffect(() => {
    if (dismissedFailureRunKey && runKey && dismissedFailureRunKey !== runKey) {
      setDismissedFailureRunKey(null);
    }
  }, [dismissedFailureRunKey, runKey]);

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
  const failureRunKey = runKey ?? UNKNOWN_FAILURE_RUN_KEY;

  if (isFailed && dismissedFailureRunKey === failureRunKey) {
    return null;
  }

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
          <CircleAlertIcon className="h-4 w-4" />
        )}
        <span>
          {getStatusMessage(
            generationStatus.status,
            generationStatus.command,
            generationStatus.initiatedBy
          )}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <BannerLink generationStatus={generationStatus} />
        {isFailed && (
          <button
            aria-label="Dismiss"
            className="rounded-sm p-0.5 opacity-70 hover:opacity-100"
            onClick={() => setDismissedFailureRunKey(failureRunKey)}
            type="button"
          >
            <XIcon className="h-4 w-4" />
          </button>
        )}
      </div>
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
