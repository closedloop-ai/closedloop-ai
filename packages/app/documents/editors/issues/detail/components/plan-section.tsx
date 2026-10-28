"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { ArtifactRow } from "@repo/app/documents/components/relationships/artifact-row";
import { SelectPlanDialog } from "@repo/app/documents/editors/issues/detail/components/select-plan-dialog";
import { useIssueState } from "@repo/app/documents/editors/issues/detail/use-issue-state";
import { useDeleteArtifactLink } from "@repo/app/documents/hooks/use-artifact-links";
import { useDocument } from "@repo/app/documents/hooks/use-documents";
import { Button } from "@repo/design-system/components/ui/button";
import { SectionHeader } from "@repo/design-system/components/ui/section-header";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useState } from "react";

type PlanSectionProps = {
  feature: DocumentDetail;
  active?: boolean;
};

export function PlanSection({
  feature,
  active = true,
}: Readonly<PlanSectionProps>) {
  const [showSelectModal, setShowSelectModal] = useState(false);
  const [isOpen, setIsOpen] = useState(true);

  const {
    linkedPlanLink,
    linkedPlanId,
    hasPlan: hasLink,
  } = useIssueState(feature, { enabled: active });

  const { data: plan, isLoading: isLoadingPlan } = useDocument(
    linkedPlanId,
    undefined,
    { enabled: active && !!linkedPlanId }
  );

  const deleteLink = useDeleteArtifactLink();

  function handleUnlink(linkId: string) {
    deleteLink.mutate(linkId, {
      onSuccess: () => {
        toast.success("Plan unlinked");
      },
    });
  }

  const hasPlan = hasLink && !!plan;

  return (
    <>
      <div className="bg-background">
        <SectionHeader
          isOpen={isOpen}
          onToggle={() => setIsOpen((prev) => !prev)}
          title="Plan"
        />
        {isOpen ? (
          <>
            {hasPlan ? (
              <div className="flex flex-col border-t">
                <ArtifactRow
                  artifact={plan}
                  linkId={linkedPlanLink?.id ?? null}
                  onDetach={handleUnlink}
                />
              </div>
            ) : null}
            {!(hasPlan || isLoadingPlan) && (
              <div className="flex items-center py-3">
                <div className="flex flex-1 flex-col gap-4">
                  <p className="text-base text-muted-foreground">
                    A plan hasn't been generated for this issue yet
                  </p>
                  <div className="flex gap-3">
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
          </>
        ) : null}
      </div>

      <SelectPlanDialog
        featureId={feature.id}
        onOpenChange={setShowSelectModal}
        open={active && showSelectModal}
        projectId={feature.projectId ?? undefined}
      />
    </>
  );
}
