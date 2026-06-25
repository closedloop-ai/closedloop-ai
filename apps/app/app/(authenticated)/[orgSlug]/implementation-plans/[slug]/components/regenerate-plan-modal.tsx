"use client";

import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { LoopCommand } from "@repo/api/src/types/loop";
import { useResolvedJobRepos } from "@repo/app/loops/hooks/use-resolved-job-repos";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import type { JobRepoSelection } from "@/app/(authenticated)/components/job-repositories/selection";
import { JobRepositoriesSection } from "@/app/(authenticated)/components/job-repositories-section";
import { PlanActionModal } from "../../components/plan-action-modal";

type RegeneratePlanModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (additionalRepos: AdditionalRepoRef[] | undefined) => void;
  isSubmitting: boolean;
  planId: string;
  projectId: string | undefined;
  targetRepo: string;
};

export function RegeneratePlanModal({
  open,
  onOpenChange,
  onConfirm,
  isSubmitting,
  planId,
  projectId,
  targetRepo,
}: RegeneratePlanModalProps) {
  const [jobRepos, setJobRepos] = useState<JobRepoSelection | null>(null);
  const [hasIncompleteRepos, setHasIncompleteRepos] = useState(false);

  const resolvedJobRepos = useResolvedJobRepos({
    projectId,
    artifactId: planId,
    command: LoopCommand.Plan,
    // The plan's primary repo is fixed; the user only adjusts the additional
    // context repos. Seed the locked primary from the plan's target repo.
    primaryFullNameSeed: targetRepo,
    enabled: open,
  });

  const handleConfirm = () => {
    const additional = jobRepos?.additional;
    onConfirm(additional && additional.length > 0 ? additional : undefined);
    onOpenChange(false);
  };

  return (
    <PlanActionModal
      confirmIcon={<RefreshCwIcon className="h-4 w-4" />}
      confirmLabel="Regenerate Plan"
      description="Confirm the repositories that should be used as context for the regenerated plan."
      icon={<RefreshCwIcon className="h-5 w-5" />}
      isDisabled={
        isSubmitting || resolvedJobRepos.isLoading || hasIncompleteRepos
      }
      isLoading={isSubmitting}
      loadingLabel="Starting Regeneration…"
      onConfirm={handleConfirm}
      onOpenChange={onOpenChange}
      open={open}
      title="Confirm Regeneration"
    >
      <JobRepositoriesSection
        collapseWhenSingleRepo={false}
        lockPrimary
        onChange={setJobRepos}
        onIncompleteChange={setHasIncompleteRepos}
        resolved={resolvedJobRepos}
      />
    </PlanActionModal>
  );
}
