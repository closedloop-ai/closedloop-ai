"use client";

import type {
  ArtifactStatus,
  ArtifactWithWorkstream,
  GenerationStatus,
  PullRequestInfo,
} from "@repo/api/src/types/artifact";
import { Label } from "@repo/design-system/components/ui/label";
import { Progress } from "@repo/design-system/components/ui/progress";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { ExternalLinkIcon, GitPullRequestIcon } from "lucide-react";
import { useState } from "react";
import { ArtifactVersionInfo } from "@/components/artifact-editor/artifact-version-info";
import { CollapsibleSection } from "@/components/artifact-editor/collapsible-section";
import { CommentsSection } from "@/components/artifact-editor/comments-section";
import {
  MetadataPanel,
  MetadataSection,
} from "@/components/artifact-editor/metadata-panel";
import { StatusMetadataSection } from "@/components/artifact-editor/status-metadata-section";
import { ExecutionLogDialog } from "@/components/execution-log/execution-log-dialog";
import { ExecutionLogSummary } from "@/components/execution-log/execution-log-summary";
import { useExecutionLogDialog } from "@/hooks/use-execution-log-dialog";
import {
  calculateAcceptanceRate,
  sortMetricsByScore,
} from "@/lib/evaluation-utils";
import type { CaseScore } from "@/types/evaluation";
import { JudgeResultCard } from "./judge-result-card";

const PR_STATE_STYLES: Record<string, string> = {
  OPEN: "bg-green-100 text-green-700",
  MERGED: "bg-purple-100 text-purple-700",
  CLOSED: "bg-red-100 text-red-700",
};

type PlanMetadataPanelProps = {
  /**
   * Plan artifact with workstream data
   */
  plan: ArtifactWithWorkstream;
  /**
   * Current artifact status
   */
  status: ArtifactStatus;
  /**
   * Current approver value
   */
  approver: string;
  /**
   * Current owner (User or null if not selected)
   */
  owner: User | null;
  /**
   * List of team members to choose from for owner selection
   */
  teamMembers: User[];
  /**
   * Generation status information (GitHub Actions workflow)
   */
  generationStatus: GenerationStatus | null;
  /**
   * Pull request information if plan has been executed
   */
  pullRequest: PullRequestInfo | null;
  /**
   * Evaluation results for this plan (case-level score with judge metrics)
   */
  evaluationResults?: CaseScore | null;
  /**
   * Handler called when status is changed
   */
  onStatusChange: (status: ArtifactStatus) => void;
  /**
   * Handler called when approver input value changes
   */
  onApproverChange: (approver: string) => void;
  /**
   * Handler called when approver input loses focus
   */
  onApproverBlur: () => void;
  /**
   * Handler called when owner is changed
   */
  onOwnerChange: (user: User | null) => void;
};

/**
 * Metadata panel for Plan editor.
 * Displays status, approver, generation workflow link, pull request info, and artifact metadata.
 */
export function PlanMetadataPanel({
  plan,
  status,
  approver,
  owner,
  teamMembers,
  generationStatus,
  pullRequest,
  evaluationResults,
  onStatusChange,
  onApproverChange,
  onApproverBlur,
  onOwnerChange,
}: PlanMetadataPanelProps): React.ReactElement {
  const {
    dialogOpen,
    dialogTrace,
    selectedSessionId,
    handleViewFullTrace,
    setDialogOpen,
  } = useExecutionLogDialog();

  const [isPropertiesOpen, setIsPropertiesOpen] = useState(true);
  const [isExecutionLogOpen, setIsExecutionLogOpen] = useState(false);
  const [isEvaluationOpen, setIsEvaluationOpen] = useState(false);

  const {
    acceptedCount,
    totalCount,
    rate: acceptanceRate,
  } = calculateAcceptanceRate(evaluationResults?.metrics);

  return (
    <>
      <MetadataPanel title="Implementation Plan Details">
        <div className="space-y-6">
          <CollapsibleSection
            onOpenChange={setIsPropertiesOpen}
            open={isPropertiesOpen}
            title="Properties"
          >
            <StatusMetadataSection
              approver={approver}
              onApproverBlur={onApproverBlur}
              onApproverChange={onApproverChange}
              onOwnerChange={onOwnerChange}
              onStatusChange={onStatusChange}
              owner={owner}
              status={status}
              teamMembers={teamMembers}
            />

            {generationStatus?.htmlUrl ? (
              <MetadataSection separator>
                <Label className="text-muted-foreground text-xs">
                  Generation
                </Label>
                <a
                  className="flex items-center gap-1 text-primary text-sm hover:underline"
                  href={generationStatus.htmlUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  View GitHub Workflow
                  <ExternalLinkIcon className="h-3 w-3" />
                </a>
              </MetadataSection>
            ) : null}

            {pullRequest ? (
              <MetadataSection separator>
                <Label className="text-muted-foreground text-xs">
                  Pull Request
                </Label>
                <a
                  className="flex items-center gap-1 text-primary text-sm hover:underline"
                  href={pullRequest.htmlUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <GitPullRequestIcon className="h-3 w-3" />#
                  {pullRequest.number}: {pullRequest.title}
                  <ExternalLinkIcon className="h-3 w-3" />
                </a>
                <div className="flex items-center gap-2 text-muted-foreground text-xs">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium text-xs ${PR_STATE_STYLES[pullRequest.state]}`}
                  >
                    {pullRequest.state}
                  </span>
                  <span>
                    {pullRequest.headBranch} → {pullRequest.baseBranch}
                  </span>
                </div>
              </MetadataSection>
            ) : null}

            <ArtifactVersionInfo
              createdAt={plan.createdAt}
              updatedAt={plan.updatedAt}
              version={plan.version}
            />
          </CollapsibleSection>

          <CollapsibleSection
            onOpenChange={setIsExecutionLogOpen}
            open={isExecutionLogOpen}
            title="Execution Log"
          >
            <ExecutionLogSummary
              artifactId={plan.id}
              onViewFullTrace={handleViewFullTrace}
            />
          </CollapsibleSection>

          <CollapsibleSection
            onOpenChange={setIsEvaluationOpen}
            open={isEvaluationOpen}
            title="Evaluation"
          >
            <div className="space-y-4">
              {evaluationResults ? (
                <div className="space-y-3">
                  {/* Progress bar showing acceptance rate */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">
                        {acceptedCount}/{totalCount} judges accepted
                      </span>
                      <span className="font-medium">
                        {acceptanceRate.toFixed(0)}%
                      </span>
                    </div>
                    <Progress className="h-2" value={acceptanceRate} />
                  </div>

                  {/* Judge result cards - sorted by score ascending (worst first) */}
                  <div className="space-y-2">
                    {sortMetricsByScore(evaluationResults.metrics).map(
                      (metric) => (
                        <JudgeResultCard
                          key={metric.metric_name}
                          metric={metric}
                        />
                      )
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No evaluation available for this plan
                </p>
              )}
            </div>
          </CollapsibleSection>

          <CommentsSection artifactId={plan.id} />
        </div>
      </MetadataPanel>
      <ExecutionLogDialog
        initialSessionId={selectedSessionId}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
        trace={dialogTrace}
      />
    </>
  );
}
