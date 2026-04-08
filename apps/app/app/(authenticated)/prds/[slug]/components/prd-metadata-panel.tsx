"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import type { ArtifactDetail } from "@repo/api/src/types/artifact";
import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import { ArtifactVersionInfo } from "@/components/artifact-editor/artifact-version-info";
import { AttachmentsSection } from "@/components/artifact-editor/attachments-section";
import { CommentsSection } from "@/components/artifact-editor/comments-section";
import { EvaluationSection } from "@/components/artifact-editor/evaluation-section";
import { MetadataPanel } from "@/components/artifact-editor/metadata-panel";

type PRDMetadataPanelProps = {
  /**
   * PRD artifact with workstream data
   */
  prd: ArtifactDetail;
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
export function PRDMetadataPanel({
  prd,
  judgeItems,
  variant = "sidebar",
}: PRDMetadataPanelProps) {
  const detailsContent = (
    <div className="space-y-6">
      <AttachmentsSection artifactId={prd.id} />

      <EvaluationSection
        artifactId={prd.id}
        judgeItems={judgeItems ?? null}
        title="Agent Evaluation"
      />

      <FeatureFlagged flag="the-one-flag">
        <CommentsSection artifactId={prd.id} />
      </FeatureFlagged>

      <ArtifactVersionInfo
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
