"use client";

import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { Loader2Icon, PlayIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AdditionalReposPicker } from "./additional-repos-picker";
import { PlanActionModal } from "./plan-action-modal";
import { normalizeAdditionalRepos } from "./plan-form-utils";

type ExecutePlanModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (
    additionalRepos?: AdditionalRepoRef[],
    onSuccess?: () => void
  ) => void;
  isLoading: boolean;
  multiRepoEnabled: boolean;
  initialAdditionalRepos: AdditionalRepoRef[] | undefined;
  isLoadingInitialRepos: boolean;
  targetRepo: string;
};

type MultiRepoExecuteBodyProps = {
  initialAdditionalRepos: AdditionalRepoRef[];
  targetRepo: string;
  onReposChange: (repos: AdditionalRepoRef[]) => void;
  onIncompleteChange: (hasIncomplete: boolean) => void;
};

const EXECUTE_DIALOG_DESCRIPTION =
  "This will generate code based on the implementation plan and create a pull request for review.";

function MultiRepoExecuteBody({
  initialAdditionalRepos,
  targetRepo,
  onReposChange,
  onIncompleteChange,
}: MultiRepoExecuteBodyProps) {
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">
        The following additional repositories will be targeted.
      </p>
      <AdditionalReposPicker
        initialValue={initialAdditionalRepos}
        onChange={onReposChange}
        onIncompleteChange={onIncompleteChange}
        targetRepo={targetRepo}
      />
    </div>
  );
}

type SimpleExecuteBodyProps = {
  showFlagOffBanner?: boolean;
};

function SimpleExecuteBody({ showFlagOffBanner }: SimpleExecuteBodyProps) {
  return (
    <div className="space-y-3">
      {showFlagOffBanner && (
        <div className="rounded-md border border-border bg-muted p-3 text-muted-foreground text-sm">
          Multi-repo execution is not yet available. Only the primary repository
          will be targeted for this execution.
        </div>
      )}
      <p className="text-muted-foreground text-sm">
        A new branch will be created with the generated code changes. You can
        review and merge the PR once it&apos;s ready.
      </p>
    </div>
  );
}

export function ExecutePlanModal({
  open,
  onOpenChange,
  onConfirm,
  isLoading,
  multiRepoEnabled,
  initialAdditionalRepos,
  isLoadingInitialRepos,
  targetRepo,
}: ExecutePlanModalProps) {
  const [currentRepos, setCurrentRepos] = useState<AdditionalRepoRef[]>(
    initialAdditionalRepos ?? []
  );
  const [hasIncompleteRepos, setHasIncompleteRepos] = useState(false);
  const hasSyncedInitialReposRef = useRef(false);
  useEffect(() => {
    if (
      !hasSyncedInitialReposRef.current &&
      initialAdditionalRepos !== undefined
    ) {
      setCurrentRepos(initialAdditionalRepos);
      hasSyncedInitialReposRef.current = true;
    }
  }, [initialAdditionalRepos]);

  // The parent mounts ExecutePlanModal persistently (no key, not conditional),
  // so closing the dialog only unmounts Radix's DialogContent — `currentRepos`
  // and `hasIncompleteRepos` would otherwise persist across open/close cycles
  // and a Confirm-without-edit on reopen would submit stale edits the picker
  // no longer shows.
  useEffect(() => {
    if (!open) {
      hasSyncedInitialReposRef.current = false;
      setCurrentRepos(initialAdditionalRepos ?? []);
      setHasIncompleteRepos(false);
    }
  }, [open, initialAdditionalRepos]);

  const handleConfirm = () => {
    if (!multiRepoEnabled) {
      onConfirm(undefined, () => onOpenChange(false));
      return;
    }
    onConfirm(normalizeAdditionalRepos(currentRepos), () =>
      onOpenChange(false)
    );
  };

  const hasInheritedRepos =
    initialAdditionalRepos !== undefined && initialAdditionalRepos.length > 0;

  // (A) multiRepoEnabled && has inherited repos → MultiRepoExecuteBody
  // (B) !multiRepoEnabled && has inherited repos → SimpleExecuteBody with banner
  // (C) !multiRepoEnabled && no inherited repos → SimpleExecuteBody
  // (D) multiRepoEnabled && no inherited repos → SimpleExecuteBody
  const renderBody = () => {
    if (isLoadingInitialRepos) {
      return (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2Icon className="h-4 w-4 animate-spin" />
          Loading previously selected repositories…
        </div>
      );
    }

    if (multiRepoEnabled && hasInheritedRepos) {
      return (
        <MultiRepoExecuteBody
          initialAdditionalRepos={initialAdditionalRepos}
          onIncompleteChange={setHasIncompleteRepos}
          onReposChange={setCurrentRepos}
          targetRepo={targetRepo}
        />
      );
    }

    if (!multiRepoEnabled && hasInheritedRepos) {
      return <SimpleExecuteBody showFlagOffBanner />;
    }

    return <SimpleExecuteBody />;
  };

  const isDisabled =
    isLoading ||
    isLoadingInitialRepos ||
    (multiRepoEnabled && hasInheritedRepos && hasIncompleteRepos);

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
      {renderBody()}
    </PlanActionModal>
  );
}
