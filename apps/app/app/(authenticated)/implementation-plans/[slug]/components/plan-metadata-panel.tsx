"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import type {
  DocumentDetail,
  GenerationStatus,
} from "@repo/api/src/types/document";
import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { Label } from "@repo/design-system/components/ui/label";
import Link from "next/link";
import { useState } from "react";
import { CollapsibleSection } from "@/components/document-editor/collapsible-section";
import { EvaluationSection } from "@/components/document-editor/evaluation-section";
import { MetadataSection } from "@/components/document-editor/metadata-panel";
import { RatingSection } from "@/components/document-editor/rating-section";
import { getUserDisplayName } from "@/lib/user-utils";
import { PerformanceSection } from "./performance-section";

export type PlanMetadataPanelProps = {
  plan: DocumentDetail;
  generationStatus: GenerationStatus | null;
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
  generationStatus,
  codeJudgeItems,
  additionalRepos,
}: PlanMetadataPanelProps) {
  const [isRatingOpen, setIsRatingOpen] = useState(false);

  return (
    <div className="space-y-6">
      <GenerationSection
        additionalRepos={additionalRepos}
        generationStatus={generationStatus}
      />

      <EvaluationSection
        documentId={plan.id}
        emptyMessage="Code judge feedback is not available yet"
        judgeItems={codeJudgeItems}
        title="Code Evaluation"
      />

      <FeatureFlagged flag="the-one-flag">
        <PerformanceSection documentId={plan.id} />
      </FeatureFlagged>

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

/** Renders loop generation info in the metadata sidebar. */
function GenerationSection({
  generationStatus,
  additionalRepos,
}: {
  generationStatus: GenerationStatus | null;
  additionalRepos?: AdditionalRepoRef[] | null;
}) {
  if (generationStatus?.source === "loop" && generationStatus.loopId) {
    return (
      <MetadataSection separator>
        <Label className="text-muted-foreground text-xs">Loop</Label>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-sm">Status:</span>
            <LoopStatusBadge status={generationStatus.status} />
          </div>
          {generationStatus.initiatedBy ? (
            <p className="text-muted-foreground text-sm">
              Initiated by {getUserDisplayName(generationStatus.initiatedBy)}
            </p>
          ) : null}
          <Link
            className="flex items-center gap-1 text-primary text-sm hover:underline"
            href={`/loops/${generationStatus.loopId}`}
          >
            View loop details
          </Link>
          {additionalRepos && additionalRepos.length > 0 ? (
            <div className="space-y-1">
              <span className="text-muted-foreground text-xs">
                Additional Repositories
              </span>
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
            </div>
          ) : null}
        </div>
      </MetadataSection>
    );
  }

  return null;
}

/** Small inline badge for loop status display in the metadata sidebar. */
function LoopStatusBadge({ status }: { status: GenerationStatus["status"] }) {
  if (status === "NONE") {
    return null;
  }
  if (status === "SUCCESS") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-green-700 text-xs dark:bg-green-900/30 dark:text-green-300">
        Completed
      </span>
    );
  }
  if (status === "FAILURE") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-red-700 text-xs dark:bg-red-900/30 dark:text-red-300">
        Failed
      </span>
    );
  }
  if (status === "RUNNING") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-blue-700 text-xs dark:bg-blue-900/30 dark:text-blue-300">
        Running
      </span>
    );
  }
  // PENDING or QUEUED
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300">
      Queued
    </span>
  );
}
