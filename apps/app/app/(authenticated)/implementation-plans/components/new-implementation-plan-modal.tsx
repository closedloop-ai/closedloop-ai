"use client";

import {
  IMPL_PLAN_TYPE_OPTIONS,
  type ImplPlanType,
} from "@repo/api/src/types/implementation-plan";
import type { Prd } from "@repo/api/src/types/prd";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { LoaderIcon, SparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { createImplementationPlan } from "@/app/actions/implementation-plans";
import { getPRDs } from "@/app/actions/prds";

const PLAN_TYPE_LABELS: Record<ImplPlanType, string> = {
  Standard: "Standard Implementation",
  Quick: "Quick Implementation",
  Detailed: "Detailed Breakdown",
  Technical: "Technical Spec",
};

type NewImplementationPlanModalProps = {
  defaultPrdId?: string;
  defaultPrdTitle?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: React.ReactNode;
};

export function NewImplementationPlanModal({
  defaultPrdId,
  defaultPrdTitle,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  trigger,
}: NewImplementationPlanModalProps = {}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [internalOpen, setInternalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Support both controlled and uncontrolled modes
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = controlledOnOpenChange ?? setInternalOpen;

  // Form state
  const [sourcePrdId, setSourcePrdId] = useState(defaultPrdId ?? "");
  const [planType, setPlanType] = useState<ImplPlanType>("Standard");
  const [targetRelease, setTargetRelease] = useState("");
  const [engineeringTeam, setEngineeringTeam] = useState("");
  const [createdBy, setCreatedBy] = useState("");
  const [approver, setApprover] = useState("");
  const [includeRisks, setIncludeRisks] = useState(true);
  const [includeDependencies, setIncludeDependencies] = useState(true);
  const [includeTestPlan, setIncludeTestPlan] = useState(true);

  // PRDs for dropdown
  const [prds, setPrds] = useState<Prd[]>([]);
  const [loadingPrds, setLoadingPrds] = useState(false);

  // Load PRDs when modal opens (skip if we have a default PRD)
  useEffect(() => {
    if (open && !defaultPrdId) {
      setLoadingPrds(true);
      getPRDs().then((result) => {
        if (result.success) {
          setPrds(result.data);
        }
        setLoadingPrds(false);
      });
    }
  }, [open, defaultPrdId]);

  // Reset sourcePrdId when defaultPrdId changes
  useEffect(() => {
    if (defaultPrdId) {
      setSourcePrdId(defaultPrdId);
    }
  }, [defaultPrdId]);

  const resetForm = () => {
    setSourcePrdId(defaultPrdId ?? "");
    setPlanType("Standard" as ImplPlanType);
    setTargetRelease("");
    setEngineeringTeam("");
    setCreatedBy("");
    setApprover("");
    setIncludeRisks(true);
    setIncludeDependencies(true);
    setIncludeTestPlan(true);
    setError(null);
  };

  const handleSubmit = () => {
    setError(null);

    if (!sourcePrdId) {
      setError("Please select a source PRD");
      return;
    }

    if (!createdBy.trim()) {
      setError("Please enter who is creating this plan");
      return;
    }

    startTransition(async () => {
      try {
        const result = await createImplementationPlan({
          sourcePrdId,
          planType,
          targetRelease: targetRelease.trim() || undefined,
          engineeringTeam: engineeringTeam.trim() || undefined,
          createdBy: createdBy.trim(),
          approver: approver.trim() || undefined,
        });

        if (!result.success) {
          setError(result.error);
          return;
        }

        setOpen(false);
        resetForm();
        router.push(`/implementation-plans/${result.data.id}`);
      } catch (err) {
        console.error("Failed to create implementation plan:", err);
        setError("An unexpected error occurred");
      }
    });
  };

  // Determine trigger element
  const triggerElement = (() => {
    if (trigger === undefined) {
      return (
        <DialogTrigger asChild>
          <Button>
            <SparklesIcon className="mr-2 h-4 w-4" />
            Generate Plan
          </Button>
        </DialogTrigger>
      );
    }
    if (trigger) {
      return <DialogTrigger asChild>{trigger}</DialogTrigger>;
    }
    return null;
  })();

  return (
    <Dialog
      onOpenChange={(newOpen) => {
        setOpen(newOpen);
        if (!newOpen) {
          resetForm();
        }
      }}
      open={open}
    >
      {triggerElement}
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Generate Implementation Plan</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-sm">
              {error}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="source-prd">
              Source PRD<span className="text-destructive">*</span>
            </Label>
            {defaultPrdId && defaultPrdTitle ? (
              // Show read-only display when PRD is pre-selected
              <div className="flex h-10 w-full rounded-md border border-input bg-muted px-3 py-2 text-sm">
                {defaultPrdTitle}
              </div>
            ) : (
              <Select onValueChange={setSourcePrdId} value={sourcePrdId}>
                <SelectTrigger id="source-prd">
                  <SelectValue
                    placeholder={
                      loadingPrds ? "Loading PRDs..." : "Select a PRD"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {prds.length === 0 && !loadingPrds ? (
                    <div className="p-2 text-center text-muted-foreground text-sm">
                      No PRDs available. Create a PRD first.
                    </div>
                  ) : (
                    prds.map((prd) => (
                      <SelectItem key={prd.id} value={prd.id}>
                        {prd.title}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="plan-type">Plan Type</Label>
            <Select
              onValueChange={(v) => setPlanType(v as ImplPlanType)}
              value={planType}
            >
              <SelectTrigger id="plan-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {IMPL_PLAN_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {PLAN_TYPE_LABELS[opt]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="created-by">
                Created By<span className="text-destructive">*</span>
              </Label>
              <Input
                id="created-by"
                onChange={(e) => setCreatedBy(e.target.value)}
                placeholder="Your name or agent name"
                value={createdBy}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="approver">Approver</Label>
              <Input
                id="approver"
                onChange={(e) => setApprover(e.target.value)}
                placeholder="Approver name"
                value={approver}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="target-release">Target Release</Label>
              <Input
                id="target-release"
                onChange={(e) => setTargetRelease(e.target.value)}
                placeholder="e.g., v2.0"
                value={targetRelease}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="engineering-team">Engineering Team</Label>
              <Input
                id="engineering-team"
                onChange={(e) => setEngineeringTeam(e.target.value)}
                placeholder="e.g., Platform"
                value={engineeringTeam}
              />
            </div>
          </div>

          <div className="space-y-3">
            <Label>Include in Plan</Label>
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <Checkbox
                  checked={includeRisks}
                  id="include-risks"
                  onCheckedChange={(checked) =>
                    setIncludeRisks(checked === true)
                  }
                />
                <label
                  className="font-medium text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  htmlFor="include-risks"
                >
                  Risks & Mitigations
                </label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  checked={includeDependencies}
                  id="include-dependencies"
                  onCheckedChange={(checked) =>
                    setIncludeDependencies(checked === true)
                  }
                />
                <label
                  className="font-medium text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  htmlFor="include-dependencies"
                >
                  Dependencies
                </label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  checked={includeTestPlan}
                  id="include-test-plan"
                  onCheckedChange={(checked) =>
                    setIncludeTestPlan(checked === true)
                  }
                />
                <label
                  className="font-medium text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  htmlFor="include-test-plan"
                >
                  Test Plan
                </label>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={isPending || !sourcePrdId || !createdBy.trim()}
            onClick={handleSubmit}
          >
            {isPending ? (
              <>
                <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <SparklesIcon className="mr-2 h-4 w-4" />
                Generate Plan
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
