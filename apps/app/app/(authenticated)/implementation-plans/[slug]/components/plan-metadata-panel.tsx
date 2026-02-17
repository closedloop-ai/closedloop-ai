"use client";

import type {
  ArtifactDetail,
  ArtifactStatus,
  GenerationStatus,
  PullRequestInfo,
} from "@repo/api/src/types/artifact";
import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type { PreviewDeploymentInfo } from "@repo/api/src/types/external-link-utils";
import { Label } from "@repo/design-system/components/ui/label";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { ExternalLinkIcon } from "lucide-react";
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
import { useOrganizationUsers } from "@/hooks/queries/use-users";
import { useExecutionLogDialog } from "@/hooks/use-execution-log-dialog";
import { transformApiUserToSelectUser } from "@/lib/user-utils";
import { EvaluationSection } from "./evaluation-section";
import { PerformanceSection } from "./performance-section";
import { PreviewDeploymentSection } from "./preview-deployment-section";
import { PullRequestSection } from "./pull-request-section";
import { SourceArtifactSection } from "./source-artifact-section";

export type PlanMetadataPanelProps = {
  plan: ArtifactDetail;
  status: ArtifactStatus;
  approver: User | null;
  owner: User | null;
  teamMembers: User[];
  generationStatus: GenerationStatus | null;
  pullRequest: PullRequestInfo | null;
  previewDeployment: PreviewDeploymentInfo | null;
  onPreviewRefresh: () => void;
  isPreviewRefreshing: boolean;
  judgesReport: JudgesReport | null;
  onStatusChange: (status: ArtifactStatus) => void;
  onApproverSelect: (user: User | null) => void;
  onOwnerChange: (user: User | null) => void;
  targetRepo: string;
  targetBranch: string;
};

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
  targetRepo = "Inherited from project",
  targetBranch = "main",
}: PlanMetadataPanelProps) {
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
  const [isRatingOpen, setIsRatingOpen] = useState(true);

  const projectId = plan.projectId ?? plan.project?.id;

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
              <h4 className="font-medium text-sm">Target Repository</h4>
              <div className="space-y-2">
                <Label className="text-muted-foreground text-xs">
                  Repository
                </Label>
                <p className="text-muted-foreground text-sm">{targetRepo}</p>
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground text-xs">Branch</Label>
                <p className="text-muted-foreground text-sm">{targetBranch}</p>
              </div>
            </MetadataSection>

            <SourceArtifactSection artifactId={plan.id} projectId={projectId} />

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
              <PullRequestSection pullRequest={pullRequest} />
            ) : null}

            {previewDeployment ? (
              <PreviewDeploymentSection
                isRefreshing={isPreviewRefreshing}
                onRefresh={onPreviewRefresh}
                previewDeployment={previewDeployment}
              />
            ) : null}

            <ArtifactVersionInfo
              createdAt={plan.version.createdAt}
              updatedAt={plan.updatedAt}
              version={plan.version.version}
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

          <EvaluationSection judgesReport={judgesReport} />

          <PerformanceSection artifactId={plan.id} />

          <CollapsibleSection
            onOpenChange={setIsRatingOpen}
            open={isRatingOpen}
            title="Rating"
          >
            <RatingSection
              artifactId={plan.id}
              currentPlanVersion={plan.version.version}
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
