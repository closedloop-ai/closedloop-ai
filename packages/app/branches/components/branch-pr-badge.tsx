"use client";

import type { BranchPrState } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { Chip } from "@repo/design-system/components/ui/chip";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { GitPullRequestIcon } from "lucide-react";
import type { ReactNode } from "react";
import { isGithubPrUrl } from "../lib/branch-pr-url";

/**
 * Branch PR badge (Epic B / B3) — shared by the Branches list (B4) and the Epic
 * D detail panel. Composes the design-system `Chip`, lifecycle-colored by
 * `BranchPrState`; renders the empty-value affordance (never a fabricated chip)
 * when there is no linked PR. A domain component: it encodes branch PR-state, so
 * it lives in the feature slice, not `@repo/design-system`.
 */
export type BranchPRBadgeProps = {
  prNumber: number | null;
  prTitle?: string | null;
  prState?: BranchPrState | null;
  prUrl?: string | null;
  repoShortName?: string | null;
};

// `BranchPrState` is OPEN | MERGED | CLOSED. No-PR rows render `GridEmptyValue`
// before this map is consulted; a present-but-unknown state falls back to muted.
const PR_STATE_VARIANT: Record<
  GitHubPRState,
  "info" | "success" | "destructive"
> = {
  [GitHubPRState.Open]: "info",
  [GitHubPRState.Merged]: "success",
  [GitHubPRState.Closed]: "destructive",
};

export function BranchPRBadge({
  prNumber,
  prTitle,
  prState,
  prUrl,
  repoShortName,
}: BranchPRBadgeProps): ReactNode {
  if (prNumber == null) {
    return <GridEmptyValue />;
  }

  const variant = prState ? PR_STATE_VARIANT[prState] : "muted";
  const label = repoShortName ? `${repoShortName}#${prNumber}` : `#${prNumber}`;
  const title = prTitle ?? label;
  const content = (
    <>
      <GitPullRequestIcon className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </>
  );

  // Only link out for a canonical GitHub PR URL; anything else (off-domain,
  // `javascript:`/`data:`, malformed) renders the non-interactive chip below.
  if (isGithubPrUrl(prUrl)) {
    return (
      <Chip
        asChild
        className="min-w-0 gap-1"
        interactive
        title={title}
        variant={variant}
      >
        <a href={prUrl} rel="noreferrer" target="_blank">
          {content}
        </a>
      </Chip>
    );
  }

  return (
    <Chip className="min-w-0 gap-1" title={title} variant={variant}>
      {content}
    </Chip>
  );
}
