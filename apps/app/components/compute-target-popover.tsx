"use client";

import {
  ComputePreference,
  type ComputeTarget,
  type ComputeTargetHealthCheckSnapshot,
  EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY,
  HARNESS_SELECTION_FEATURE_FLAG_KEY,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { DESKTOP_DEEP_LINK_URL } from "@repo/api/src/types/desktop-deep-link";
import {
  useComputePreference,
  useSetComputePreference,
} from "@repo/app/compute/hooks/use-compute-preference";
import { useLatestElectronRelease } from "@repo/app/desktop/hooks/use-electron-release";
import { resolveEffectiveComputeTargetSelection } from "@repo/app/loops/lib/compute-target-selection";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useIsMounted } from "@repo/app/shared/hooks/use-is-mounted";
import { useUser } from "@repo/auth/client";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { SidebarMenuButton } from "@repo/design-system/components/ui/sidebar";
import { cn } from "@repo/design-system/lib/utils";
import {
  AlertTriangleIcon,
  CheckIcon,
  CloudIcon,
  DownloadIcon,
  LaptopIcon,
  Loader2Icon,
} from "lucide-react";
import { useState } from "react";
import {
  deriveAvailableHarnessesFromSnapshot,
  HarnessSelector,
  resolveDefaultHarness,
} from "@/components/engineer/harness-selector";
import { useComputeTargetStatusStream } from "@/hooks/queries/use-compute-target-status-stream";
import {
  useComputeTargetHealthCheckSnapshot,
  useComputeTargets,
  useUpdateComputeTargetHarness,
} from "@/hooks/queries/use-compute-targets";
import {
  DESKTOP_LAUNCH_FALLBACK_FEATURE_FLAG_KEY,
  useDesktopLaunchFallback,
} from "@/hooks/use-desktop-launch-fallback";
import { LaunchDesktopAppControl } from "./launch-desktop-app-control";

// Mirrors the internal MAX_RECONNECT_ATTEMPTS in use-compute-target-status-stream.ts
const SSE_MAX_RECONNECT_ATTEMPTS = 10;

// This popover runs a button footprint one step below the design system's
// smallest shipped size (`sm` bottoms out at h-8). Named once so the four
// buttons in here cannot drift apart; promote it to a Button variant if the
// footprint ever escapes this file.
const COMPACT_BUTTON_CLASS = "h-7 w-full text-xs";

/**
 * Returns whether the SSE stream is degraded (all reconnect attempts exhausted).
 */
function isStreamDegraded(reconnectAttempts: number): boolean {
  return reconnectAttempts >= SSE_MAX_RECONNECT_ATTEMPTS;
}

type TargetOptionProps = {
  label: string;
  description?: string;
  isSelected: boolean;
  isLoading: boolean;
  onClick: () => void;
  icon: React.ReactNode;
};

function TargetOption({
  description,
  icon,
  isLoading,
  isSelected,
  label,
  onClick,
}: TargetOptionProps) {
  function renderTrailingIcon() {
    if (isLoading) {
      return (
        <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      );
    }
    if (isSelected) {
      return (
        <CheckIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-foreground"
        />
      );
    }
    return null;
  }

  return (
    <button
      aria-label={`Select ${label} compute target`}
      aria-pressed={isSelected}
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isSelected && "bg-accent text-accent-foreground"
      )}
      onClick={onClick}
      type="button"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-background">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium leading-tight">{label}</p>
        {description && (
          <p className="truncate text-muted-foreground text-xs leading-tight">
            {description}
          </p>
        )}
      </div>
      {renderTrailingIcon()}
    </button>
  );
}

type ComputeTargetPopoverProps = {
  /** Number of SSE reconnect attempts that have occurred; degraded banner shown when exhausted. */
  streamReconnectAttempts?: number;
};

