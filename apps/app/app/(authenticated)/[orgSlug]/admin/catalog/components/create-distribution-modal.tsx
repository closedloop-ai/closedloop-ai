"use client";

import {
  type CatalogItemDto,
  type CreateDistributionRequest,
  type DistributionDto,
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import { useCreateDistribution } from "@repo/app/agents/hooks/use-distributions";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Label } from "@repo/design-system/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import { useCallback, useState } from "react";

type Props = {
  /** The catalog item for which to create a distribution. */
  catalogItem: CatalogItemDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the created Distribution on success. */
  onSuccess?: (distribution: DistributionDto) => void;
};

/**
 * Modal for creating a Distribution for a CatalogItem (T-17.3 / AC-023).
 *
 * Fields:
 * - Mode: auto_install | opt_in (radio)
 * - Targeting type: all | specific (radio)
 * - Specific: free-text compute target IDs (one per line)
 *
 * On submit: POST /distributions (admin-only).
 */
export function CreateDistributionModal({
  catalogItem,
  open,
  onOpenChange,
  onSuccess,
}: Props) {
  const [mode, setMode] = useState<DistributionMode>(
    DistributionMode.AutoInstall
  );
  const [targetingType, setTargetingType] = useState<DistributionTargetingType>(
    DistributionTargetingType.All
  );
  const [specificTargets, setSpecificTargets] = useState("");
  /**
   * ISS-7206: two independent facts, so two states.
   *
   * `validationError` is a claim about the form; `submitError` is a claim about
   * what the server said to the last request that actually left the browser — a
   * past event, which no local edit can falsify. Holding both in one slot meant
   * the targeting-change clear added for ISS-7004 also discarded a server
   * rejection ("Compute target … is not in this org."), the one message the
   * admin cannot re-derive by looking at the form.
   *
   * They can be on screen together: a rejected create followed by a blocked
   * one leaves both true, and the single slot only ever showed the newer.
   *
   * Scope of the `validationError` clear, deliberately narrow: the message
   * names TWO facts, `specific` targeting and an empty target list, and only
   * the targeting radio clears it. Editing the textarea does NOT, so a message
   * the admin has since satisfied can still be on screen. That is ISS-7004's
   * pinned behaviour, not an oversight here, and widening it is a decision the
   * ticket did not carry — see the spec that pins it in the sibling test file.
   */
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const createDistribution = useCreateDistribution();

  // resetForm is declared before handleSubmit to avoid use-before-declaration
  const resetForm = useCallback(() => {
    setMode(DistributionMode.AutoInstall);
    setTargetingType(DistributionTargetingType.All);
    setSpecificTargets("");
    setValidationError(null);
    setSubmitError(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    setValidationError(null);

    let targetComputeTargetIds: string[] | undefined;
    if (targetingType === DistributionTargetingType.Specific) {
      const ids = specificTargets
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) {
        // `submitError` is deliberately left alone: no request went out, so
        // nothing newer is known about the last one that did.
        setValidationError(
          "Enter at least one compute target ID when using specific targeting."
        );
        return;
      }
      targetComputeTargetIds = ids;
    }

    const request: CreateDistributionRequest = {
      catalogItemId: catalogItem.id,
      mode,
      targetingType,
      desiredEnabled: true,
      targetComputeTargetIds,
    };

    setSubmitError(null);
    try {
      const distribution = await createDistribution.mutateAsync(request);
      onSuccess?.(distribution);
      onOpenChange(false);
      resetForm();
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to create distribution."
      );
    }
  }, [
    catalogItem.id,
    mode,
    targetingType,
    specificTargets,
    createDistribution,
    onSuccess,
    onOpenChange,
    resetForm,
  ]);

  /**
   * ISS-7004: the validation message otherwise survives until the next submit
   * or a close, so switching back to `all` leaves "Enter at least one compute
   * target ID when using specific targeting." on screen — an assertion about
   * input the user is no longer being asked for.
   *
   * ISS-7206 keeps that clear scoped to `validationError`. `submitError` is not
   * about the targeting radio and choosing a different target set does not
   * make the server's rejection of the last request untrue.
   */
  const handleTargetingTypeChange = useCallback((next: string) => {
    setTargetingType(next as DistributionTargetingType);
    setValidationError(null);
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        resetForm();
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, resetForm]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Distribution</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <p className="text-muted-foreground text-sm">
            Distributing:{" "}
            <span className="font-medium text-foreground">
              {catalogItem.name}
            </span>
          </p>

          {/* Mode */}
          <div className="flex flex-col gap-2">
            <Label className="font-medium text-sm">Install mode</Label>
            <RadioGroup
              className="flex flex-col gap-1"
              onValueChange={(v) => setMode(v as DistributionMode)}
              value={mode}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem
                  id="mode-auto"
                  value={DistributionMode.AutoInstall}
                />
                <Label
                  className="cursor-pointer font-normal"
                  htmlFor="mode-auto"
                >
                  Auto-install{" "}
                  <span className="text-muted-foreground text-xs">
                    — installs automatically on next desktop connection
                  </span>
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem
                  id="mode-opt-in"
                  value={DistributionMode.OptIn}
                />
                <Label
                  className="cursor-pointer font-normal"
                  htmlFor="mode-opt-in"
                >
                  Opt-in{" "}
                  <span className="text-muted-foreground text-xs">
                    — surfaced to users to accept
                  </span>
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* Targeting type */}
          <div className="flex flex-col gap-2">
            <Label className="font-medium text-sm">Targeting</Label>
            <RadioGroup
              className="flex flex-col gap-1"
              onValueChange={handleTargetingTypeChange}
              value={targetingType}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem
                  id="targeting-all"
                  value={DistributionTargetingType.All}
                />
                <Label
                  className="cursor-pointer font-normal"
                  htmlFor="targeting-all"
                >
                  All compute targets
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem
                  id="targeting-specific"
                  value={DistributionTargetingType.Specific}
                />
                <Label
                  className="cursor-pointer font-normal"
                  htmlFor="targeting-specific"
                >
                  Specific targets
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* Specific target IDs */}
          {targetingType === DistributionTargetingType.Specific && (
            <div className="flex flex-col gap-1">
              <Label
                className="text-muted-foreground text-xs"
                htmlFor="specific-targets"
              >
                Compute target IDs (one per line)
              </Label>
              <textarea
                className="min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                id="specific-targets"
                onChange={(e) => setSpecificTargets(e.target.value)}
                placeholder="Enter compute target UUIDs, one per line"
                value={specificTargets}
              />
            </div>
          )}

          {/*
            Oldest first, so the pair reads in the order it happened and the
            message describing the field the admin has to fix sits closest to
            the Create button. Each paragraph announces itself.
          */}
          {submitError && (
            <p className="text-destructive text-sm" role="alert">
              {submitError}
            </p>
          )}
          {validationError && (
            <p className="text-destructive text-sm" role="alert">
              {validationError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            disabled={createDistribution.isPending}
            onClick={() => handleOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={createDistribution.isPending}
            onClick={handleSubmit}
          >
            {createDistribution.isPending ? "Creating…" : "Create Distribution"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
