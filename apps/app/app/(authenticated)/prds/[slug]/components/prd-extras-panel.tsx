"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import type { DocumentDetail } from "@repo/api/src/types/document";
import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import { AttachmentsSection } from "@/components/document-editor/attachments-section";
import { CommentsSection } from "@/components/document-editor/comments-section";
import { DocumentVersionInfo } from "@/components/document-editor/document-version-info";
import { EvaluationSection } from "@/components/document-editor/evaluation-section";
import { MetadataPanel } from "@/components/document-editor/metadata-panel";

type PRDExtrasPanelProps = {
  /**
   * PRD artifact with workstream data
   */
  prd: DocumentDetail;
  /**
   * Judge feedback items for the evaluation section
   */
  judgeItems?: JudgeFeedbackItem[] | null;
  /**
   * When "detailsOnly", render only the details content (no sidebar wrapper).
   */
  variant?: "detailsOnly" | "sidebar";
};

/**
 * Metadata panel for PRD editor.
 * Displays evaluation, comments, attachments, and version info.
 */
export function PRDExtrasPanel({
  prd,
  judgeItems,
  variant = "sidebar",
}: Readonly<PRDExtrasPanelProps>) {
  const detailsContent = (
    <div className="space-y-6">
      <AttachmentsSection documentId={prd.id} />

      <EvaluationSection
        documentId={prd.id}
        judgeItems={judgeItems ?? null}
        title="Agent Evaluation"
      />

      <FeatureFlagged flag="the-one-flag">
        <CommentsSection documentId={prd.id} />
      </FeatureFlagged>

      <DocumentVersionInfo
        createdAt={prd.version.createdAt}
        updatedAt={prd.updatedAt}
      />
    </div>
  );

  if (variant === "detailsOnly") {
    return detailsContent;
  }

  return <MetadataPanel title="PRD Details">{detailsContent}</MetadataPanel>;
}
