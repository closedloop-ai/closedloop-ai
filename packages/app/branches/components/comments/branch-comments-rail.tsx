"use client";

// Cross-slice: Branch consumes the canonical comments shell (ISS-11209).
import {
  COMMENTS_RAIL_MAX_WIDTH,
  COMMENTS_RAIL_MIN_WIDTH,
} from "@repo/app/shared/components/comments/comments-pane-model";
import { CommentsRailShell } from "@repo/app/shared/components/comments/comments-rail-shell";
import type { ReactNode, RefObject } from "react";
import { BranchCommentsTab } from "./branch-comments-model";

export const BRANCH_COMMENTS_MIN_WIDTH = COMMENTS_RAIL_MIN_WIDTH;
export const BRANCH_COMMENTS_MAX_WIDTH = COMMENTS_RAIL_MAX_WIDTH;

/**
 * Branch's comments placement: the shared responsive shell with Branch's own
 * screen-reader description of which view the comments belong to.
 */
export function BranchCommentsRail({
  activeTab,
  children,
  onClose,
  onWidthChange,
  open,
  returnFocusRef,
  width,
}: Readonly<{
  activeTab: BranchCommentsTab;
  children: ReactNode;
  onClose: () => void;
  onWidthChange: (width: number) => void;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  width: number;
}>) {
  return (
    <CommentsRailShell
      description={
        activeTab === BranchCommentsTab.Details
          ? "Comments for the Branch details view."
          : "Comments for the Sessions and timeline view."
      }
      onClose={onClose}
      onWidthChange={onWidthChange}
      open={open}
      returnFocusRef={returnFocusRef}
      width={width}
    >
      {children}
    </CommentsRailShell>
  );
}
