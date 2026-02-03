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
import {
  MetadataSection,
  TabbedMetadataPanel,
} from "@/components/artifact-editor/metadata-panel";
import { StatusMetadataSection } from "@/components/artifact-editor/status-metadata-section";
import { ExecutionLogSummary } from "@/components/execution-log/execution-log-summary";
import type { CaseScore, MetricStatistics } from "@/types/evaluation";
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
 *
 * Usage:
 * ```tsx
 * <PlanMetadataPanel
 *   plan={plan}
 *   status={status}
 *   approver={approver}
 *   owner={owner}
 *   teamMembers={teamMembers}
 *   generationStatus={generationStatus}
 *   pullRequest={pullRequest}
 *   onStatusChange={handleStatusChange}
 *   onApproverChange={handleApproverChange}
 *   onApproverBlur={handleApproverBlur}
 *   onOwnerChange={handleOwnerChange}
 * />
 * ```
 */
/**
 * Calculate acceptance rate from evaluation metrics.
 * A metric is considered "accepted" if its mean score is >= its threshold.
 * Only metrics with non-null thresholds are included in the calculation.
 */
export function calculateAcceptanceRate(
  metrics: MetricStatistics[] | undefined
): {
  acceptedCount: number;
  totalCount: number;
  rate: number;
} {
  if (!metrics || metrics.length === 0) {
    return { acceptedCount: 0, totalCount: 0, rate: 0 };
  }

  const acceptedCount = metrics.filter(
    (m) => m.threshold !== null && m.mean >= m.threshold
  ).length;
  const totalCount = metrics.length;
  const rate = (acceptedCount / totalCount) * 100;

  return { acceptedCount, totalCount, rate };
}

/**
 * Sort metrics by score in ascending order (worst/lowest first).
 * This brings attention to metrics that need improvement.
 */
export function sortMetricsByScore(
  metrics: MetricStatistics[]
): MetricStatistics[] {
  return [...metrics].sort((a, b) => a.mean - b.mean);
}

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
}: PlanMetadataPanelProps) {
  const {
    acceptedCount,
    totalCount,
    rate: acceptanceRate,
  } = calculateAcceptanceRate(evaluationResults?.metrics);

  // TODO: Implement ExecutionLogDialog to display full trace when user clicks "View Full Trace"
  // For now, this is a no-op until the dialog component is created
  const handleViewFullTrace = () => {};

  return (
    <TabbedMetadataPanel
      tabs={[
        {
          id: "details",
          label: "Details",
          content: (
            <div className="space-y-4">
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

              <MetadataSection separator>
                <div className="space-y-1 text-muted-foreground text-sm">
                  <p>Version: v{plan.version}</p>
                  <p>
                    Created:{" "}
                    {new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                    }).format(new Date(plan.createdAt))}
                  </p>
                  <p>
                    Updated:{" "}
                    {new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                    }).format(new Date(plan.updatedAt))}
                  </p>
                </div>
              </MetadataSection>

              {/* GitHub Action Run Link */}
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

              {/* Pull Request Link */}
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
            </div>
          ),
        },
        {
          id: "execution-log",
          label: "Execution Log",
          content: (
            <ExecutionLogSummary
              artifactId={plan.id}
              onViewFullTrace={handleViewFullTrace}
            />
          ),
        },
        {
          id: "evaluation",
          label: "Evaluation",
          content: (
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
          ),
        },
      ]}
    />
  );
}
