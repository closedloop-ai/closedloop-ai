"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { RatingSection } from "@repo/app/documents/components/editor/rating-section";
import { EvaluationSection } from "@repo/app/documents/components/evaluation-section";
import { CollapsibleSection } from "@repo/design-system/components/ui/collapsible-section";
import { MetadataSection } from "@repo/design-system/components/ui/metadata-panel";
import { useState } from "react";

export type PlanMetadataPanelProps = {
  plan: DocumentDetail;
  codeJudgeItems: JudgeFeedbackItem[] | null;
  additionalRepos?: AdditionalRepoRef[] | null;
};

/**
 * Plan-specific modules that aren't shared across document subtypes.
 * Attachments, agent evaluation, source document, comments and version info
 * live in the shared below-editor container in `plan-editor.tsx`.
 */
export function PlanMetadataPanel({
  plan,
  codeJudgeItems,
  additionalRepos,
}: PlanMetadataPanelProps) {
  const [isRatingOpen, setIsRatingOpen] = useState(false);

  return (
    <div className="space-y-6">
      <AdditionalReposSection additionalRepos={additionalRepos} />

      <EvaluationSection
        documentId={plan.id}
        emptyMessage="Code judge feedback is not available yet"
        judgeItems={codeJudgeItems}
        title="Code Evaluation"
      />

      <CollapsibleSection
        onOpenChange={setIsRatingOpen}
        open={isRatingOpen}
        title="Rating"
      >
        <RatingSection
          currentPlanVersion={plan.version.version}
          documentId={plan.id}
        />
      </CollapsibleSection>
    </div>
  );
}

/**
 * The extra repositories this plan was generated against.
 *
 * ISS-5474: this used to hang off a "Loop" section that also carried the run's
 * status badge, who started it, and a link into the Loop detail page. The
 * product no longer has a Loops concept, so all of that went; the repository
 * list is plan provenance rather than run state, so it survives on its own and
 * is now gated on having repositories instead of on a loop-sourced run.
 */
function AdditionalReposSection({
  additionalRepos,
}: {
  additionalRepos?: AdditionalRepoRef[] | null;
}) {
  if (!additionalRepos || additionalRepos.length === 0) {
    return null;
  }
  return (
    <MetadataSection separator>
      <h4 className="font-medium text-sm">Additional Repositories</h4>
      <ul className="space-y-0.5">
        {additionalRepos.map((repo) => (
          <li
            className="text-muted-foreground text-xs"
            key={`${repo.fullName}:${repo.branch}`}
          >
            <span className="font-medium">{repo.fullName}</span>
            <span className="opacity-70"> ({repo.branch})</span>
          </li>
        ))}
      </ul>
    </MetadataSection>
  );
}
