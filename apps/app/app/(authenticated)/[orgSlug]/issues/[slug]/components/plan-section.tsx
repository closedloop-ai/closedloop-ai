"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { ArtifactRow } from "@repo/app/documents/components/relationships/artifact-row";
import { useDeleteArtifactLink } from "@repo/app/documents/hooks/use-artifact-links";
import { useDocument } from "@repo/app/documents/hooks/use-documents";
import type { ModalSession } from "@repo/app/shared/hooks/use-modal-session";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { SectionHeader } from "@repo/design-system/components/ui/section-header";
import { toast } from "@repo/design-system/components/ui/sonner";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import { NewPlanModal } from "@/app/(authenticated)/[orgSlug]/implementation-plans/components/new-plan-modal";
import { useIssueState } from "../use-issue-state";
import { SelectPlanDialog } from "./select-plan-dialog";

type PlanSectionProps = {
  feature: DocumentDetail;
  generatePlanModalSession: ModalSession;
};

export function PlanSection({
  feature,
  generatePlanModalSession,
}: Readonly<PlanSectionProps>) {
  const [showSelectModal, setShowSelectModal] = useState(false);
  const [isOpen, setIsOpen] = useState(true);

  const {
    linkedPlanLink,
    linkedPlanId,
    hasPlan: hasLink,
    isReady,
    newPlanSource,
  } = useIssueState(feature);

  const { data: plan, isLoading: isLoadingPlan } = useDocument(linkedPlanId);

  const deleteLink = useDeleteArtifactLink();

  function handleUnlink(linkId: string) {
    deleteLink.mutate(linkId, {
      onSuccess: () => {
        toast.success("Plan unlinked");
      },
    });
  }

  const hasPlan = hasLink && !!plan;
  // ISS-5474: this badge reports the issue's own readiness to generate a plan,
  // never the state of a run. The "Generating…" label it used to borrow from
  // generation status went out with the rest of the Loop/run-state UI.
  const progressBadgeLabel = isReady ? "Ready" : "Need description";

  return (
    <>
      <div className="bg-background">
        <SectionHeader
          isOpen={isOpen}
          onToggle={() => setIsOpen((prev) => !prev)}
          title="Plan"
        >
          {hasPlan || isLoadingPlan ? null : (
            <Badge
              className="border border-[var(--progress-badge-border)] bg-[var(--progress-badge-bg)] px-2.5 py-1 text-[var(--progress-badge-text)]"
              variant="secondary"
            >
              {progressBadgeLabel}
            </Badge>
          )}
        </SectionHeader>
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
                    {isReady
                      ? "A plan hasn't been generated for this issue yet"
                      : "Need description to generate a plan"}
                  </p>
                  <div className="flex gap-3">
                    <Button
                      disabled={!isReady}
                      onClick={generatePlanModalSession.openModal}
                      size="sm"
                      variant="secondary"
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
          </>
        ) : null}
      </div>

      {/* `key` bumps on each open so the modal mounts fresh and form
          state resets via remount instead of imperative reset logic
          inside the modal. */}
      <NewPlanModal
        key={generatePlanModalSession.mountKey}
        onOpenChange={generatePlanModalSession.onOpenChange}
        open={generatePlanModalSession.open}
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
