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
  CheckCircle2,
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
import { useLatestElectronRelease } from "@/hooks/queries/use-electron-release";
import type { CheckResult } from "@/lib/engineer/queries/health-check";
import {
  getRenderableHealthChecks,
  healthCheckOptions,
} from "@/lib/engineer/queries/health-check";
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
const LATEST_RELEASE_STALE_TIME_MS = 5 * 60 * 1000;

const shownTargetKeys = new Set<string>();

function shouldEnableLatestReleaseQuery({
  canOpen,
  mounted,
}: Readonly<{
  canOpen: boolean;
  mounted: boolean;
}>): boolean {
  return mounted && canOpen;
}

function shouldEnableHealthCheckQuery({
  latestReleaseLoading,
  latestReleaseQueryEnabled,
}: Readonly<{
  latestReleaseLoading: boolean;
  latestReleaseQueryEnabled: boolean;
}>): boolean {
  return latestReleaseQueryEnabled && !latestReleaseLoading;
}

export function resetHealthCheckDialogVisibilityForTests(): void {
  shownTargetKeys.clear();
}

export function HealthCheckDialog({
  targetKey = "default",
  targetLabel,
}: Readonly<{ targetKey?: string; targetLabel?: string }>) {
  const [mounted, setMounted] = useState(false);
  const [failureDetected, setFailureDetected] = useState(false);
  const [closing, setClosing] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [worktreePath, setWorktreePath] = useState("");
  const [savingWorktree, setSavingWorktree] = useState(false);
  const [revealedCount, setRevealedCount] = useState(0);
  const [recheckKey, setRecheckKey] = useState(0);
  const [showSuccess, setShowSuccess] = useState(false);
  const revealTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const canOpenThisMount = useRef(!shownTargetKeys.has(targetKey));
  const queryClient = useQueryClient();
  const expectedMcpUrl = env.NEXT_PUBLIC_MCP_SERVER_URL ?? null;
  const latestReleaseQueryEnabled = shouldEnableLatestReleaseQuery({
    canOpen: canOpenThisMount.current,
    mounted,
  });
  const { data: latestRelease, isLoading: isLatestReleaseLoading } =
    useLatestElectronRelease({
      enabled: latestReleaseQueryEnabled,
      staleTime: LATEST_RELEASE_STALE_TIME_MS,
    });
  const latestVersion = latestRelease?.version ?? null;

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
  const dialogOpen = alive && !closing && failureDetected;

  const { data, isLoading, refetch, isFetching } = useQuery({
    ...healthCheckOptions(targetKey, expectedMcpUrl, { latestVersion }),
    enabled: shouldEnableHealthCheckQuery({
      latestReleaseLoading: isLatestReleaseLoading,
      latestReleaseQueryEnabled,
    }),
    refetchOnMount: "always" as const,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const renderableChecks = useMemo(
    () => getRenderableHealthChecks(data, expectedMcpUrl),
    [data, expectedMcpUrl]
  );

  // Auto-dismiss after all checks are revealed and all required pass
  const allRevealed =
    renderableChecks && revealedCount >= renderableChecks.length;
  const hasRequiredFailure =
    renderableChecks?.some((c) => c.required && !c.passed) ?? false;
  const allRequiredPassed = allRevealed && !hasRequiredFailure;

  // Latch failureDetected — once a required failure is seen, open the dialog.
  // Defers the module-flag write so React StrictMode's throwaway mount
  // cannot consume the one-shot flag.
  useEffect(() => {
    if (!canOpenThisMount.current) {
      return;
    }

    if (!hasRequiredFailure) {
      return;
    }

    const timer = setTimeout(() => {
      shownTargetKeys.add(targetKey);
    }, 0);

    setFailureDetected(true);

    return () => clearTimeout(timer);
  }, [hasRequiredFailure, targetKey]);

  // Staggered reveal: only run when dialog is showing (failure detected).
  // recheckKey ensures the stagger re-triggers even when the response is
  // structurally identical (TanStack Query structural sharing preserves the
  // same data reference in that case).
  useEffect(() => {
    if (recheckKey < 0 || !(failureDetected && renderableChecks)) {
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
  }, [failureDetected, recheckKey, renderableChecks]);

  // Phase 1: after all revealed + all pass → show success screen
  useEffect(() => {
    if (!(failureDetected && allRequiredPassed) || showSuccess) {
      return;
    }

    const timer = setTimeout(() => {
      setShowSuccess(true);
    }, SUCCESS_SCREEN_DELAY);

    return () => clearTimeout(timer);
  }, [failureDetected, allRequiredPassed, showSuccess]);

  // Phase 2: after success screen is visible → start fade-out
  useEffect(() => {
    if (!(failureDetected && showSuccess)) {
      return;
    }

    const timer = setTimeout(() => {
      setClosing(true);
    }, SUCCESS_DISMISS_DELAY);

    return () => clearTimeout(timer);
  }, [failureDetected, showSuccess]);

  const handleRecheck = useCallback(async () => {
    setRevealedCount(0);
    setShowSuccess(false);
    await queryClient.invalidateQueries({
      queryKey: queryKeys.healthCheck(targetKey, expectedMcpUrl, latestVersion),
    });
    await refetch();
    // Bump recheckKey to re-trigger stagger even if data is structurally identical
    setRecheckKey((k) => k + 1);
  }, [expectedMcpUrl, latestVersion, queryClient, refetch, targetKey]);

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

  if (!(alive && (canOpenThisMount.current || failureDetected))) {
    return null;
  }

  const requiredCount =
    renderableChecks?.filter((check) => check.required).length ?? 0;

  // worktree-dir check failed — show inline setup (only after it's revealed)
  const worktreeCheck = renderableChecks?.find((c) => c.id === "worktree-dir");
  const showWorktreeSetup =
    worktreeCheck && !worktreeCheck.passed && revealedCount >= requiredCount;

  // claude-plugins check failed — show inline install guidance (only after it's revealed)
  const pluginCheck = data?.checks?.find((c) => c.id === "claude-plugins");
  const showPluginGuidance =
    pluginCheck && !pluginCheck.passed && revealedCount >= requiredCount;

  // claude-cli check failed — show rich debug info (only after it's revealed)
  const claudeCliCheck = data?.checks?.find((c) => c.id === "claude-cli");
  const showClaudeCliBlock =
    claudeCliCheck &&
    !claudeCliCheck.passed &&
    claudeCliCheck.debug &&
    revealedCount >= requiredCount;

  return (
    <Dialog open={dialogOpen}>
      <DialogContent
        className="max-w-md!"
        onEscapeKeyDown={() => handleContinue()}
        onInteractOutside={() => handleContinue()}
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
            {targetLabel && (
              <>
                {" "}
                <span className="font-medium text-foreground">
                  Target: {targetLabel}
                </span>
              </>
            )}
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
              <SystemCheckResults
                afterRequired={AfterRequiredContent({
                  showWorktreeSetup,
                  worktreePath,
                  savingWorktree,
                  onChangeWorktree: setWorktreePath,
                  onSaveWorktree: handleSaveWorktree,
                  showPluginGuidance,
                  claudeCliCheck: showClaudeCliBlock
                    ? claudeCliCheck
                    : undefined,
                })}
                checks={renderableChecks}
                isLoading={isLoading}
                revealedCount={revealedCount}
              />
            </div>

            <DialogFooter className="gap-2">
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
              <Button onClick={handleContinue} size="sm">
                Continue
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PluginInstallGuidance() {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <Package className="size-3.5 shrink-0 text-primary" />
        <p className="font-medium text-sm">Install Claude Code plugins</p>
      </div>
      <p className="text-muted-foreground text-xs">
        Required ClosedLoop plugins are not yet installed. Run the following
        command in your terminal to install them:
      </p>
      <p className="select-all rounded bg-muted px-2 py-1 font-mono text-[11px]">
        claude plugin install code@closedloop-ai self-learning@closedloop-ai
        judges@closedloop-ai code-review@closedloop-ai platform@closedloop-ai
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
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
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
