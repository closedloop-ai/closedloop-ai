"use client";

import type {
  DocumentDetail,
  GenerationStatus,
} from "@repo/api/src/types/document";
import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { RatingSection } from "@repo/app/documents/components/editor/rating-section";
import { EvaluationSection } from "@repo/app/documents/components/evaluation-section";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { CollapsibleSection } from "@repo/design-system/components/ui/collapsible-section";
import { Label } from "@repo/design-system/components/ui/label";
import { MetadataSection } from "@repo/design-system/components/ui/metadata-panel";
import { Link } from "@repo/navigation/link";
import { useState } from "react";
import { useOrgSlug } from "@/hooks/use-org-slug";

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
  const orgSlug = useOrgSlug();
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
            href={`/${orgSlug}/loops/${generationStatus.loopId}`}
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
    return <Badge variant="success">Completed</Badge>;
  }
  if (status === "FAILURE") {
    // Use destructive's semantic tokens but keep the existing LIGHT tint:
    // the `destructive` variant renders a solid red fill (bg-destructive
    // text-white), which would make this pill visually heavier than its
    // success/info/warning siblings. Override with the variant's light
    // tokens to preserve the original light pill and sibling consistency.
    return (
      <Badge
        className="border-destructive/25 bg-destructive/12 text-destructive"
        variant="destructive"
      >
        Failed
      </Badge>
    );
  }
  if (status === "RUNNING") {
    return <Badge variant="info">Running</Badge>;
  }
  // PENDING or QUEUED
  return <Badge variant="warning">Queued</Badge>;
}
