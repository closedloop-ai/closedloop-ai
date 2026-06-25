"use client";

import { SourceBadge } from "@repo/app/documents/components/feed-sidebar/source-badge";
import { GithubIcon } from "lucide-react";

/**
 * "GitHub" badge worn by every PR comment row. Thin wrapper around the
 * generic feed-sidebar SourceBadge so callers don't have to repeat the
 * icon + label combo on each renderItem call.
 */
export function PrCommentSourceBadge() {
  return <SourceBadge Icon={GithubIcon} label="GitHub" />;
}
