"use client";

import {
  type GenerationStatus,
  isActiveGenerationStatus,
} from "@repo/api/src/types/document";
import { cn } from "@repo/design-system/lib/utils";
import { CheckCircle, LoaderIcon, XCircleIcon } from "lucide-react";
import Link from "next/link";
import { getStatusMessage } from "@/lib/generation-status-utils";

type GenerationStatusIndicatorProps = {
  generationStatus?: GenerationStatus;
  className?: string;
};

export function GenerationStatusIndicator({
  generationStatus,
  className,
}: Readonly<GenerationStatusIndicatorProps>) {
  if (!generationStatus || generationStatus.status === "NONE") {
    return null;
  }

  const { status, command, initiatedBy } = generationStatus;
  const message = getStatusMessage(status, command, initiatedBy);
  const isActive = isActiveGenerationStatus(status);
  const isSuccess = status === "SUCCESS";
  const isFailure = status === "FAILURE";
  // Pick icon based on status
  let icon: React.ReactNode;
  let colorClass: string;

  if (isActive) {
    icon = <LoaderIcon className="h-4 w-4 animate-spin" />;
    colorClass = "text-blue-600";
  } else if (isSuccess) {
    icon = <CheckCircle className="h-4 w-4" />;
    colorClass = "text-green-600";
  } else if (isFailure) {
    icon = <XCircleIcon className="h-4 w-4" />;
    colorClass = "text-red-600";
  } else {
    return null;
  }

  // Loop source: use internal Next.js Link to /loops/:id
  if (generationStatus.source === "loop" && generationStatus.loopId) {
    return (
      <Link
        aria-label={`${message} - View loop`}
        className={cn(
          "inline-flex items-center gap-1 text-sm hover:underline",
          colorClass,
          className
        )}
        href={`/loops/${generationStatus.loopId}`}
      >
        {icon}
        <span>{message}</span>
      </Link>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-sm",
        colorClass,
        className
      )}
    >
      {icon}
      <span>{message}</span>
    </span>
  );
}
