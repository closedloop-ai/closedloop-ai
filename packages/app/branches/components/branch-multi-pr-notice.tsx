"use client";

import { cn } from "@repo/design-system/lib/utils";
import { GitPullRequestIcon } from "lucide-react";

/**
 * Multi-PR notice (Epic D / D7). A non-blocking inline banner (NOT an
 * error/modal) shown when a branch has more than one linked PR: the per-phase
 * cost split (D3/D4) can't be attributed across PRs, so the cost panel suppresses
 * it and this explains why. Lead time (D5) is still shown for the whole branch,
 * flagged with the waterfall asterisk. The same `multiPrWarning` flag drives this
 * notice and that asterisk. Single-PR branches (single- or multi-session) never
 * render it.
 */
export type BranchMultiPrNoticeProps = {
  linkedPrNumbers: readonly number[];
  className?: string;
};

export function BranchMultiPrNotice({
  linkedPrNumbers,
  className,
}: BranchMultiPrNoticeProps) {
  const prList = linkedPrNumbers.map((pr) => `#${pr}`).join(", ");
  return (
    <div className={cn("bq-notice", className)} role="note">
      <GitPullRequestIcon aria-hidden className="size-3.5" />
      <p>
        This branch has {linkedPrNumbers.length} linked pull requests
        {prList ? ` (${prList})` : ""}. The per-phase cost split can't be
        attributed across multiple PRs, so it's suppressed below; lead time is
        shown for the whole branch.
      </p>
    </div>
  );
}
