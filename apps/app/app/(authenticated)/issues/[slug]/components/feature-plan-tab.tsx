"use client";

import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { Button } from "@repo/design-system/components/ui/button";
import { keepPreviousData } from "@tanstack/react-query";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import Image from "next/image";
import { useMemo, useState } from "react";
import { PlanEditor } from "@/app/(authenticated)/implementation-plans/[slug]/plan-editor";
import { NewPlanModal } from "@/app/(authenticated)/implementation-plans/components/new-plan-modal";
import type { PlanSource } from "@/app/(authenticated)/implementation-plans/components/plan-source";
import { useArtifact } from "@/hooks/queries/use-artifacts";
import { useTargetLinks } from "@/hooks/queries/use-entity-links";
import { SelectPlanDialog } from "./select-plan-dialog";

type FeaturePlanTabProps = {
  issue: IssueWithWorkstream;
};

export function FeaturePlanTab({ issue }: Readonly<FeaturePlanTabProps>) {
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showSelectModal, setShowSelectModal] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>();

  const newPlanSource: PlanSource = useMemo(() => {
    return {
      ...issue,
      sourceType: EntityType.Issue,
    };
  }, [issue]);

  // Find linked plan via entity links
  const { data: targetLinks = [] } = useTargetLinks(
    issue.id,
    EntityType.Issue,
    LinkType.Produces
  );
  const linkedPlanId =
    targetLinks.find((link) => link.targetType === EntityType.Artifact)
      ?.targetId ?? "";

  // Fetch the full plan detail when a link exists
  const { data: plan, isLoading: isPlanLoading } = useArtifact(
    linkedPlanId,
    selectedVersion,
    {
      enabled: !!linkedPlanId,
      placeholderData: keepPreviousData,
    }
  );

  const handleVersionChange = (version: number) => {
    if (plan && version === plan.latestVersion) {
      setSelectedVersion(undefined);
    } else {
      setSelectedVersion(version);
    }
  };

  // Show the plan editor when a linked plan is loaded
  if (linkedPlanId && plan) {
    return (
      <PlanEditor
        currentVersion={plan.version.version}
        latestVersion={plan.latestVersion}
        onVersionChange={handleVersionChange}
        plan={plan}
        showHeader={false}
      />
    );
  }

  // Show spinner while fetching a linked plan
  if (linkedPlanId && isPlanLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-10">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Empty state — no plan linked yet
  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10">
        <div className="flex flex-col items-center gap-4 text-center">
          <Image
            alt="Implementation plan illustration"
            className="h-[146px] w-[168px]"
            height={146}
            src="/plan-empty-state.png"
            width={168}
          />
          <div className="flex flex-col gap-1.5">
            <h2 className="font-semibold text-2xl tracking-tight">
              Create Implementation Plan
            </h2>
            <p className="text-base text-muted-foreground">
              A plan has not yet been generated for this feature
            </p>
          </div>
          <div className="mt-4 flex flex-col gap-3">
            <Button
              className="w-[200px]"
              onClick={() => setShowGenerateModal(true)}
              size="lg"
            >
              Generate Plan
              <SparklesIcon className="ml-2 h-4 w-4" />
            </Button>
            <Button
              className="w-[200px]"
              onClick={() => setShowSelectModal(true)}
              size="lg"
              variant="secondary"
            >
              Select Existing Plan
            </Button>
          </div>
        </div>
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
