"use client";

import {
  isRepairControlVisible,
  SystemCheckRepairButton,
  SystemCheckRepairPanel,
} from "@repo/app/compute/components/system-check-repair";
import { SYSTEM_CHECK_NEUTRAL_SURFACE_CLASS } from "@repo/app/compute/components/system-check-results";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { cn } from "@repo/design-system/lib/utils";
import {
  CheckSeverity,
  HealthCheckRepairStepStatus,
  isFailingRequiredCheck,
  resolveCheckSeverity,
} from "@closedloop-ai/loops-api/compute-target";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Cloud,
  Package,
  RefreshCw,
  Save,
  Settings,
  Terminal,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { PathAutocomplete } from "@/components/engineer/PathAutocomplete";
import { SystemCheckResults } from "@/components/system-check/system-check-results";
import { env } from "@/env";
import type {
  CheckResult,
  HealthCheckResponse,
} from "@/lib/engineer/queries/health-check";
import {
  getRenderableHealthChecks,
  healthCheckOptions,
} from "@/lib/engineer/queries/health-check";
import { queryKeys } from "@/lib/engineer/queries/keys";
import { updateRepoSettings } from "@/lib/engineer/queries/repos";
import { buildHealthCheckErrorResponse } from "@/lib/system-check/health-check-error-response";
import { useSystemCheckRepair } from "@/lib/system-check/use-system-check-repair";

/** Stagger delay (ms) between each check row revealing its result */
const REVEAL_STAGGER = 120;
/** Delay after last reveal before showing success screen */
const SUCCESS_SCREEN_DELAY = 300;
/** How long the success screen stays visible before starting fade-out */
const SUCCESS_DISMISS_DELAY = 1200;
/** Duration of the Radix dialog exit animation (matches duration-200 on DialogContent) */
const EXIT_ANIMATION_MS = 250;

/**
 * Blocking pre-loop system-check dialog. Mounted by
 * PreLoopSystemCheckProvider only when a Generate/Execute attempt against a
 * local compute target needs to surface check results; it never self-opens.
 * The provider supplies the health-check result (initialData) and the latest
 * desktop release version — this dialog runs no queries of its own besides
 * the manual Re-check refetch.
 */
type HealthCheckDialogProps = Readonly<{
  targetKey?: string;
  targetLabel?: string;
  initialData?: HealthCheckResponse;
  isOwnedTarget?: boolean;
  relayTargetId?: string | null;
  latestVersionOverride: string | null;
  pluginAutoUpdateEnabled?: boolean;
  onCancel?: () => void;
  /**
   * Escape hatch offered when the blocked command can run on Cloud compute
   * instead. Omitted when the Cloud-fallback flag is off, in which case the
   * dialog keeps its original Cancel/Re-check footer.
   */
  onRunOnCloud?: () => void;
  /**
   * True when the block is a reachability failure rather than a target that
   * answered with failing checks. Re-checking something we could not reach is
   * the least likely control to work, so on this path Run on Cloud takes the
   * primary weight and Re-check drops to outline (ISS-5171).
   */
  targetUnreachable?: boolean;
  onResolvedAfterRecheck?: () => void;
  onRecheckClick?: () => void;
  onRecheckResult?: (data: HealthCheckResponse) => void;
  onRecheckUnavailable?: (reason: string) => void;
}>;

function getDisplayTargetLabel(targetLabel: string | undefined): string | null {
  if (!targetLabel) {
    return null;
  }

  return targetLabel.trim().toLowerCase() === "localhost"
    ? "Local Gateway"
    : targetLabel;
}

