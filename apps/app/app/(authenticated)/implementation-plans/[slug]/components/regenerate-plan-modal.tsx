"use client";

import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { AdditionalReposPicker } from "../../components/additional-repos-picker";
import { PlanActionModal } from "../../components/plan-action-modal";
import { normalizeAdditionalRepos } from "../../components/plan-form-utils";

type RegeneratePlanModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (additionalRepos: AdditionalRepoRef[] | undefined) => void;
  isSubmitting: boolean;
  isLoadingInitialRepos: boolean;
  initialAdditionalRepos: AdditionalRepoRef[] | undefined;
  targetRepo: string;
};

export function RegeneratePlanModal({
  open,
  onOpenChange,
  onConfirm,
  isSubmitting,
  isLoadingInitialRepos,
  initialAdditionalRepos,
  targetRepo,
}: RegeneratePlanModalProps) {
  const [additionalRepos, setAdditionalRepos] = useState<AdditionalRepoRef[]>(
    initialAdditionalRepos ?? []
  );
  const [hasIncompleteRepos, setHasIncompleteRepos] = useState(false);

  const handleConfirm = () => {
    onConfirm(normalizeAdditionalRepos(additionalRepos));
    onOpenChange(false);
  };

  return (
    <PlanActionModal
      confirmLabel="Regenerate Plan"
      icon={<RefreshCwIcon className="h-5 w-5" />}
      isDisabled={isSubmitting || isLoadingInitialRepos || hasIncompleteRepos}
      isLoading={isSubmitting}
      loadingLabel="Starting Regeneration…"
      onConfirm={handleConfirm}
      onOpenChange={onOpenChange}
      open={open}
      title="Confirm Regeneration"
    >
      {isLoadingInitialRepos ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2Icon className="h-4 w-4 animate-spin" />
          Loading previously selected repositories…
        </div>
      ) : (
        <AdditionalReposPicker
          initialValue={initialAdditionalRepos ?? []}
          onChange={setAdditionalRepos}
          onIncompleteChange={setHasIncompleteRepos}
          targetRepo={targetRepo}
        />
      )}
    </PlanActionModal>
  );
}
