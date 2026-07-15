"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { StarRating } from "@repo/design-system/components/ui/star-rating";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { AlertTriangle as AlertTriangleIcon, Loader2Icon } from "lucide-react";

export type DocumentRatingSummaryViewModel = {
  average: number;
  count: number;
  userRating: {
    score: number;
    comment?: string | null;
    documentVersion: number;
  } | null;
};

type DocumentRatingSectionProps = {
  summary?: DocumentRatingSummaryViewModel | null;
  currentDocumentVersion: number;
  selectedScore?: number | null;
  commentDraft: string;
  isLoading?: boolean;
  isSaving?: boolean;
  onScoreChange?: (score: number) => void;
  onCommentChange?: (value: string) => void;
  onCancelComment?: () => void;
  onSaveComment?: () => void;
};

export function DocumentRatingSection({
  summary,
  currentDocumentVersion,
  selectedScore,
  commentDraft,
  isLoading = false,
  isSaving = false,
  onScoreChange,
  onCommentChange,
  onCancelComment,
  onSaveComment,
}: Readonly<DocumentRatingSectionProps>) {
  const userRating = summary?.userRating;
  const hasStaleVersion =
    userRating && userRating.documentVersion !== currentDocumentVersion;

  const effectiveScore = userRating?.score ?? selectedScore ?? 0;
  const showCommentSection = effectiveScore > 0;
  const commentUnchanged = (userRating?.comment ?? "") === commentDraft;

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-48" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <StarRating
          onChange={onScoreChange}
          readonly={isSaving}
          value={effectiveScore}
        />
        {isSaving ? (
          <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      <div aria-live="polite" className="text-center text-sm">
        {summary && summary.count > 0 ? (
          <span>
            {summary.average.toFixed(1)} / 5{" "}
            <span className="text-muted-foreground">
              ({summary.count} rating{summary.count === 1 ? "" : "s"})
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">
            No ratings yet. Be the first to rate!
          </span>
        )}
      </div>

      {hasStaleVersion ? (
        <div className="flex items-center gap-1.5 rounded-md bg-amber-100 px-2 py-1 text-amber-800 text-xs dark:bg-amber-900 dark:text-amber-200">
          <AlertTriangleIcon className="h-3 w-3" />
          <span>
            Rated on version {userRating.documentVersion} (current:{" "}
            {currentDocumentVersion})
          </span>
        </div>
      ) : null}

      {showCommentSection ? (
        <div className="space-y-2">
          <Textarea
            aria-label="Rating comment"
            className="min-h-[80px]"
            maxLength={500}
            onChange={(event) => onCommentChange?.(event.target.value)}
            placeholder="Add a comment (optional)"
            value={commentDraft}
          />
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">
              {commentDraft.length} / 500
            </span>
            <div className="flex gap-2">
              <Button onClick={onCancelComment} size="sm" variant="ghost">
                Cancel
              </Button>
              <Button
                disabled={isSaving || effectiveScore <= 0 || commentUnchanged}
                onClick={onSaveComment}
                size="sm"
              >
                Save Comment
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