export function HealthCheckDialog({
  targetKey = "default",
  targetLabel,
  initialData,
  isOwnedTarget = true,
  relayTargetId = null,
  latestVersionOverride,
  pluginAutoUpdateEnabled = false,
  onCancel,
  onRunOnCloud,
  targetUnreachable = false,
  onResolvedAfterRecheck,
  onRecheckClick,
  onRecheckResult,
  onRecheckUnavailable,
}: HealthCheckDialogProps) {
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [worktreePath, setWorktreePath] = useState("");
  const [savingWorktree, setSavingWorktree] = useState(false);
  const [revealedCount, setRevealedCount] = useState(0);
  const [recheckKey, setRecheckKey] = useState(0);
  const [recheckRevealSuspended, setRecheckRevealSuspended] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const revealTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const resolvedCallbackFired = useRef(false);
  const queryClient = useQueryClient();
  const expectedMcpUrl = env.NEXT_PUBLIC_MCP_SERVER_URL ?? null;
  const displayTargetLabel = getDisplayTargetLabel(targetLabel);
  const latestVersion = latestVersionOverride;
  let systemCheckTargetKind: "local" | "owned_relay" | "shared_relay" = "local";
  if (relayTargetId) {
    systemCheckTargetKind = isOwnedTarget ? "owned_relay" : "shared_relay";
  }
  const healthCheckQueryOptions = useMemo(
    () =>
      healthCheckOptions(targetKey, expectedMcpUrl, {
        latestVersion,
        relayTargetId,
        pluginAutoUpdateEnabled,
      }),
    [
      expectedMcpUrl,
      latestVersion,
      pluginAutoUpdateEnabled,
      relayTargetId,
      targetKey,
    ]
  );

  // Client-only mount flag — avoids SSR/hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

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

  const {
    data,
    error: healthCheckError,
    refetch,
    isFetching,
  } = useQuery({
    ...healthCheckQueryOptions,
    // The provider already ran (or attempted) the health check; only the
    // explicit Re-check button fetches from this dialog.
    enabled: false,
    initialData,
  });

  // Keep the cache aligned with the provider-supplied result so Re-check
  // starts from the same snapshot the provider blocked on.
  useEffect(() => {
    if (initialData === undefined) {
      return;
    }

    queryClient.setQueryData(healthCheckQueryOptions.queryKey, initialData);
  }, [healthCheckQueryOptions.queryKey, initialData, queryClient]);
  const effectiveData = useMemo(
    () =>
      healthCheckError ? buildHealthCheckErrorResponse(healthCheckError) : data,
    [data, healthCheckError]
  );
  const renderableChecks = useMemo(
    () => getRenderableHealthChecks(effectiveData, expectedMcpUrl),
    [effectiveData, expectedMcpUrl]
  );
  const isInitialLoad = data === undefined;
  const showLoadingChecks = !healthCheckError && isInitialLoad;

  // Auto-dismiss after all checks are revealed and all required pass
  const allRevealed =
    renderableChecks && revealedCount >= renderableChecks.length;
  // Through the shared predicate, never a hand-copy of `required && !passed`.
  // This was the third copy, and it was the one that decided whether the dialog
  // lets go: after a Re-check or Repair left only rows the gateway could not
  // determine, the provider recorded zero blockers while this still saw a
  // failure, so the success screen never ran, `onResolvedAfterRecheck` never
  // fired, and the pending command stayed stuck behind a dialog with nothing
  // left to fix (ISS-5811).
  const hasRequiredFailure =
    renderableChecks?.some(isFailingRequiredCheck) ?? false;
  const allRequiredPassed = allRevealed && !hasRequiredFailure;

  // Staggered reveal. recheckKey ensures the stagger re-triggers even when the
  // response is structurally identical (TanStack Query structural sharing
  // preserves the same data reference in that case).
  useEffect(() => {
    if (recheckRevealSuspended || recheckKey < 0 || !renderableChecks) {
      return;
    }

    // Reset
    setRevealedCount(0);
    revealTimers.current.forEach(clearTimeout);
    revealTimers.current = [];

    const total = renderableChecks.length;
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
  }, [recheckKey, recheckRevealSuspended, renderableChecks]);

  // Phase 2: after success screen is visible → start fade-out and resume the
  // blocked command
  useEffect(() => {
    if (!showSuccess) {
      return;
    }

    const timer = setTimeout(() => {
      setClosing(true);
      if (!resolvedCallbackFired.current) {
        resolvedCallbackFired.current = true;
        onResolvedAfterRecheck?.();
      }
    }, SUCCESS_DISMISS_DELAY);

    return () => clearTimeout(timer);
  }, [onResolvedAfterRecheck, showSuccess]);

  // Repair's own re-check IS the re-check — the gateway re-ran the sweep before
  // answering, so we adopt that result rather than firing a second round trip
  // the user would have to sit through.
  const handleRepaired = useCallback(
    (result: HealthCheckResponse) => {
      queryClient.setQueryData(healthCheckQueryOptions.queryKey, result);
      setRevealedCount(0);
      setShowSuccess(false);
      setRecheckKey((k) => k + 1);
      onRecheckResult?.(result);
    },
    [healthCheckQueryOptions.queryKey, onRecheckResult, queryClient]
  );

  const repairState = useSystemCheckRepair({
    // Renderable, not raw: the two synthesized MCP rows are repairable too, and
    // the raw gateway array does not contain them (ISS-5435).
    checks: renderableChecks,
    expectedMcpUrl,
    relayTargetId,
    latestVersion,
    isEligible: isOwnedTarget,
    onRepaired: handleRepaired,
  });

  // Whether a Repair button will actually paint, not merely whether this surface
  // is willing to offer one. The footer reorders around it, so a false positive
  // here would demote Re-check and hide Run on Cloud for nothing.
  const isRepairOffered =
    repairState.isOffered && isRepairControlVisible(repairState);
  // Repair being on offer is NOT the same as Repair being able to unblock this
  // user. Since the MCP rows became repairable (ISS-5435), an optional
  // `<provider>-mcp` row alone can raise `isRepairOffered` — and suppressing Run
  // on Cloud on that would take the only way forward off the screen for someone
  // whose actual blocker (expired `gh auth`, say) Repair cannot touch. Only a
  // repairable REQUIRED row earns that suppression.
  const isRequiredRepairOffered =
    isRepairOffered && repairState.repairableRequiredCount > 0;
  // A repair step the gateway reported as failed. `mcp add` that lands but never
  // connects is exactly this, and it is the EXPECTED outcome for any provider
  // needing a sign-in — so it is not an edge case (ISS-5435 review).
  const hasFailedRepairStep = (repairState.steps ?? []).some(
    (step) => step.status === HealthCheckRepairStepStatus.Failed
  );

  // Phase 1: after all revealed + all pass → show success screen.
  //
  // Held below `repairState` on purpose: the MCP rows are OPTIONAL, so a repair
  // that failed on one still leaves `allRequiredPassed` true, and without this
  // guard the success view would replace the repair panel and dismiss itself a
  // second and a half later — telling the user "All pre-checks passed" over a
  // repair that just told them it failed. The narration is retired the moment
  // the rows it describes are replaced, so a later Re-check releases the hold.
  useEffect(() => {
    if (!allRequiredPassed || showSuccess || hasFailedRepairStep) {
      return;
    }

    const timer = setTimeout(() => {
      setShowSuccess(true);
    }, SUCCESS_SCREEN_DELAY);

    return () => clearTimeout(timer);
  }, [allRequiredPassed, hasFailedRepairStep, showSuccess]);

  const handleRecheck = useCallback(async () => {
    onRecheckClick?.();
    setRecheckRevealSuspended(true);
    setRevealedCount(0);
    setShowSuccess(false);
    try {
      const result = await refetch();
      if (result.error || !result.data) {
        onRecheckUnavailable?.(
          result.error instanceof Error
            ? result.error.message
            : "Health check returned no data"
        );
        return;
      }
      onRecheckResult?.(result.data);
    } finally {
      // Restart the stagger after success or failure so failed re-checks cannot leave rows suspended.
      setRecheckRevealSuspended(false);
      setRecheckKey((k) => k + 1);
    }
  }, [onRecheckClick, onRecheckResult, onRecheckUnavailable, refetch]);

  const handleCancel = useCallback(() => {
    setClosing(true);
    onCancel?.();
  }, [onCancel]);

  const handleRunOnCloud = useCallback(() => {
    setClosing(true);
    onRunOnCloud?.();
  }, [onRunOnCloud]);

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
        queryKey: queryKeys.healthCheck(
          targetKey,
          expectedMcpUrl,
          latestVersion
        ),
      });
      await refetch();
      setRecheckKey((k) => k + 1);
    } catch (err) {
      toast.error("Failed to save", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSavingWorktree(false);
    }
  }, [
    expectedMcpUrl,
    latestVersion,
    queryClient,
    refetch,
    targetKey,
    worktreePath,
  ]);

  if (!alive) {
    return null;
  }

  const remediation = deriveRemediationState({
    checks: renderableChecks,
    effectiveData,
    revealedCount,
  });
  const { showWorktreeSetup, showPluginGuidance, claudeCliCheck } = remediation;

  return (
    <Dialog open={dialogOpen}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] max-w-2xl! grid-rows-[auto_1fr_auto]"
        onEscapeKeyDown={() => handleCancel()}
        onInteractOutside={() => handleCancel()}
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
            Required checks must pass before the command can run.
            {displayTargetLabel && (
              <>
                {" "}
                <span className="font-medium text-foreground">
                  Target: {displayTargetLabel}
                </span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {showSuccess ? (
          <div className="fade-in zoom-in-95 flex animate-in flex-col items-center justify-center gap-3 py-8 duration-300">
            <CheckCircle2 className="size-10 text-success" />
            <p className="font-medium text-foreground text-sm">
              All pre-checks passed
            </p>
          </div>
        ) : (
          <>
            <div className="min-h-0 space-y-4 overflow-y-auto py-2">
              {repairState.isOffered && (
                <SystemCheckRepairPanel
                  errorMessage={repairState.errorMessage}
                  isRepairing={repairState.isRepairing}
                  joinedInFlight={repairState.joinedInFlight}
                  steps={repairState.steps}
                />
              )}
              <SystemCheckResults
                afterRequired={AfterRequiredContent({
                  showWorktreeSetup,
                  worktreePath,
                  savingWorktree,
                  onChangeWorktree: setWorktreePath,
                  onSaveWorktree: handleSaveWorktree,
                  showPluginGuidance,
                  claudeCliCheck,
                })}
                checks={renderableChecks}
                isLoading={showLoadingChecks}
                isRepairOffered={isRepairOffered}
                pluginAutoUpdateEnabled={pluginAutoUpdateEnabled}
                revealedCount={revealedCount}
                targetKind={systemCheckTargetKind}
              />
            </div>

            <HealthCheckDialogFooter
              hasRepair={isRepairOffered}
              hasRequiredRepair={isRequiredRepairOffered}
              isRecheckDisabled={
                isFetching || isInitialLoad || repairState.isRepairing
              }
              isRecheckFetching={isFetching}
              onCancel={handleCancel}
              onRecheck={handleRecheck}
              onRunOnCloud={handleRunOnCloud}
              repairAction={
                isRepairOffered ? (
                  <SystemCheckRepairButton
                    isCheckRunning={isFetching}
                    isRepairing={repairState.isRepairing}
                    isSupported={repairState.isSupported}
                    onRepair={repairState.repair}
                    repairableCount={repairState.repairableCount}
                  />
                ) : null
              }
              showRunOnCloud={Boolean(onRunOnCloud)}
              targetUnreachable={targetUnreachable}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const CLAUDE_PLUGIN_INSTALL_COMMAND =
  "/bin/bash -c 'set -e && install_script=\"$(mktemp)\" && trap '\\''rm -f \"$install_script\"'\\'' EXIT && curl -fsSL https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main/install.sh -o \"$install_script\" && /bin/bash \"$install_script\"'";

function PluginInstallGuidance() {
  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border p-3",
        SYSTEM_CHECK_NEUTRAL_SURFACE_CLASS
      )}
    >
      <div className="flex items-center gap-2">
        <Package className="size-3.5 shrink-0 text-primary" />
        <p className="font-medium text-sm">Install Claude Code plugins</p>
      </div>
      <p className="text-muted-foreground text-xs">
        Required Closedloop plugins are not installed at user scope or are not
        enabled. Run the installer in your terminal:
      </p>
      <p className="select-all rounded bg-muted px-2 py-1 font-mono text-[11px]">
        {CLAUDE_PLUGIN_INSTALL_COMMAND}
      </p>
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
    <div
      className={cn(
        "space-y-2 rounded-lg border p-3",
        SYSTEM_CHECK_NEUTRAL_SURFACE_CLASS
      )}
    >
      <p className="text-muted-foreground text-xs">
        Choose the parent directory where git worktrees will be created for each
        ticket.
      </p>
      <div className="flex gap-2">
        <PathAutocomplete
          className="flex-1"
          onChange={onChange}
          onSelect={onChange}
          placeholder="Path to your workspace directory"
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

function ClaudeCliFailureBlock({
  debug,
}: Readonly<{
  debug: NonNullable<CheckResult["debug"]>;
}>) {
  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border p-3",
        SYSTEM_CHECK_NEUTRAL_SURFACE_CLASS
      )}
    >
      <div className="flex items-center gap-2">
        <Terminal className="size-3.5 shrink-0 text-primary" />
        <p className="font-medium text-sm">Claude CLI diagnostics</p>
      </div>

      {debug.errorCode && (
        <p className="font-mono text-destructive text-xs">
          Error: {debug.errorCode}
        </p>
      )}

      {debug.resolvedPath && (
        <div className="flex items-start gap-1.5 text-xs">
          <span className="shrink-0 text-muted-foreground">Resolved:</span>
          <span
            className="truncate font-mono text-foreground"
            title={debug.resolvedPath}
          >
            {debug.resolvedPath.length > 60
              ? `...${debug.resolvedPath.slice(-57)}`
              : debug.resolvedPath}
          </span>
        </div>
      )}

      {debug.foundAt && debug.foundAt.length > 0 && (
        <div className="space-y-1">
          <p className="text-muted-foreground text-xs">
            Found at these locations:
          </p>
          <ul className="space-y-1">
            {debug.foundAt.map((p) => (
              <li className="flex items-center gap-2" key={p}>
                <span className="flex-1 truncate font-mono text-xs" title={p}>
                  {p}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-muted-foreground text-xs">
        {debug.shell && (
          <span>
            Shell: <span className="font-mono">{debug.shell}</span>
          </span>
        )}
        {debug.platform && (
          <span>
            Platform: <span className="font-mono">{debug.platform}</span>
          </span>
        )}
        {debug.overrideUsed && (
          <span>
            Override: <span className="font-mono">{debug.overrideUsed}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function AfterRequiredContent({
  showWorktreeSetup,
  worktreePath,
  savingWorktree,
  onChangeWorktree,
  onSaveWorktree,
  showPluginGuidance,
  claudeCliCheck,
}: {
  showWorktreeSetup: boolean | undefined;
  worktreePath: string;
  savingWorktree: boolean;
  onChangeWorktree: (v: string) => void;
  onSaveWorktree: () => void;
  showPluginGuidance: boolean | undefined;
  claudeCliCheck: CheckResult | undefined;
}): ReactNode {
  if (showWorktreeSetup) {
    return (
      <div className="fade-in slide-in-from-bottom-2 animate-in duration-300">
        <WorktreeInlineSetup
          onChange={onChangeWorktree}
          onSave={onSaveWorktree}
          saving={savingWorktree}
          value={worktreePath}
        />
      </div>
    );
  }

  if (showPluginGuidance) {
    return (
      <div className="fade-in slide-in-from-bottom-2 animate-in duration-300">
        <PluginInstallGuidance />
      </div>
    );
  }

  if (claudeCliCheck?.debug) {
    return (
      <div className="fade-in slide-in-from-bottom-2 animate-in duration-300">
        <ClaudeCliFailureBlock debug={claudeCliCheck.debug} />
      </div>
    );
  }

  return undefined;
}

type RemediationState = {
  showWorktreeSetup: boolean;
  showPluginGuidance: boolean;
  claudeCliCheck: CheckResult | undefined;
};

/**
 * Derives which inline remediation block (worktree setup, plugin installer, or
 * Claude CLI diagnostics) to surface for the current failing checks, gated on
 * the required rows having finished their staggered reveal.
 */
function deriveRemediationState({
  checks,
  effectiveData,
  revealedCount,
}: {
  checks: CheckResult[] | undefined;
  effectiveData: HealthCheckResponse | undefined;
  revealedCount: number;
}): RemediationState {
  const requiredCount = checks?.filter((check) => check.required).length ?? 0;
  const revealed = revealedCount >= requiredCount;

  const worktreeCheck = checks?.find((c) => c.id === "worktree-dir");
  const showWorktreeSetup = Boolean(
    worktreeCheck && !worktreeCheck.passed && revealed
  );

  // The panel must obey the same rule the rows do (ISS-5369): a plugin row that
  // could not be determined is not a proven failure, so it must not trigger a
  // block telling the user to run an installer. In the reported case — a stale
  // Claude binary path — all five plugin rows are `blocked` and still carry
  // `passed: false` for older builds, so `!c.passed` alone kept prescribing the
  // one command that cannot work.
  const pluginCheckFailed = effectiveData?.checks?.some(
    (c) =>
      (c.id === "claude-plugins" || c.id.startsWith("plugin-")) &&
      resolveCheckSeverity(c) === CheckSeverity.Error
  );
  const showPluginGuidance = Boolean(pluginCheckFailed && revealed);

  const claudeCliCheck = effectiveData?.checks?.find(
    (c) => c.id === "claude-cli"
  );
  const showClaudeCliBlock = Boolean(
    claudeCliCheck && !claudeCliCheck.passed && claudeCliCheck.debug && revealed
  );

  return {
    showWorktreeSetup,
    showPluginGuidance,
    claudeCliCheck: showClaudeCliBlock ? claudeCliCheck : undefined,
  };
}

type HealthCheckDialogFooterProps = {
  isRecheckDisabled: boolean;
  isRecheckFetching: boolean;
  onCancel: () => void;
  onRecheck: () => void;
  onRunOnCloud: () => void;
  /**
   * The Repair control, or null when it is gated off / has nothing to repair.
   * A slot rather than a prop bundle so the footer keeps owning only the
   * question of which control leads.
   */
  repairAction: ReactNode;
  /**
   * Whether that slot actually renders a button. It is NOT derivable from
   * `repairAction !== null`: `SystemCheckRepairButton` returns null on an old
   * gateway or with nothing repairable, so a non-null node can still paint
   * nothing, and the footer would then demote Re-check and drop Run on Cloud
   * for a Repair button the user cannot see.
   */
  hasRepair: boolean;
  /**
   * Whether that Repair button can clear a REQUIRED failure. Only this may
   * suppress Run on Cloud: an optional repairable row (a `<provider>-mcp` row)
   * is not what the user is stuck on, so hiding the cloud escape route for it
   * would demote the only way forward for a fix nobody was waiting on.
   */
  hasRequiredRepair: boolean;
  showRunOnCloud: boolean;
  targetUnreachable: boolean;
};

/**
 * The dialog's action row.
 *
 * It lives apart from `HealthCheckDialog` because deciding which control leads
 * and which carries the primary weight is its own responsibility, and inlining
 * that decision pushed the dialog past the cognitive-complexity ceiling.
 */
function HealthCheckDialogFooter({
  isRecheckDisabled,
  isRecheckFetching,
  onCancel,
  onRecheck,
  onRunOnCloud,
  repairAction,
  hasRepair,
  hasRequiredRepair,
  showRunOnCloud,
  targetUnreachable,
}: HealthCheckDialogFooterProps) {
  // When we could not reach the target, Re-check is the least likely control to
  // work; Run on Cloud is the way forward, so it takes the primary weight and
  // the trailing slot. A target that answered with real failing checks keeps
  // Re-check primary — there, re-checking is exactly the right next action.
  const emphasizeRunOnCloud = showRunOnCloud && targetUnreachable;
  // Repair outranks Re-check whenever it is offered: re-checking without
  // repairing first just reproduces the failure the user is already looking at.
  const demoteRecheck = emphasizeRunOnCloud || hasRepair;
  const recheckButton = (
    <Button
      className="gap-1.5"
      disabled={isRecheckDisabled}
      key="recheck"
      onClick={onRecheck}
      size="sm"
      variant={demoteRecheck ? "outline" : "default"}
    >
      <RefreshCw
        className={`size-3.5 ${isRecheckFetching ? "animate-spin" : ""}`}
      />
      Re-check
    </Button>
  );
  // Four buttons in one footer is too many, and when the gateway can heal the
  // thing BLOCKING the user, Run on Cloud is not what anyone reaches for next —
  // repair, then re-check. Keyed to a required repair rather than to `hasRepair`
  // so an optional fix (an MCP row) can never take the escape route away from
  // someone whose blocker Repair cannot touch. It comes back the moment Repair
  // stops being able to clear a required failure.
  const runOnCloudButton =
    showRunOnCloud && !hasRequiredRepair ? (
      <Button
        className="gap-1.5"
        key="run-on-cloud"
        onClick={onRunOnCloud}
        size="sm"
        variant={emphasizeRunOnCloud ? "default" : "secondary"}
      >
        <Cloud aria-hidden="true" className="size-3.5" />
        Run on Cloud
      </Button>
    ) : null;
  const actions = emphasizeRunOnCloud
    ? [recheckButton, runOnCloudButton]
    : [runOnCloudButton, recheckButton];

  // `DialogFooter` is flex-col-reverse below sm, so the LAST child is the
  // rightmost on desktop and the topmost on mobile. Repair therefore goes last
  // whenever it is offered — it is the action carrying the weight.
  return (
    <DialogFooter>
      <Button onClick={onCancel} size="sm" variant="outline">
        Cancel
      </Button>
      {actions}
      {repairAction}
    </DialogFooter>
  );
}
