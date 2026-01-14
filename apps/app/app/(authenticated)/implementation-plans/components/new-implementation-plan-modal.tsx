"use client";

import { Button } from "@repo/design-system/components/ui/button";
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
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { LoaderIcon, SparklesIcon } from "lucide-react";
import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createImplementationPlan } from "@/app/actions/implementation-plans";
import { getPRDs } from "@/app/actions/prds";
import type { PRD } from "@repo/database/generated/client";
import { IMPL_PLAN_TYPE_OPTIONS, type ImplPlanType } from "@/lib/types";

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
  const setOpen = isControlled ? controlledOnOpenChange! : setInternalOpen;

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
  const [prds, setPrds] = useState<PRD[]>([]);
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

  // Default trigger button
  const defaultTrigger = (
    <Button>
      <SparklesIcon className="mr-2 h-4 w-4" />
      Generate Plan
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={(newOpen) => {
      setOpen(newOpen);
      if (!newOpen) {
        resetForm();
      }
    }}>
      {trigger !== undefined ? (
        trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>
      ) : (
        <DialogTrigger asChild>{defaultTrigger}</DialogTrigger>
      )}
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Generate Implementation Plan</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <div className="p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md">
              {error}
            </div>
          )}

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
              <Select value={sourcePrdId} onValueChange={setSourcePrdId}>
                <SelectTrigger id="source-prd">
                  <SelectValue placeholder={loadingPrds ? "Loading PRDs..." : "Select a PRD"} />
                </SelectTrigger>
                <SelectContent>
                  {prds.length === 0 && !loadingPrds ? (
                    <div className="p-2 text-sm text-muted-foreground text-center">
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
            <Select value={planType} onValueChange={(v) => setPlanType(v as ImplPlanType)}>
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
                value={createdBy}
                onChange={(e) => setCreatedBy(e.target.value)}
                placeholder="Your name or agent name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="approver">Approver</Label>
              <Input
                id="approver"
                value={approver}
                onChange={(e) => setApprover(e.target.value)}
                placeholder="Approver name"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="target-release">Target Release</Label>
              <Input
                id="target-release"
                value={targetRelease}
                onChange={(e) => setTargetRelease(e.target.value)}
                placeholder="e.g., v2.0"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="engineering-team">Engineering Team</Label>
              <Input
                id="engineering-team"
                value={engineeringTeam}
                onChange={(e) => setEngineeringTeam(e.target.value)}
                placeholder="e.g., Platform"
              />
            </div>
          </div>

          <div className="space-y-3">
            <Label>Include in Plan</Label>
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="include-risks"
                  checked={includeRisks}
                  onCheckedChange={(checked) => setIncludeRisks(checked === true)}
                />
                <label
                  htmlFor="include-risks"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Risks & Mitigations
                </label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="include-dependencies"
                  checked={includeDependencies}
                  onCheckedChange={(checked) => setIncludeDependencies(checked === true)}
                />
                <label
                  htmlFor="include-dependencies"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Dependencies
                </label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="include-test-plan"
                  checked={includeTestPlan}
                  onCheckedChange={(checked) => setIncludeTestPlan(checked === true)}
                />
                <label
                  htmlFor="include-test-plan"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Test Plan
                </label>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || !sourcePrdId || !createdBy.trim()}
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
