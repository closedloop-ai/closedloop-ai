"use client";

import { DocumentRatingSection } from "@repo/app/documents/components/document-rating-section";
import {
  useDocumentRating,
  useSubmitRating,
} from "@repo/app/ratings/hooks/use-document-rating";
import { useEffect, useState } from "react";

type RatingSectionProps = {
  documentId: string;
  currentPlanVersion: number;
};

export function RatingSection({
  documentId,
  currentPlanVersion,
}: Readonly<RatingSectionProps>): React.ReactElement {
  const [selectedScore, setSelectedScore] = useState<number | null>(null);
  const [commentDraft, setCommentDraft] = useState("");

  const { data: summary, isLoading } = useDocumentRating(documentId);
  const submitRating = useSubmitRating();

  const userRating = summary?.userRating;

  useEffect(() => {
    if (userRating) {
      setCommentDraft(userRating.comment ?? "");
    }
  }, [userRating]);

  return (
    <DocumentRatingSection
      commentDraft={commentDraft}
      currentDocumentVersion={currentPlanVersion}
      isLoading={isLoading}
      isSaving={submitRating.isPending}
      onCancelComment={() => setCommentDraft(userRating?.comment ?? "")}
      onCommentChange={setCommentDraft}
      onSaveComment={() => {
        const currentScore = userRating?.score ?? selectedScore ?? 0;
        submitRating.mutate({
          documentId,
          score: currentScore,
          comment: commentDraft,
        });
      }}
      onScoreChange={(score) => {
        setSelectedScore(score);
        submitRating.mutate({
          documentId,
          score,
          comment: commentDraft || userRating?.comment,
        });
      }}
      selectedScore={selectedScore}
      summary={summary ?? null}
    />
  );
}
