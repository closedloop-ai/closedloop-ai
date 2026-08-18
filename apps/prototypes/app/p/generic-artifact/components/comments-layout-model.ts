export type CommentsLayoutMode = "wide" | "compact" | "mobile";

export const COMMENTS_AUTO_COLLAPSE_WIDTH = 1100;
export const COMMENTS_MOBILE_WIDTH = 640;

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
