"use client";

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
import { useState } from "react";
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
  const [additionalRepos, setAdditionalRepos] = useState<AdditionalRepoRef[]>(
    initialAdditionalRepos ?? []
  );
  const [hasIncompleteRepos, setHasIncompleteRepos] = useState(false);

  const handleConfirm = () => {
    onConfirm(normalizeAdditionalRepos(additionalRepos));
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center gap-2">
              <RefreshCwIcon className="h-5 w-5" />
              Confirm Regeneration
            </div>
          </DialogTitle>
          <DialogDescription>
            Confirm the repositories that should be used as context for the
            regenerated plan.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
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
        </div>

        <DialogFooter>
          <Button
            disabled={isSubmitting}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={
              isSubmitting || isLoadingInitialRepos || hasIncompleteRepos
            }
            onClick={handleConfirm}
          >
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
