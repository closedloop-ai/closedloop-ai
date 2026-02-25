"use client";

import {
  type GenerationStatus,
  isActiveGenerationStatus,
} from "@repo/api/src/types/artifact";
import {
  CheckCircle,
  ExternalLinkIcon,
  LoaderIcon,
  XCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { getStatusMessage } from "@/lib/generation-status-utils";

type GenerationStatusIndicatorProps = {
  generationStatus?: GenerationStatus;
};

export function GenerationStatusIndicator({
  generationStatus,
}: Readonly<GenerationStatusIndicatorProps>) {
  if (!generationStatus || generationStatus.status === "NONE") {
    return null;
  }

  const { status, command, htmlUrl, initiatedBy } = generationStatus;
  const message = getStatusMessage(status, command, initiatedBy);
  const isActive = isActiveGenerationStatus(status);
  const isSuccess = status === "SUCCESS";
  const isFailure = status === "FAILURE";
  const isLoop = generationStatus.source === "loop";

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
  if (isLoop && generationStatus.loopId) {
    return (
      <Link
        aria-label={`${message} - View loop`}
        className={`inline-flex items-center gap-1 text-sm hover:underline ${colorClass}`}
        href={`/loops/${generationStatus.loopId}`}
      >
        {icon}
        <span>{message}</span>
      </Link>
    );
  }

  // GitHub Actions source: use external <a> link
  if (htmlUrl) {
    return (
      <a
        aria-label={`${message} - View workflow`}
        className={`inline-flex items-center gap-1 text-sm hover:underline ${colorClass}`}
        href={htmlUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        {icon}
        <span>{message}</span>
        <ExternalLinkIcon className="h-3 w-3" />
      </a>
    );
  }

  return (
    <span className={`inline-flex items-center gap-1 text-sm ${colorClass}`}>
      {icon}
      <span>{message}</span>
    </span>
  );
}
