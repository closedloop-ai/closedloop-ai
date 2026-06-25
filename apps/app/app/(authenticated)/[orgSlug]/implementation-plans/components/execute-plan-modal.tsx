"use client";

import { getPrimaryRepoFromSnapshot } from "@repo/api/src/types/document";
import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { LoopCommand } from "@repo/api/src/types/loop";
import { useDocument } from "@repo/app/documents/hooks/use-documents";
import { useResolvedJobRepos } from "@repo/app/loops/hooks/use-resolved-job-repos";
import { PlayIcon } from "lucide-react";
import { useState } from "react";
import { JobRepositoriesSection } from "@/app/(authenticated)/components/job-repositories-section";
import type { JobRepoSelection } from "../../../components/job-repositories/selection";
import { PlanActionModal } from "./plan-action-modal";

type ExecutePlanModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (
    additionalRepos?: AdditionalRepoRef[],
    onSuccess?: () => void
  ) => void;
  isLoading: boolean;
  planId: string | null;
};

const EXECUTE_DIALOG_DESCRIPTION =
  "This will generate code based on the implementation plan and create a pull request for review.";

export function ExecutePlanModal({
  open,
  onOpenChange,
  onConfirm,
  isLoading,
  planId,
}: Readonly<ExecutePlanModalProps>) {
  const { data: plan, isLoading: isLoadingPlan } = useDocument(
    planId,
    undefined,
    { enabled: !!planId }
  );
  const projectId = plan?.projectId ?? undefined;
  // Seed with the artifact's primary repo from its immutable snapshot. The
  // hook still prefers prior-Loop repos when available; this is the second
  // step in the resolution chain before falling back to project defaults.
  const primarySeed = plan
    ? (getPrimaryRepoFromSnapshot(plan.repositorySnapshot)?.fullName ?? null)
    : null;

  const resolvedJobRepos = useResolvedJobRepos({
    projectId,
    artifactId: planId,
    command: LoopCommand.Execute,
    primaryFullNameSeed: primarySeed,
    enabled: open,
  });

  const [jobRepos, setJobRepos] = useState<JobRepoSelection | null>(null);
  const [reposIncomplete, setReposIncomplete] = useState(false);

  const handleConfirm = () => {
    const additional = jobRepos?.additional;
    onConfirm(
      additional && additional.length > 0 ? additional : undefined,
      () => onOpenChange(false)
    );
  };

  const isDisabled =
    isLoading ||
    resolvedJobRepos.isLoading ||
    reposIncomplete ||
    (!!planId && isLoadingPlan);

  return (
    <PlanActionModal
      confirmIcon={<PlayIcon className="h-4 w-4" />}
      confirmLabel="Execute Plan"
      description={EXECUTE_DIALOG_DESCRIPTION}
      icon={<PlayIcon className="h-5 w-5" />}
      isDisabled={isDisabled}
      isLoading={isLoading}
      loadingLabel="Starting Execution..."
      onConfirm={handleConfirm}
      onOpenChange={onOpenChange}
      open={open}
      title="Execute Implementation Plan"
    >
      <ExecuteBody
        onIncompleteChange={setReposIncomplete}
        onReposChange={setJobRepos}
        resolvedJobRepos={resolvedJobRepos}
      />
    </PlanActionModal>
  );
}

type ExecuteBodyProps = {
  resolvedJobRepos: ReturnType<typeof useResolvedJobRepos>;
  onReposChange: (selection: JobRepoSelection | null) => void;
  onIncompleteChange: (incomplete: boolean) => void;
};

function ExecuteBody({
  resolvedJobRepos,
  onReposChange,
  onIncompleteChange,
}: Readonly<ExecuteBodyProps>) {
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">
        Confirm the repositories this execution should target.
      </p>
      <JobRepositoriesSection
        collapseWhenSingleRepo={false}
        lockPrimary
        onChange={onReposChange}
        onIncompleteChange={onIncompleteChange}
        resolved={resolvedJobRepos}
      />
    </div>
  );
}
