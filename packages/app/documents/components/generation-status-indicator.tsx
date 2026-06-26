"use client";

import {
  type GenerationStatus,
  isActiveGenerationStatus,
} from "@repo/api/src/types/document";
import { getStatusMessage } from "@repo/app/documents/lib/generation-status-utils";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { CheckCircle, LoaderIcon, XCircleIcon } from "lucide-react";

type GenerationStatusIndicatorProps = {
  generationStatus?: GenerationStatus;
  className?: string;
};

export function GenerationStatusIndicator({
  generationStatus,
  className,
}: Readonly<GenerationStatusIndicatorProps>) {
  const buildOrgPath = useOrgPath();
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
        href={buildOrgPath(`/loops/${generationStatus.loopId}`)}
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
