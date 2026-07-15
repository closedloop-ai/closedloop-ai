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
  const [error, setError] = useState<string | null>(null);

  const createDistribution = useCreateDistribution();

  // resetForm is declared before handleSubmit to avoid use-before-declaration
  const resetForm = useCallback(() => {
    setMode(DistributionMode.AutoInstall);
    setTargetingType(DistributionTargetingType.All);
    setSpecificTargets("");
    setError(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    setError(null);

    let targetComputeTargetIds: string[] | undefined;
    if (targetingType === DistributionTargetingType.Specific) {
      const ids = specificTargets
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) {
        setError(
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

    try {
      const distribution = await createDistribution.mutateAsync(request);
      onSuccess?.(distribution);
      onOpenChange(false);
      resetForm();
    } catch (err) {
      setError(
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
              onValueChange={(v) =>
                setTargetingType(v as DistributionTargetingType)
              }
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

          {error && <p className="text-destructive text-sm">{error}</p>}
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
