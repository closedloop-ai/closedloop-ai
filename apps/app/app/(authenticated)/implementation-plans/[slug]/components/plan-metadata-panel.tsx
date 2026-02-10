"use client";

import type {
  ArtifactStatus,
  ArtifactWithWorkstream,
  GenerationStatus,
  PreviewDeployment,
  PullRequestInfo,
} from "@repo/api/src/types/artifact";
import type { JudgesReport } from "@repo/api/src/types/evaluation";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/design-system/components/ui/command";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { Progress } from "@repo/design-system/components/ui/progress";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { cn } from "@repo/design-system/lib/utils";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GitPullRequestIcon,
  LinkIcon,
  RefreshCwIcon,
  UnlinkIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ArtifactVersionInfo } from "@/components/artifact-editor/artifact-version-info";
import { CollapsibleSection } from "@/components/artifact-editor/collapsible-section";
import { CommentsSection } from "@/components/artifact-editor/comments-section";
import {
  MetadataPanel,
  MetadataSection,
} from "@/components/artifact-editor/metadata-panel";
import { RatingSection } from "@/components/artifact-editor/rating-section";
import { StatusMetadataSection } from "@/components/artifact-editor/status-metadata-section";
import { ExecutionLogDialog } from "@/components/execution-log/execution-log-dialog";
import { ExecutionLogSummary } from "@/components/execution-log/execution-log-summary";
import {
  previewDeploymentStateColors,
  pullRequestStateColors,
  StatusBadge,
} from "@/components/status-badge";
import { useArtifactsByProject } from "@/hooks/queries/use-artifacts";
import { useOrganizationUsers } from "@/hooks/queries/use-users";
import { useExecutionLogDialog } from "@/hooks/use-execution-log-dialog";
import { getArtifactDetailUrl } from "@/lib/artifact-url-utils";
import {
  calculateAcceptanceRate,
  sortMetricsByScore,
} from "@/lib/evaluation-utils";
import {
  ARTIFACT_SUBTYPE_ICONS,
  ARTIFACT_SUBTYPE_LABELS,
} from "@/lib/project-constants";
import { transformApiUserToSelectUser } from "@/lib/user-utils";
import { JudgeResultCard } from "./judge-result-card";

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
   * Current approver (User or null if not selected)
   */
  approver: User | null;
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
   * Preview deployment information if available
   */
  previewDeployment: PreviewDeployment | null;
  /**
   * Refresh preview deployment status
   */
  onPreviewRefresh: () => Promise<PreviewDeployment | null>;
  /**
   * Whether a preview refresh is in flight
   */
  isPreviewRefreshing: boolean;
  /**
   * Judges report containing evaluation results for all judges
   */
  judgesReport: JudgesReport | null;
  /**
   * Handler called when status is changed
   */
  onStatusChange: (status: ArtifactStatus) => void;
  /**
   * Handler called when approver is selected
   */
  onApproverSelect: (user: User | null) => void;
  /**
   * Handler called when owner is changed
   */
  onOwnerChange: (user: User | null) => void;
  /**
   * Handler called when parent artifact is changed
   */
  onParentChange: (parentId: string | null) => void;
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
  previewDeployment,
  onPreviewRefresh,
  isPreviewRefreshing,
  judgesReport,
  onStatusChange,
  onApproverSelect,
  onOwnerChange,
  onParentChange,
}: PlanMetadataPanelProps) {
  // Fetch org users for approver dropdown
  const { data: orgUsers = [] } = useOrganizationUsers();
  const transformedOrgUsers = useMemo(
    () => orgUsers.map(transformApiUserToSelectUser),
    [orgUsers]
  );

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
  const [isRatingOpen, setIsRatingOpen] = useState(true);
  const [isParentSelectorOpen, setIsParentSelectorOpen] = useState(false);

  // Fetch artifacts in the same project for parent selection (PRDs, Issues, Bugs)
  const projectId = plan.projectId ?? plan.project?.id;
  const { data: projectArtifacts = [] } = useArtifactsByProject(
    projectId ?? "",
    true,
    { enabled: !!projectId }
  );

  // Filter to only PRDs, Issues, and Bugs (valid parent types)
  const parentCandidates = useMemo(
    () =>
      projectArtifacts.filter(
        (a) =>
          (a.subtype === "PRD" ||
            a.subtype === "ISSUE" ||
            a.subtype === "BUG") &&
          a.id !== plan.id
      ),
    [projectArtifacts, plan.id]
  );

  // Calculate acceptance rate from all judges in the report
  const allMetrics =
    judgesReport?.stats.flatMap((caseScore) => caseScore.metrics) ?? [];
  const {
    acceptedCount,
    totalCount,
    rate: acceptanceRate,
  } = calculateAcceptanceRate(allMetrics);

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
              onApproverSelect={onApproverSelect}
              onOwnerChange={onOwnerChange}
              onStatusChange={onStatusChange}
              orgUsers={transformedOrgUsers}
              owner={owner}
              status={status}
              teamMembers={teamMembers}
            />

            <MetadataSection separator>
              <Label className="text-muted-foreground text-xs">
                Source Artifact
              </Label>
              {plan.parent ? (
                <div className="flex items-center justify-between gap-2">
                  <Link
                    className="flex min-w-0 items-center gap-1.5 text-primary text-sm hover:underline"
                    href={
                      getArtifactDetailUrl(
                        plan.parent.subtype,
                        plan.parent.documentSlug
                      ) ?? "#"
                    }
                  >
                    {(() => {
                      const Icon =
                        ARTIFACT_SUBTYPE_ICONS[plan.parent.subtype] ??
                        FileTextIcon;
                      return <Icon className="h-3.5 w-3.5 shrink-0" />;
                    })()}
                    <span className="truncate">{plan.parent.title}</span>
                    <span className="shrink-0 text-muted-foreground text-xs">
                      {ARTIFACT_SUBTYPE_LABELS[plan.parent.subtype] ??
                        plan.parent.subtype}
                    </span>
                  </Link>
                  <Button
                    aria-label="Unlink source artifact"
                    onClick={() => onParentChange(null)}
                    size="icon"
                    variant="ghost"
                  >
                    <UnlinkIcon className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <Popover
                  onOpenChange={setIsParentSelectorOpen}
                  open={isParentSelectorOpen}
                >
                  <PopoverTrigger asChild>
                    <Button
                      className="w-full justify-start gap-2 text-muted-foreground"
                      size="sm"
                      variant="outline"
                    >
                      <LinkIcon className="h-3.5 w-3.5" />
                      Link Source Artifact
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-72 p-0">
                    <Command>
                      <CommandInput placeholder="Search artifacts..." />
                      <CommandList>
                        <CommandEmpty>No artifacts found.</CommandEmpty>
                        <CommandGroup>
                          {parentCandidates.map((artifact) => {
                            const Icon =
                              ARTIFACT_SUBTYPE_ICONS[artifact.subtype] ??
                              FileTextIcon;
                            return (
                              <CommandItem
                                key={artifact.id}
                                onSelect={() => {
                                  onParentChange(artifact.id);
                                  setIsParentSelectorOpen(false);
                                }}
                                value={`${artifact.title} ${ARTIFACT_SUBTYPE_LABELS[artifact.subtype] ?? artifact.subtype}`}
                              >
                                <Icon className="mr-2 h-3.5 w-3.5 shrink-0" />
                                <span className="truncate">
                                  {artifact.title}
                                </span>
                                <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                                  {ARTIFACT_SUBTYPE_LABELS[artifact.subtype] ??
                                    artifact.subtype}
                                </span>
                              </CommandItem>
                            );
                          })}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              )}
            </MetadataSection>

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
                  <StatusBadge
                    className="px-2 py-0.5 text-xs uppercase"
                    colorMap={pullRequestStateColors}
                    status={pullRequest.state}
                  />
                  <span>
                    {pullRequest.headBranch} → {pullRequest.baseBranch}
                  </span>
                </div>
              </MetadataSection>
            ) : null}

            {previewDeployment ? (
              <MetadataSection separator>
                <div className="flex items-center justify-between">
                  <Label className="text-muted-foreground text-xs">
                    Preview
                  </Label>
                  <Button
                    aria-label="Refresh preview deployment status"
                    disabled={isPreviewRefreshing}
                    onClick={() => {
                      onPreviewRefresh().catch((error: unknown) => {
                        console.warn(
                          "[preview-refresh] Failed to refresh preview deployment",
                          error
                        );
                      });
                    }}
                    size="icon"
                    variant="ghost"
                  >
                    <RefreshCwIcon
                      className={cn(
                        "h-3 w-3",
                        isPreviewRefreshing && "animate-spin"
                      )}
                    />
                  </Button>
                </div>
                <div className="space-y-2">
                  {previewDeployment.url ? (
                    <a
                      className="flex items-center gap-1 text-primary text-sm hover:underline"
                      href={previewDeployment.url}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      Open Preview
                      <ExternalLinkIcon className="h-3 w-3" />
                    </a>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      Preview link not available yet.
                    </p>
                  )}
                  <div className="text-muted-foreground text-xs">
                    <span className="mr-2">
                      {previewDeployment.environment
                        ? `Environment: ${previewDeployment.environment}`
                        : "Environment: preview"}
                    </span>
                    {previewDeployment.state ? (
                      <StatusBadge
                        className="px-1.5 py-0 text-xs uppercase"
                        colorMap={previewDeploymentStateColors}
                        defaultStyle="bg-muted text-muted-foreground border-muted"
                        status={previewDeployment.state.toUpperCase()}
                      />
                    ) : null}
                  </div>
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

          <Collapsible
            onOpenChange={setIsEvaluationOpen}
            open={isEvaluationOpen}
          >
            <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg p-3 font-medium text-sm transition-colors hover:bg-accent">
              <span>Evaluation</span>
              {isEvaluationOpen ? (
                <ChevronUpIcon className="h-4 w-4" />
              ) : (
                <ChevronDownIcon className="h-4 w-4" />
              )}
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 px-3 pb-3">
              {judgesReport === null && (
                <p className="text-muted-foreground text-sm">
                  Awaiting LLM Judges feedback
                </p>
              )}
              {judgesReport !== null && judgesReport.stats.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  No judges have been evaluated yet
                </p>
              )}
              {judgesReport !== null && judgesReport.stats.length > 0 && (
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

                  {/* Judge result cards - all judges from the report */}
                  <div className="space-y-2">
                    {judgesReport.stats.map((caseScore) =>
                      sortMetricsByScore(caseScore.metrics).map((metric) => (
                        <JudgeResultCard
                          key={`${caseScore.case_id}-${metric.metric_name}`}
                          metric={metric}
                        />
                      ))
                    )}
                  </div>
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>

          <CollapsibleSection
            onOpenChange={setIsRatingOpen}
            open={isRatingOpen}
            title="Rating"
          >
            <RatingSection
              artifactId={plan.id}
              currentPlanVersion={plan.version}
            />
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
