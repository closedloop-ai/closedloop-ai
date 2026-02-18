"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Save,
  Settings,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PathAutocomplete } from "@/components/engineer/PathAutocomplete";
import type { CheckResult } from "@/lib/engineer/queries/health-check";
import { healthCheckOptions } from "@/lib/engineer/queries/health-check";
import { queryKeys } from "@/lib/engineer/queries/keys";
import { updateRepoSettings } from "@/lib/engineer/queries/repos";

/** Stagger delay (ms) between each check row revealing its result */
const REVEAL_STAGGER = 120;
/** Delay after last reveal before showing success screen */
const SUCCESS_SCREEN_DELAY = 300;
/** How long the success screen stays visible before starting fade-out */
const SUCCESS_DISMISS_DELAY = 1200;
/** Duration of the Radix dialog exit animation (matches duration-200 on DialogContent) */
const EXIT_ANIMATION_MS = 250;

const HEALTH_CHECK_SESSION_KEY = "engineer-health-check-passed";

export function HealthCheckDialog() {
  // Skip entirely if health check already passed this page load (sessionStorage)
  const [alreadyPassed] = useState(
    () =>
      globalThis.window !== undefined &&
      sessionStorage.getItem(HEALTH_CHECK_SESSION_KEY) === "true"
  );
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [worktreePath, setWorktreePath] = useState("~/Source");
  const [savingWorktree, setSavingWorktree] = useState(false);
  const [revealedCount, setRevealedCount] = useState(0);
  const [showSuccess, setShowSuccess] = useState(false);
  const revealTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const queryClient = useQueryClient();

  // Client-only mount flag — avoids SSR/hydration mismatch
  useEffect(() => {
    if (!alreadyPassed) {
      setMounted(true);
    }
  }, [alreadyPassed]);

  // When closing starts, let Radix play its exit animation, then remove from DOM
  useEffect(() => {
    if (!closing) {
      return;
    }

    const timer = setTimeout(() => {
      setRemoved(true);
    }, EXIT_ANIMATION_MS);

    return () => clearTimeout(timer);
  }, [closing]);

  const alive = mounted && !removed;
  const dialogOpen = alive && !closing;

  const { data, isLoading, refetch, isFetching } = useQuery({
    ...healthCheckOptions(),
    enabled: alive,
  });

  // Staggered reveal: once data arrives, reveal checks one by one
  useEffect(() => {
    if (!data) {
      return;
    }

    // Reset
    setRevealedCount(0);
    revealTimers.current.forEach(clearTimeout);
    revealTimers.current = [];

    const total = data.checks.length;
    for (let i = 0; i < total; i++) {
      const timer = setTimeout(
        () => {
          setRevealedCount(i + 1);
        },
        REVEAL_STAGGER * (i + 1)
      );
      revealTimers.current.push(timer);
    }

    return () => {
      revealTimers.current.forEach(clearTimeout);
      revealTimers.current = [];
    };
  }, [data]);

  // Auto-dismiss after all checks are revealed and all required pass
  const allRevealed = data !== undefined && revealedCount >= data.checks.length;
  const hasRequiredFailure =
    data?.checks.some((c) => c.required && !c.passed) ?? false;
  const allRequiredPassed = allRevealed && !hasRequiredFailure;

  // Phase 1: after all revealed + all pass → show success screen
  useEffect(() => {
    if (!allRequiredPassed || showSuccess) {
      return;
    }

    const timer = setTimeout(() => {
      setShowSuccess(true);
    }, SUCCESS_SCREEN_DELAY);

    return () => clearTimeout(timer);
  }, [allRequiredPassed, showSuccess]);

  // Phase 2: after success screen is visible → persist pass & start fade-out
  useEffect(() => {
    if (!showSuccess) {
      return;
    }

    sessionStorage.setItem(HEALTH_CHECK_SESSION_KEY, "true");

    const timer = setTimeout(() => {
      setClosing(true);
    }, SUCCESS_DISMISS_DELAY);

    return () => clearTimeout(timer);
  }, [showSuccess]);

  const handleRecheck = useCallback(async () => {
    setRevealedCount(0);
    setShowSuccess(false);
    await queryClient.invalidateQueries({ queryKey: queryKeys.healthCheck() });
    refetch();
  }, [queryClient, refetch]);

  const handleContinue = useCallback(() => {
    setClosing(true);
  }, []);

  const handleSaveWorktree = useCallback(async () => {
    const trimmed = worktreePath.trim();
    if (!trimmed) {
      toast.error("Please enter a directory path");
      return;
    }

    setSavingWorktree(true);
    try {
      await updateRepoSettings({
        worktreeParentDir: trimmed,
        worktreeParentDirConfirmed: true,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.repos() });
      toast.success("Worktree directory saved");
      // Re-run health checks to pick up the change
      setRevealedCount(0);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.healthCheck(),
      });
      refetch();
    } catch (err) {
      toast.error("Failed to save", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSavingWorktree(false);
    }
  }, [worktreePath, queryClient, refetch]);

  if (!alive) {
    return null;
  }

  const requiredChecks = data?.checks.filter((c) => c.required) ?? [];
  const optionalChecks = data?.checks.filter((c) => !c.required) ?? [];
  const requiredCount = requiredChecks.length;

  // worktree-dir check failed — show inline setup (only after it's revealed)
  const worktreeCheck = data?.checks.find((c) => c.id === "worktree-dir");
  const showWorktreeSetup =
    worktreeCheck && !worktreeCheck.passed && revealedCount >= requiredCount;

  return (
    <Dialog open={dialogOpen}>
      <DialogContent
        className="!max-w-md"
        onEscapeKeyDown={(e) => {
          if (!allRequiredPassed) {
            e.preventDefault();
          }
        }}
        onInteractOutside={(e) => {
          if (!allRequiredPassed) {
            e.preventDefault();
          }
        }}
        showCloseButton={false}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
              <Settings className="size-5 text-primary" />
            </div>
            <DialogTitle>System Check</DialogTitle>
          </div>
          <DialogDescription>
            Verifying that all required tools and configuration are in place.
          </DialogDescription>
        </DialogHeader>

        {showSuccess ? (
          <div className="fade-in zoom-in-95 flex animate-in flex-col items-center justify-center gap-3 py-8 duration-300">
            <CheckCircle2 className="size-10 text-emerald-500" />
            <p className="font-medium text-foreground text-sm">
              All pre-checks passed
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-4 py-2">
              {/* Required section */}
              <div>
                <h4 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
                  Required
                </h4>
                <div className="space-y-1.5">
                  {requiredChecks.map((check, i) => (
                    <CheckRow
                      check={check}
                      key={check.id}
                      revealed={revealedCount > i}
                    />
                  ))}
                  {isLoading &&
                    Array.from({ length: 6 }).map((_, i) => (
                      <CheckRowSkeleton key={`req-skel-${String(i)}`} />
                    ))}
                </div>
              </div>

              {/* Inline worktree setup when that check fails */}
              {showWorktreeSetup && (
                <div className="fade-in slide-in-from-bottom-2 animate-in duration-300">
                  <WorktreeInlineSetup
                    onChange={setWorktreePath}
                    onSave={handleSaveWorktree}
                    saving={savingWorktree}
                    value={worktreePath}
                  />
                </div>
              )}

              {/* Optional section */}
              <div>
                <h4 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
                  Optional
                </h4>
                <div className="space-y-1.5">
                  {optionalChecks.map((check, i) => (
                    <CheckRow
                      check={check}
                      key={check.id}
                      revealed={revealedCount > requiredCount + i}
                    />
                  ))}
                  {isLoading &&
                    Array.from({ length: 2 }).map((_, i) => (
                      <CheckRowSkeleton key={`opt-skel-${String(i)}`} />
                    ))}
                </div>
              </div>
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                className="gap-1.5"
                disabled={isFetching}
                onClick={handleRecheck}
                size="sm"
                variant="outline"
              >
                <RefreshCw
                  className={`size-3.5 ${isFetching ? "animate-spin" : ""}`}
                />
                Re-check
              </Button>
              <Button
                disabled={!allRequiredPassed}
                onClick={handleContinue}
                size="sm"
              >
                Continue
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CheckRow({
  check,
  revealed,
}: Readonly<{ check: CheckResult; revealed: boolean }>) {
  if (!revealed) {
    return <CheckRowSkeleton />;
  }

  return (
    <div className="fade-in slide-in-from-left-3 animate-in space-y-0.5 duration-300">
      <div className="flex items-center gap-2 text-sm">
        <CheckIcon passed={check.passed} required={check.required} />
        <span className="flex-1 truncate">{check.label}</span>
        {check.passed && check.version && (
          <span className="font-mono text-muted-foreground text-xs">
            {check.version}
          </span>
        )}
        {check.passed && !check.version && (
          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
        )}
        {!check.passed && (
          <span className="text-muted-foreground text-xs">{check.error}</span>
        )}
      </div>
      {!check.passed && check.remediation && (
        <p className="pl-6 text-muted-foreground text-xs">
          <span className="select-all font-mono text-[11px]">
            {check.remediation}
          </span>
        </p>
      )}
    </div>
  );
}

function CheckIcon({
  passed,
  required,
}: Readonly<{ passed: boolean; required: boolean }>) {
  if (passed) {
    return <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />;
  }
  if (required) {
    return <XCircle className="size-4 shrink-0 text-destructive" />;
  }
  return <AlertTriangle className="size-4 shrink-0 text-amber-500" />;
}

function CheckRowSkeleton() {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
      <div className="h-4 w-24 animate-pulse rounded bg-muted" />
    </div>
  );
}

function WorktreeInlineSetup({
  value,
  onChange,
  onSave,
  saving,
}: Readonly<{
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  saving: boolean;
}>) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <p className="text-muted-foreground text-xs">
        Choose the parent directory where git worktrees will be created for each
        ticket.
      </p>
      <div className="flex gap-2">
        <PathAutocomplete
          className="flex-1"
          onChange={onChange}
          onSelect={onChange}
          placeholder="~/Source"
          value={value}
        />
        <Button
          className="shrink-0 gap-1.5"
          disabled={saving || !value.trim()}
          onClick={onSave}
          size="sm"
        >
          <Save className="size-3.5" />
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