export function ComputeTargetPopover({
  streamReconnectAttempts = 0,
}: ComputeTargetPopoverProps) {
  const [open, setOpen] = useState(false);
  // T-4.4: show download prompt inline when user clicks Local with zero registered targets
  const [showDownloadPrompt, setShowDownloadPrompt] = useState(false);
  const mounted = useIsMounted();
  const { user } = useUser();
  const userId = user?.id ?? "";
  // Keep SSE stream alive for real-time target status updates
  useComputeTargetStatusStream(true);

  const {
    data: targets = [],
    isLoading: targetsLoading,
    refetch: refetchComputeTargets,
  } = useComputeTargets();
  const { data: preferenceData, isLoading: preferenceLoading } =
    useComputePreference(userId, { enabled: !!userId });
  const setPreference = useSetComputePreference(userId);
  const explicitSelectionFlagEnabled = useFeatureFlagEnabled(
    EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY
  );
  const harnessSelectionEnabled = useFeatureFlagEnabled(
    HARNESS_SELECTION_FEATURE_FLAG_KEY
  );
  const requireExplicitSelection = mounted && explicitSelectionFlagEnabled;

  const isDegraded = isStreamDegraded(streamReconnectAttempts);
  const ownTargets = targets.filter((t) => !t.ownerName);
  const sharedTargets = targets.filter((t) => !!t.ownerName);
  const {
    allOffline,
    currentPreference,
    effectiveTarget,
    effectiveTargetId,
    needsSelection,
    notInstalled,
  } = resolveEffectiveComputeTargetSelection({
    preference: preferenceData,
    requireExplicitSelection,
    targets,
  });
  const isLocal = currentPreference === ComputePreference.Local;

  // Harness picker is gated on `harness-selection` (consistent with the
  // dashboard selector and the backend launch admission) and only rendered
  // inside the already-explicit-gated popover. Hidden while a selection is still
  // pending (no current preference to bind to) and for a Local mode with no
  // effective target — there is no per-target harness to bind to (the offline
  // banner already guides remediation).
  const showHarnessSection =
    requireExplicitSelection &&
    harnessSelectionEnabled &&
    !needsSelection &&
    !(isLocal && !effectiveTarget);

  // T-4.4: no registered targets at all
  const shouldShowNotInstalled = !targetsLoading && notInstalled;
  // T-4.5: targets registered but all offline
  const shouldShowAllOffline = !targetsLoading && allOffline;

  // ISS-6109: the browser cannot observe whether `closedloop://` was handled, so
  // the only honest signal is whether the desktop becomes reachable afterwards.
  // Reachability is "one of MY OWN desktops is actually online". Not "the
  // offline banner is hidden" (it also hides when the target list is empty or
  // still resolving) and not "any target is online" (a teammate's shared machine
  // coming up says nothing about the launch this user just fired). Getting this
  // wrong silently cancels a genuinely failed launch's pending verdict.
  const launchFallbackEnabled = useFeatureFlagEnabled(
    DESKTOP_LAUNCH_FALLBACK_FEATURE_FLAG_KEY
  );
  const {
    isAwaitingLaunch,
    reset: resetLaunchFallback,
    showFallback: showLaunchFallback,
    startLaunchAttempt,
  } = useDesktopLaunchFallback({
    enabled: launchFallbackEnabled,
    isDesktopReachable: ownTargets.some((target) => target.isOnline),
    // The list is otherwise only refreshed by the SSE push above, which is
    // exactly the signal that can be down while a launch is pending.
    refreshReachability: refetchComputeTargets,
  });
  // The launch outcome is the ONLY reader of the release feed, so the query is
  // gated on an attempt actually being in flight — not on the flag, and not on
  // the offline banner being rendered. This popover lives in the global sidebar
  // footer, so anything broader fetches `/electron-release` on every
  // authenticated page for a Local user who never presses Launch. The click
  // starts the fetch a full bound before the fallback can read it.
  const { isLaunchOutcomeVisible, shouldShowOfflineRemediation } =
    resolveLaunchControlVisibility({
      isAllOffline: shouldShowAllOffline,
      isAwaitingLaunch,
      isLocal,
      showLaunchFallback,
    });
  const { data: latestDesktopRelease, isLoading: isDesktopReleaseLoading } =
    useLatestElectronRelease({ enabled: isLaunchOutcomeVisible });

  const triggerLabel = getTriggerLabel({
    effectiveTargetName: effectiveTarget?.machineName,
    isLocalOffline: isLocal && shouldShowAllOffline,
    isLocal,
    needsSelection,
  });

  function getTriggerIcon() {
    if (isDegraded) {
      return (
        <AlertTriangleIcon
          aria-label="SSE stream degraded"
          className="size-4 text-warning"
        />
      );
    }
    // T-4.5: show warning badge on trigger when local preference is set but all targets are offline
    if (isLocal && shouldShowAllOffline) {
      return (
        <AlertTriangleIcon
          aria-label="Desktop app offline"
          className="size-4 text-warning"
        />
      );
    }
    if (isLocal) {
      return <LaptopIcon className="size-4" />;
    }
    return <CloudIcon className="size-4" />;
  }

  // `setOpen(false)` on a controlled Popover does NOT fire `onOpenChange`, so
  // every programmatic close must come through here or a pending launch verdict
  // latches and resurfaces the next time the popover opens.
  function closePopover(): void {
    setShowDownloadPrompt(false);
    resetLaunchFallback();
    setOpen(false);
  }

  function handleSelectCloud(): void {
    setPreference.mutate({ mode: ComputePreference.Cloud });
    closePopover();
  }

  function handleSelectLocal(targetId: string): void {
    const target = targets.find((t) => t.id === targetId);
    if (!target?.isOnline) {
      return;
    }
    setPreference.mutate({
      mode: ComputePreference.Local,
      computeTargetId: targetId,
    });
    closePopover();
  }

  function handleLocalOptionClick(): void {
    // T-4.4: no registered targets -- show download prompt, do NOT set preference
    if (shouldShowNotInstalled) {
      setShowDownloadPrompt(true);
      return;
    }
  }

  function handleLaunchDesktopApp(): void {
    // T-4.5 / ISS-6109: invoke the custom URI scheme the desktop installer
    // registers. Navigation to an UNREGISTERED scheme is a silent no-op with no
    // error event, so arm the bounded fallback first — that wait is the only
    // way the user learns nothing answered.
    startLaunchAttempt();
    globalThis.location.href = DESKTOP_DEEP_LINK_URL;
  }

  return (
    <Popover
      onOpenChange={(next) => {
        if (next) {
          setOpen(true);
          return;
        }
        closePopover();
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <SidebarMenuButton aria-label={triggerLabel} tooltip={triggerLabel}>
          {getTriggerIcon()}
          <span>{triggerLabel}</span>
        </SidebarMenuButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Select compute target"
        className="w-80 p-2"
        side="right"
        sideOffset={8}
      >
        <div className="mb-2 px-3 pt-1">
          <p className="font-semibold text-sm">Compute Target</p>
          <p className="text-muted-foreground text-xs">
            Choose where AI agent jobs run
          </p>
        </div>

        {isDegraded && (
          <Alert className="mb-2" variant="warning">
            <AlertTriangleIcon />
            <AlertDescription>
              Live status updates unavailable. Reconnect attempts exhausted.
            </AlertDescription>
          </Alert>
        )}

        {/* T-4.5: offline warning banner -- shown when preference is Local but all targets are offline */}
        {shouldShowOfflineRemediation && (
          <Alert className="mb-2" variant="warning">
            <AlertTriangleIcon />
            <AlertTitle>Desktop app is offline</AlertTitle>
            <AlertDescription>
              <p>
                Your local compute target is not reachable. Switch to Cloud or
                relaunch the desktop app.
              </p>
              <div
                className="flex w-full flex-col gap-2"
                data-testid="offline-remediation-actions"
              >
                <Button
                  className={COMPACT_BUTTON_CLASS}
                  onClick={handleSelectCloud}
                  size="sm"
                  variant="outline"
                >
                  <CloudIcon className="size-3 shrink-0" />
                  Switch to Cloud
                </Button>
                {/* Gate on having at least one registered ComputeTarget (user has previously installed the app) */}
                {targets.length > 0 && (
                  <LaunchDesktopAppControl
                    compactButtonClass={COMPACT_BUTTON_CLASS}
                    downloadUrl={latestDesktopRelease?.downloadUrl ?? null}
                    isAwaitingLaunch={isAwaitingLaunch}
                    isDownloadUrlLoading={isDesktopReleaseLoading}
                    onLaunch={handleLaunchDesktopApp}
                    showFallback={showLaunchFallback}
                  />
                )}
              </div>
            </AlertDescription>
          </Alert>
        )}

        <div
          aria-label="Available compute targets"
          className="space-y-0.5"
          role="listbox"
        >
          <TargetOption
            description="Runs in Closedloop cloud infrastructure"
            icon={<CloudIcon className="size-4 text-info" />}
            isLoading={
              setPreference.isPending &&
              currentPreference !== ComputePreference.Cloud
            }
            isSelected={currentPreference === ComputePreference.Cloud}
            label="Cloud"
            onClick={handleSelectCloud}
          />

          {(targetsLoading || preferenceLoading) && targets.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-sm">
              <Loader2Icon className="size-3.5 animate-spin" />
              <span>Loading targets...</span>
            </div>
          )}

          {/* T-4.4: Local option shown when no targets registered; clicking opens download prompt */}
          {shouldShowNotInstalled && (
            <TargetOption
              description="Desktop app not installed"
              icon={<LaptopIcon className="size-4 text-muted-foreground" />}
              isLoading={false}
              isSelected={false}
              label="Local"
              onClick={handleLocalOptionClick}
            />
          )}

          {ownTargets.map((target) => (
            <TargetOption
              description={
                target.isOnline
                  ? `${target.platform} · Online`
                  : `${target.platform} · Offline`
              }
              icon={
                <LaptopIcon
                  className={cn(
                    "size-4",
                    target.isOnline ? "text-success" : "text-muted-foreground"
                  )}
                />
              }
              isLoading={
                setPreference.isPending &&
                currentPreference !== ComputePreference.Local &&
                target.isOnline
              }
              isSelected={
                currentPreference === ComputePreference.Local &&
                target.id === effectiveTargetId
              }
              key={target.id}
              label={target.machineName}
              onClick={() => handleSelectLocal(target.id)}
            />
          ))}

          {sharedTargets.length > 0 && (
            <>
              <div className="mt-2 mb-1 px-3">
                <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  Shared by team
                </p>
              </div>
              {sharedTargets.map((target) => (
                <TargetOption
                  description={
                    target.isOnline
                      ? `${target.ownerName ?? "Teammate"} · ${target.platform} · Online`
                      : `${target.ownerName ?? "Teammate"} · ${target.platform} · Offline`
                  }
                  icon={
                    <LaptopIcon
                      className={cn(
                        "size-4",
                        target.isOnline
                          ? "text-emerald-500"
                          : "text-muted-foreground"
                      )}
                    />
                  }
                  isLoading={
                    setPreference.isPending &&
                    currentPreference !== ComputePreference.Local &&
                    target.isOnline
                  }
                  isSelected={
                    currentPreference === ComputePreference.Local &&
                    target.id === effectiveTargetId
                  }
                  key={target.id}
                  label={target.machineName}
                  onClick={() => handleSelectLocal(target.id)}
                />
              ))}
            </>
          )}
        </div>

        {showHarnessSection && (
          <HarnessSection
            cloudSelectedHarness={preferenceData?.selectedHarness}
            effectiveTarget={effectiveTarget}
            effectiveTargetId={effectiveTargetId}
            isLocal={isLocal}
            setPreference={setPreference}
          />
        )}

        {/* T-4.4: download prompt -- popover stays open, preference NOT changed */}
        {showDownloadPrompt && shouldShowNotInstalled && (
          <Alert className="mt-2" variant="info">
            <DownloadIcon />
            <AlertTitle>Install Desktop App</AlertTitle>
            <AlertDescription>
              <p>Local compute requires the Closedloop Desktop app.</p>
              {/* TODO: Get desktop app download URL from product team */}
              <Button
                className={COMPACT_BUTTON_CLASS}
                disabled
                size="sm"
                variant="outline"
              >
                <DownloadIcon className="size-3 shrink-0" />
                Download Closedloop Desktop
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </PopoverContent>
    </Popover>
  );
}

function getTriggerLabel({
  effectiveTargetName,
  isLocalOffline,
  isLocal,
  needsSelection,
}: {
  effectiveTargetName?: string;
  isLocalOffline: boolean;
  isLocal: boolean;
  needsSelection: boolean;
}): string {
  if (needsSelection) {
    return "Select target";
  }
  if (isLocalOffline) {
    return "Compute: Local offline";
  }
  if (isLocal) {
    return `Compute: ${effectiveTargetName ?? "Local"}`;
  }
  return "Compute: Cloud";
}

/**
 * Resolves whether the offline remediation block — and the launch control it
 * hosts — is on screen, and whether a launch verdict is currently live.
 *
 * `allOffline` spans EVERY target, so a teammate's shared machine coming online
 * mid-attempt clears it and would unmount the very control the user is waiting
 * on, losing the verdict while their own desktop is still unreachable.
 * Reachability is owner-scoped (see the call site), so the mount that renders it
 * has to be too — for exactly as long as an attempt is live.
 */
function resolveLaunchControlVisibility(input: {
  isAllOffline: boolean;
  isAwaitingLaunch: boolean;
  isLocal: boolean;
  showLaunchFallback: boolean;
}): { isLaunchOutcomeVisible: boolean; shouldShowOfflineRemediation: boolean } {
  const isLaunchOutcomeVisible =
    input.isAwaitingLaunch || input.showLaunchFallback;
  return {
    isLaunchOutcomeVisible,
    shouldShowOfflineRemediation:
      input.isLocal && (input.isAllOffline || isLaunchOutcomeVisible),
  };
}

/**
 * Resolves the available harnesses for the Local path from the per-target
 * health-check snapshot, falling back to the target's persisted harness when no
 * snapshot is present (mirrors ComputeTargetWithHarnessSelector).
 */
function deriveLocalAvailableHarnesses(
  snapshot: ComputeTargetHealthCheckSnapshot | null,
  effectiveTarget: ComputeTarget | null
): HarnessType[] {
  if (!snapshot) {
    return effectiveTarget ? [effectiveTarget.selectedHarness] : [];
  }
  return deriveAvailableHarnessesFromSnapshot(snapshot);
}

type HarnessSectionProps = {
  /** Persisted Cloud harness; undefined falls back to the Claude default. */
  cloudSelectedHarness: HarnessType | undefined;
  effectiveTarget: ComputeTarget | null;
  effectiveTargetId: string | null;
  isLocal: boolean;
  setPreference: ReturnType<typeof useSetComputePreference>;
};

/**
 * AI-harness selector bound to the effective compute selection. Local routes
 * the change to the per-target PATCH; Cloud routes it to the user-scoped
 * compute-preference PUT. Rendering this component is itself the gate for the
 * Local health-check snapshot query — it only mounts behind the harness flag.
 */
function HarnessSection({
  cloudSelectedHarness,
  effectiveTarget,
  effectiveTargetId,
  isLocal,
  setPreference,
}: HarnessSectionProps) {
  const { mutate: updateHarness } = useUpdateComputeTargetHarness();
  // The Cloud path has no per-target snapshot; the hook no-ops on a null id.
  const { data: healthCheckSnapshot = null } =
    useComputeTargetHealthCheckSnapshot(isLocal ? effectiveTargetId : null);

  const availableHarnesses = isLocal
    ? deriveLocalAvailableHarnesses(healthCheckSnapshot, effectiveTarget)
    : [HarnessType.Claude, HarnessType.Codex];

  const currentHarness = isLocal
    ? effectiveTarget?.selectedHarness
    : cloudSelectedHarness;
  const selectedHarness =
    currentHarness ?? resolveDefaultHarness(availableHarnesses);

  function handleHarnessChange(harness: HarnessType): void {
    if (isLocal) {
      if (effectiveTargetId) {
        updateHarness({ id: effectiveTargetId, harness });
      }
      return;
    }
    setPreference.mutate({
      mode: ComputePreference.Cloud,
      selectedHarness: harness,
    });
  }

  return (
    <div className="mt-2 border-t px-3 pt-3">
      <p className="mb-1.5 font-medium text-muted-foreground text-xs">
        AI harness
      </p>
      <HarnessSelector
        availableHarnesses={availableHarnesses}
        onHarnessChange={handleHarnessChange}
        selectedHarness={selectedHarness}
      />
    </div>
  );
}
