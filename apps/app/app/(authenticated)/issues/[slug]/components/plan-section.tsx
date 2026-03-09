"use client";

import type { Artifact } from "@repo/api/src/types/artifact";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { PlusIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { NewPlanModal } from "@/app/(authenticated)/implementation-plans/components/new-plan-modal";
import type { PlanSource } from "@/app/(authenticated)/implementation-plans/components/plan-source";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import { useArtifact } from "@/hooks/queries/use-artifacts";
import {
  useDeleteEntityLink,
  useTargetLinks,
} from "@/hooks/queries/use-entity-links";
import { getArtifactRoute } from "@/lib/artifact-navigation";
import {
  ARTIFACT_STATUS_TO_ICON,
  ARTIFACT_TYPE_BADGE_LABELS,
  ARTIFACT_TYPE_ICONS,
} from "@/lib/project-constants";
import { OverflowMenu } from "./overflow-menu";
import { SectionHeader } from "./section-header";
import { SelectPlanDialog } from "./select-plan-dialog";

type PlanSectionProps = {
  issue: IssueWithWorkstream;
};

export function PlanSection({ issue }: Readonly<PlanSectionProps>) {
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showSelectModal, setShowSelectModal] = useState(false);

  const { data: targetLinks = [] } = useTargetLinks(
    issue.id,
    EntityType.Issue,
    LinkType.Produces
  );

  const linkedPlanLink = targetLinks.find(
    (link) => link.targetType === EntityType.Artifact
  );
  const linkedPlanId = linkedPlanLink?.targetId ?? "";

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

  const newPlanSource: PlanSource = useMemo(() => {
    return {
      ...issue,
      sourceType: EntityType.Issue,
    };
  }, [issue]);

  const hasPlan = !!linkedPlanId && !!plan;

  return (
    <>
      <div className="overflow-hidden rounded-lg border bg-background">
        <SectionHeader title="Plan">
          {isLoadingPlan || hasPlan ? null : (
            <>
              <Button
                onClick={() => setShowGenerateModal(true)}
                size="sm"
                variant="default"
              >
                Generate
                <SparklesIcon className="ml-1 h-4 w-4" />
              </Button>
              <Button
                onClick={() => setShowSelectModal(true)}
                size="sm"
                variant="outline"
              >
                Add Plan
                <PlusIcon className="ml-1 h-4 w-4" />
              </Button>
            </>
          )}
        </SectionHeader>
        {hasPlan ? (
          <PlanRow
            linkId={linkedPlanLink!.id}
            onUnlink={handleUnlink}
            plan={plan}
          />
        ) : null}
      </div>

      <NewPlanModal
        onOpenChange={setShowGenerateModal}
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
