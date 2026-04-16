"use client";

import {
  type Document,
  type GenerationStatus,
  isActiveGenerationStatus,
} from "@repo/api/src/types/document";
import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
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
import { useDocument } from "@/hooks/queries/use-documents";
import { useDeleteEntityLink } from "@/hooks/queries/use-entity-links";
import { getDocumentRoute } from "@/lib/document-navigation";
import {
  DOCUMENT_STATUS_TO_ICON,
  DOCUMENT_TYPE_BADGE_LABELS,
  DOCUMENT_TYPE_ICONS,
} from "@/lib/project-constants";
import { useFeatureState } from "../use-feature-state";
import { OverflowMenu } from "./overflow-menu";
import { SectionHeader } from "./section-header";
import { SelectPlanDialog } from "./select-plan-dialog";

type PlanSectionProps = {
  feature: FeatureWithWorkstream;
  showGenerateModal: boolean;
  onGenerateModalChange: (open: boolean) => void;
  generationStatus?: GenerationStatus;
};

export function PlanSection({
  feature,
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
  } = useFeatureState(feature);

  const { data: plan, isLoading: isLoadingPlan } = useDocument(linkedPlanId);

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
                  <SparklesIcon className="h-4 w-4" />
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
        featureId={feature.id}
        onOpenChange={setShowSelectModal}
        open={showSelectModal}
        projectId={feature.projectId ?? undefined}
      />
    </>
  );
}

type PlanRowProps = {
  plan: Document;
  linkId: string;
  onUnlink: (linkId: string) => void;
};

function PlanRow({ plan, linkId, onUnlink }: Readonly<PlanRowProps>) {
  const Icon = DOCUMENT_TYPE_ICONS[plan.type];
  const badgeLabel = DOCUMENT_TYPE_BADGE_LABELS[plan.type];
  const statusIconStatus = DOCUMENT_STATUS_TO_ICON[plan.status];
  const route = getDocumentRoute(plan);

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
