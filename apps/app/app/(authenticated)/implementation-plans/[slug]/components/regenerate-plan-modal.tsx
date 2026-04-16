"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { AdditionalReposPicker } from "../../components/additional-repos-picker";
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
  const multiRepoFlag = useFeatureFlag("multi-repo-plan");
  const showPicker = multiRepoFlag?.enabled !== false;

  const [additionalRepos, setAdditionalRepos] = useState<AdditionalRepoRef[]>(
    initialAdditionalRepos ?? []
  );
  const [isValid, setIsValid] = useState(true);

  // Re-seed local state when the modal opens or when the loop's previously
  // saved repos arrive after the modal is already open. Keyed on `open` so the
  // picker also resets between open/close cycles.
  useEffect(() => {
    if (open) {
      setAdditionalRepos(initialAdditionalRepos ?? []);
      setIsValid(true);
    }
  }, [open, initialAdditionalRepos]);

  const handleConfirm = () => {
    onConfirm(
      showPicker ? normalizeAdditionalRepos(additionalRepos) : undefined
    );
    onOpenChange(false);
  };

  const isConfirmDisabled =
    isSubmitting || isLoadingInitialRepos || (showPicker && !isValid);

  const pickerKey = `${String(open)}-${String(isLoadingInitialRepos)}`;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center gap-2">
              <RefreshCwIcon className="h-5 w-5" />
              Regenerate Plan
            </div>
          </DialogTitle>
          <DialogDescription>
            Confirm the repositories that should be used as context for the
            regenerated plan.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {showPicker && isLoadingInitialRepos ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2Icon className="h-4 w-4 animate-spin" />
              Loading previously selected repositories…
            </div>
          ) : null}

          {showPicker && !isLoadingInitialRepos ? (
            <AdditionalReposPicker
              initialValue={initialAdditionalRepos ?? []}
              key={pickerKey}
              onChange={setAdditionalRepos}
              onValidChange={setIsValid}
              targetRepo={targetRepo}
            />
          ) : null}

          {showPicker ? null : (
            <p className="text-muted-foreground text-sm">
              This will regenerate the implementation plan from the current
              source.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            disabled={isSubmitting}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={isConfirmDisabled} onClick={handleConfirm}>
            {isSubmitting ? (
              <>
                <Loader2Icon className="h-4 w-4 animate-spin" />
                Starting Regeneration…
              </>
            ) : (
              <>
                <RefreshCwIcon className="h-4 w-4" />
                Regenerate Plan
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
