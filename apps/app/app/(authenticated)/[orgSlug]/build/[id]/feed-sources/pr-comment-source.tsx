"use client";

import { CommentKind } from "@repo/api/src/types/branch-view";
import { FeedItemKind } from "@repo/app/documents/components/feed-sidebar/feed-item";
import type {
  FeedSource,
  FeedSourceUseItemsResult,
} from "@repo/app/documents/components/feed-sidebar/feed-source";
import { MessageSquare } from "lucide-react";
import { useMemo } from "react";
import { useBranchViewContext } from "../branch-view-context";
import { getBranchViewCommentUiId } from "../comment-context";
import { isResolvedComment } from "../comment-resolution";
import {
  classifyBranchReviewFindingAnchor,
  parseBranchReviewFinding,
} from "../components/branch-review-findings";
import { buildCommentThreads } from "../components/comment-threads";
import { resolveCommittedCommentFileTarget } from "../file-targets";
import { PrCommentCard } from "./pr-comment-card";
import {
  DEFAULT_PR_FILTER_STATE,
  type PrCommentItem,
  type PrFilterState,
  PrFilterTab,
} from "./pr-comment-types";
import { PrConversationComposer } from "./pr-conversation-composer";
import { PrFilterControl } from "./pr-filter-control";

const PR_SOURCE_ID = "pr-comment";

function applyPrFilter(
  items: readonly PrCommentItem[],
  state: PrFilterState
): readonly PrCommentItem[] {
  if (state.tab === PrFilterTab.All) {
    return items;
  }
  if (state.tab === PrFilterTab.Pending) {
    return items.filter((item) => !isResolvedComment(item.root));
  }
  if (state.tab === PrFilterTab.Findings) {
    return items.filter((item) => item.finding !== null);
  }
  return items.filter((item) => isResolvedComment(item.root));
}

function usePrCommentItems(): FeedSourceUseItemsResult<PrCommentItem> {
  const { comments, committedFiles, headSha, fileCacheHeadSha } =
    useBranchViewContext();
  return useMemo(() => {
    const threads = buildCommentThreads(comments);
    const items: PrCommentItem[] = threads.map((thread) => {
      const finding = parseBranchReviewFinding(thread.root);
      const findingAnchor = finding
        ? classifyBranchReviewFindingAnchor({
            comment: thread.root,
            committedFiles,
            fileCacheHeadSha,
            headSha,
          })
        : null;
      const commentFileTarget =
        thread.root.kind === CommentKind.ReviewComment && thread.root.path
          ? resolveCommittedCommentFileTarget(committedFiles, thread.root.path)
          : null;
      return {
        id: getBranchViewCommentUiId(thread.root),
        kind: FeedItemKind.PrComment,
        sourceId: PR_SOURCE_ID,
        createdAt: new Date(thread.root.createdAt),
        threadId: thread.root.threadId ?? thread.root.id,
        root: thread.root,
        replies: thread.replies,
        finding,
        findingAnchor,
        commentFileTarget,
      } satisfies PrCommentItem;
    });
    return {
      items,
      isLoading: false,
      isError: false,
    };
  }, [comments, committedFiles, headSha, fileCacheHeadSha]);
}

/**
 * Singleton PR-comment FeedSource. Reads its raw data from the
 * `useBranchViewContext()` provider mounted by `BranchViewContainer`;
 * never imports from `apps/app/hooks/queries/use-branch-view.ts`
 * directly so consumers can swap the data layer without touching the
 * card/source machinery.
 */
export const prCommentSource: FeedSource<PrCommentItem, PrFilterState> = {
  id: PR_SOURCE_ID,
  kind: FeedItemKind.PrComment,
  label: "Comments",
  Icon: MessageSquare,
  useItems: usePrCommentItems,
  defaultFilterState: DEFAULT_PR_FILTER_STATE,
  applyFilter: applyPrFilter,
  isFiltered: (state) => state.tab !== PrFilterTab.All,
  FilterControl: PrFilterControl,
  Composer: PrConversationComposer,
  renderItem: (item) => <PrCommentCard item={item} />,
};
