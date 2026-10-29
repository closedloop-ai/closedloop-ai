import {
  COMMENTS_MOBILE_MAX_WIDTH,
  COMMENTS_NARROW_MAX_WIDTH,
} from "../../../comments/comments-pane-model";

export type CommentsLayoutMode = "wide" | "compact" | "mobile";

// ISS-11209 chose Branch's 1024/639 over the prototype's 1100/640.
export const COMMENTS_AUTO_COLLAPSE_WIDTH = COMMENTS_NARROW_MAX_WIDTH + 1;
export const COMMENTS_MOBILE_WIDTH = COMMENTS_MOBILE_MAX_WIDTH + 1;

const layoutRank: Record<CommentsLayoutMode, number> = {
  compact: 1,
  mobile: 2,
  wide: 0,
};

export function commentsLayoutModeForWidth(width: number): CommentsLayoutMode {
  if (width < COMMENTS_MOBILE_WIDTH) {
    return "mobile";
  }
  if (width < COMMENTS_AUTO_COLLAPSE_WIDTH) {
    return "compact";
  }
  return "wide";
}

export function shouldAutoCollapseComments({
  nextMode,
  open,
  previousMode,
}: {
  nextMode: CommentsLayoutMode;
  open: boolean;
  previousMode: CommentsLayoutMode | null;
}): boolean {
  if (!(open && nextMode !== "wide")) {
    return false;
  }
  return (
    previousMode == null || layoutRank[nextMode] > layoutRank[previousMode]
  );
}
