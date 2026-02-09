"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { StarRating } from "@repo/design-system/components/ui/star-rating";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { AlertTriangle as AlertTriangleIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import {
  useArtifactRating,
  useSubmitRating,
} from "@/hooks/queries/use-artifact-rating";

type RatingSectionProps = {
  artifactId: string;
  currentPlanVersion: number;
};

/**
 * Rating section for artifact editor with star rating, comment, and version tracking.
 * Displays aggregate ratings, allows users to rate and comment, and warns when rating
 * is stale (artifact version has changed since rating was submitted).
 */
export function RatingSection({
  artifactId,
  currentPlanVersion,
}: Readonly<RatingSectionProps>): React.ReactElement {
  const [isEditingComment, setIsEditingComment] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");

  const { data: summary, isLoading } = useArtifactRating(artifactId);
  const submitRating = useSubmitRating();

  const userRating = summary?.userRating;
  const hasStaleVersion =
    userRating && userRating.artifactVersion !== currentPlanVersion;

  // Loading state
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
      {/* Star selector row */}
      <div className="flex items-center gap-2">
        <StarRating
          onChange={(score) => {
            submitRating.mutate({
              artifactId,
              score,
              comment: userRating?.comment,
            });
          }}
          readonly={submitRating.isPending}
          value={userRating?.score ?? 0}
        />
        {submitRating.isPending && (
          <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* Aggregate display */}
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

      {/* Stale version indicator */}
      {hasStaleVersion && (
        <div className="flex items-center gap-1.5 rounded-md bg-amber-100 px-2 py-1 text-amber-800 text-xs dark:bg-amber-900 dark:text-amber-200">
          <AlertTriangleIcon className="h-3 w-3" />
          <span>
            Rated on version {userRating.artifactVersion} (current:{" "}
            {currentPlanVersion})
          </span>
        </div>
      )}

      {/* Comment section */}
      {userRating?.comment && !isEditingComment ? (
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm">{userRating.comment}</p>
          <Button
            onClick={() => {
              setCommentDraft(userRating.comment ?? "");
              setIsEditingComment(true);
            }}
            size="sm"
            variant="ghost"
          >
            Edit comment
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Textarea
            className="min-h-[80px]"
            maxLength={500}
            onChange={(e) => setCommentDraft(e.target.value)}
            placeholder="Add a comment (optional)"
            value={commentDraft}
          />
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">
              {commentDraft.length} / 500
            </span>
            <div className="flex gap-2">
              {isEditingComment && (
                <Button
                  onClick={() => setIsEditingComment(false)}
                  size="sm"
                  variant="ghost"
                >
                  Cancel
                </Button>
              )}
              <Button
                disabled={
                  submitRating.isPending ||
                  !userRating?.score ||
                  (isEditingComment && commentDraft === userRating?.comment)
                }
                onClick={() => {
                  submitRating.mutate(
                    {
                      artifactId,
                      score: userRating?.score ?? 0,
                      comment: commentDraft,
                    },
                    {
                      onSuccess: () => setIsEditingComment(false),
                    }
                  );
                }}
                size="sm"
              >
                Save Comment
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
