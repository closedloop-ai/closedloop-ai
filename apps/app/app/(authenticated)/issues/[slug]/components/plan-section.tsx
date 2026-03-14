"use client";

import {
  type Artifact,
  type GenerationStatus,
  isActiveGenerationStatus,
} from "@repo/api/src/types/artifact";
import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { BotIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { NewPlanModal } from "@/app/(authenticated)/implementation-plans/components/new-plan-modal";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import { GenerationStatusIndicator } from "@/components/generation-status-indicator";
import { useArtifact } from "@/hooks/queries/use-artifacts";
import { useDeleteEntityLink } from "@/hooks/queries/use-entity-links";
import { getArtifactRoute } from "@/lib/artifact-navigation";
import {
  ARTIFACT_STATUS_TO_ICON,
  ARTIFACT_TYPE_BADGE_LABELS,
  ARTIFACT_TYPE_ICONS,
} from "@/lib/project-constants";
import { useFeatureState } from "../use-feature-state";
import { OverflowMenu } from "./overflow-menu";
import { SectionHeader } from "./section-header";
import { SelectPlanDialog } from "./select-plan-dialog";

type PlanSectionProps = {
  issue: IssueWithWorkstream;
  showGenerateModal: boolean;
  onGenerateModalChange: (open: boolean) => void;
  generationStatus?: GenerationStatus;
};

export function PlanSection({
  issue,
  showGenerateModal,
  onGenerateModalChange,
  generationStatus,
}: Readonly<PlanSectionProps>) {
  const [showSelectModal, setShowSelectModal] = useState(false);

  const {
    linkedPlanLink,
    linkedPlanId,
    hasPlan: hasLink,
    isReady,
    newPlanSource,
  } = useFeatureState(issue);

  const { data: plan, isLoading: isLoadingPlan } = useArtifact(
    linkedPlanId,
    undefined,
    {
      enabled: !!linkedPlanId,
    }
  );

  const deleteLink = useDeleteEntityLink();

  function handleUnlink(linkId: string) {
    deleteLink.mutate(linkId, {
      onSuccess: () => {
        toast.success("Plan unlinked");
      },
    });
  }

  const hasPlan = hasLink && !!plan;
  const isGeneratingPlan =
    generationStatus?.command === "plan" &&
    isActiveGenerationStatus(generationStatus.status);

  let progressBadgeLabel = "Need description";
  if (isGeneratingPlan) {
    progressBadgeLabel = "Generating…";
  } else if (isReady) {
    progressBadgeLabel = "Ready";
  }

  return (
    <>
      <div className="bg-background">
        <SectionHeader title="Plan">
          {hasPlan || isLoadingPlan ? null : (
            <Badge
              className="gap-1.5 border border-[var(--progress-badge-border)] bg-[var(--progress-badge-bg)] px-2.5 py-1 text-[var(--progress-badge-text)]"
              variant="secondary"
            >
              <BotIcon className="size-3.5" />
              <span>{progressBadgeLabel}</span>
            </Badge>
          )}
        </SectionHeader>
        {hasPlan ? (
          <PlanRow
            linkId={linkedPlanLink!.id}
            onUnlink={handleUnlink}
            plan={plan}
          />
        ) : null}
        {!(hasPlan || isLoadingPlan) && (
          <div className="flex items-center py-3">
            <div className="flex flex-1 flex-col gap-4">
              <p className="text-base text-muted-foreground">
                {isReady
                  ? "A plan has not yet been generated for this feature"
                  : "Need description to generate a plan"}
              </p>
              <div className="flex gap-3">
                <Button
                  disabled={!isReady}
                  onClick={() => onGenerateModalChange(true)}
                  size="sm"
                  variant="default"
                >
                  Generate Plan
                  <SparklesIcon className="ml-1 h-4 w-4" />
                </Button>
                <Button
                  onClick={() => setShowSelectModal(true)}
                  size="sm"
                  variant="outline"
                >
                  Select Existing Plan
                </Button>
              </div>
            </div>
          </div>
        )}
        {isGeneratingPlan && (
          <div className="px-2 py-1">
            <GenerationStatusIndicator generationStatus={generationStatus} />
          </div>
        )}
      </div>

      <NewPlanModal
        onOpenChange={onGenerateModalChange}
        open={showGenerateModal}
        source={newPlanSource}
      />

      <SelectPlanDialog
        issueId={issue.id}
        onOpenChange={setShowSelectModal}
        open={showSelectModal}
        projectId={issue.projectId ?? undefined}
      />
    </>
  );
}

type PlanRowProps = {
  plan: Artifact;
  linkId: string;
  onUnlink: (linkId: string) => void;
};

function PlanRow({ plan, linkId, onUnlink }: Readonly<PlanRowProps>) {
  const Icon = ARTIFACT_TYPE_ICONS[plan.type];
  const badgeLabel = ARTIFACT_TYPE_BADGE_LABELS[plan.type];
  const statusIconStatus = ARTIFACT_STATUS_TO_ICON[plan.status];
  const route = getArtifactRoute(plan);

  return (
    <div className="flex items-center px-2 py-1">
      <Link
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md hover:bg-accent"
        href={route ?? "#"}
      >
        <div className="flex shrink-0 items-center p-1">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <span className="min-w-[60px] shrink-0 truncate font-medium text-muted-foreground text-xs">
          {isDisplayableSlug(plan.slug) ? plan.slug : badgeLabel}
        </span>
        <span className="truncate px-1 font-medium text-sm">{plan.title}</span>
      </Link>
      <div className="flex h-9 shrink-0 items-center gap-2">
        <AssigneeAvatar assignee={plan.assignee} />
        <StatusIcon size={20} status={statusIconStatus} />
        <OverflowMenu linkId={linkId} onUnlink={onUnlink} />
      </div>
    </div>
  );
}
