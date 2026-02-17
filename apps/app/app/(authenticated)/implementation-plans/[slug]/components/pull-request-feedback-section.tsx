"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { MetadataSection } from "@/components/artifact-editor/metadata-panel";
import { StarRating } from "@/components/star-rating";
import {
  usePullRequestRating,
  useSubmitPullRequestRating,
} from "@/hooks/queries/use-pull-request-rating";

type PullRequestFeedbackSectionProps = {
  pullRequestId: string;
};

/**
 * PR Feedback section for implementation plan metadata panel.
 * Displays star rating, aggregate statistics, and required comment textarea.
 *
 * Comment rendering uses React text nodes (Textarea value prop) which is XSS-safe.
 * Comments are stored as plain text.
 */
export function PullRequestFeedbackSection({
  pullRequestId,
}: Readonly<PullRequestFeedbackSectionProps>): React.ReactElement {
  const [localScore, setLocalScore] = useState<number>(0);
  const [localComment, setLocalComment] = useState("");
  const [isEditing, setIsEditing] = useState(false);

  const { data: summary, isLoading } = usePullRequestRating(pullRequestId);
  const submitRating = useSubmitPullRequestRating();

  const userRating = summary?.userRating;

  // Sync local state from server when userRating updates (load or after submit)
  useEffect(() => {
    if (userRating && !isEditing) {
      setLocalScore(userRating.score);
      setLocalComment(userRating.comment);
    }
  }, [userRating, isEditing]);

  // Loading state
  if (isLoading) {
    return (
      <MetadataSection separator>
        <h4 className="font-medium text-sm">PR Feedback</h4>
        <div className="space-y-3">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-48" />
        </div>
      </MetadataSection>
    );
  }

  // Guard: PRD Scope §11 - cannot clear rating to 0
  const handleStarChange = (score: number) => {
    if (score === 0) {
      return;
    }
    setLocalScore(score);
    setIsEditing(true);
  };

  const handleSave = () => {
    submitRating.mutate({
      pullRequestId,
      score: localScore,
      comment: localComment,
    });
    setIsEditing(false);
  };

  const handleCancel = () => {
    setLocalScore(userRating?.score ?? 0);
    setLocalComment(userRating?.comment ?? "");
    setIsEditing(false);
  };

  const showCommentSection = localScore > 0 || isEditing;
  const serverComment = userRating?.comment ?? "";
  const scoreChanged = (userRating?.score ?? 0) !== localScore;
  const commentChanged = serverComment !== localComment;
  const hasUnsavedChanges = scoreChanged || commentChanged;

  return (
    <MetadataSection separator>
      <h4 className="font-medium text-sm">PR Feedback</h4>

      {/* Star selector row */}
      <div className="flex items-center gap-2">
        <StarRating
          onChange={handleStarChange}
          readonly={submitRating.isPending}
          size="lg"
          value={localScore}
        />
        {submitRating.isPending && (
          <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* Aggregate display */}
      {summary && summary.count > 0 && (
        <div aria-live="polite" className="text-muted-foreground text-sm">
          {summary.average.toFixed(1)} average ({summary.count}{" "}
          {summary.count === 1 ? "rating" : "ratings"})
        </div>
      )}

      {/* Comment section — shown when user has or just selected a rating */}
      {showCommentSection && (
        <div className="mt-4 space-y-2">
          <Textarea
            maxLength={500}
            onChange={(e) => setLocalComment(e.target.value)}
            placeholder="Add context for your rating (required)..."
            rows={3}
            value={localComment}
          />
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">
              {localComment.length} / 500
            </span>
            <div className="flex gap-2">
              <Button onClick={handleCancel} size="sm" variant="ghost">
                Cancel
              </Button>
              <Button
                disabled={
                  submitRating.isPending ||
                  localScore <= 0 ||
                  !hasUnsavedChanges ||
                  localComment.trim().length === 0
                }
                onClick={handleSave}
                size="sm"
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
    </MetadataSection>
  );
}
