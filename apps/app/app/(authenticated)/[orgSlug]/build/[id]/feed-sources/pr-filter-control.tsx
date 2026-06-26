"use client";

import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { useMemo } from "react";
import { useBranchViewContext } from "../branch-view-context";
import { isResolvedComment } from "../comment-resolution";
import { parseBranchReviewFinding } from "../components/branch-review-findings";
import { buildCommentThreads } from "../components/comment-threads";
import { type PrFilterState, PrFilterTab } from "./pr-comment-types";

/**
 * `all | pending | findings | resolved` tab strip rendered when the
 * Comments kind is active in the feed filter bar. Counts are derived
 * from the same thread-root projection the `prCommentSource` renders,
 * so the badge totals never disagree with the visible row count.
 */
export function PrFilterControl({
  state,
  onChange,
}: Readonly<{
  state: PrFilterState;
  onChange: (next: PrFilterState) => void;
}>) {
  const { comments } = useBranchViewContext();
  const counts = useMemo(() => {
    let pending = 0;
    let findings = 0;
    let resolved = 0;
    const threads = buildCommentThreads(comments);
    for (const { root } of threads) {
      if (isResolvedComment(root)) {
        resolved += 1;
      } else {
        pending += 1;
      }
      if (parseBranchReviewFinding(root)) {
        findings += 1;
      }
    }
    return { pending, findings, resolved, all: threads.length };
  }, [comments]);

  return (
    <div className="flex items-center gap-2 px-3 pb-1.5">
      <Tabs
        className="min-w-0 flex-1"
        onValueChange={(next) => onChange({ tab: next as PrFilterTab })}
        value={state.tab}
      >
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger className="px-2 text-xs" value={PrFilterTab.All}>
            All ({counts.all})
          </TabsTrigger>
          <TabsTrigger className="px-2 text-xs" value={PrFilterTab.Pending}>
            Pending ({counts.pending})
          </TabsTrigger>
          <TabsTrigger className="px-2 text-xs" value={PrFilterTab.Findings}>
            Findings ({counts.findings})
          </TabsTrigger>
          <TabsTrigger className="px-2 text-xs" value={PrFilterTab.Resolved}>
            Resolved ({counts.resolved})
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}
