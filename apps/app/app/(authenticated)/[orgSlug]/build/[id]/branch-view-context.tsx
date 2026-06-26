"use client";

import type {
  BranchViewComment,
  BranchViewFile,
} from "@repo/api/src/types/branch-view";
import type {
  BranchViewSyncControl,
  useCreateBranchViewConversationComment,
  useDeleteBranchViewConversationComment,
  useDeleteBranchViewReviewComment,
  useEditBranchViewConversationComment,
  useEditBranchViewReviewComment,
  useReplyToComment,
  useResolveBranchViewReviewThread,
  useUnresolveBranchViewReviewThread,
} from "@repo/app/documents/hooks/use-branch-view";
import { createContext, type ReactNode, useContext } from "react";
import type { CommentDiffNavigationRequest } from "./file-targets";
import type { BranchViewData } from "./types";

export type BranchViewMutations = {
  reply: ReturnType<typeof useReplyToComment>;
  createConversation: ReturnType<typeof useCreateBranchViewConversationComment>;
  editConversation: ReturnType<typeof useEditBranchViewConversationComment>;
  deleteConversation: ReturnType<typeof useDeleteBranchViewConversationComment>;
  editReview: ReturnType<typeof useEditBranchViewReviewComment>;
  deleteReview: ReturnType<typeof useDeleteBranchViewReviewComment>;
  resolveThread: ReturnType<typeof useResolveBranchViewReviewThread>;
  unresolveThread: ReturnType<typeof useUnresolveBranchViewReviewThread>;
};

export type BranchViewContextValue = {
  data: BranchViewData;
  comments: BranchViewComment[];
  committedFiles: BranchViewFile[];
  headSha: string | null;
  fileCacheHeadSha: string | null;
  externalLinkId: string;
  prNumber: number;
  selectedCommentId: string | null;
  onSelectComment: (id: string | null) => void;
  onSelectCommentDiffTarget: (req: CommentDiffNavigationRequest) => void;
  canCreateConversationComment: boolean;
  syncControl: BranchViewSyncControl;
  mutations: BranchViewMutations;
};

const BranchViewContext = createContext<BranchViewContextValue | null>(null);

export function BranchViewProvider({
  value,
  children,
}: Readonly<{ value: BranchViewContextValue; children: ReactNode }>) {
  return (
    <BranchViewContext.Provider value={value}>
      {children}
    </BranchViewContext.Provider>
  );
}

export function useBranchViewContext(): BranchViewContextValue {
  const value = useContext(BranchViewContext);
  if (value === null) {
    throw new Error(
      "useBranchViewContext must be used inside <BranchViewProvider>"
    );
  }
  return value;
}
