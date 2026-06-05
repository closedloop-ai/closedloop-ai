"use client";

import { ComputePreference } from "@repo/api/src/types/compute-target";
import { useUser } from "@repo/auth/client";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import {
  SidebarMenuButton,
  useSidebar,
} from "@repo/design-system/components/ui/sidebar";
import { cn } from "@repo/design-system/lib/utils";
import {
  AlertTriangleIcon,
  CheckIcon,
  CloudIcon,
  DownloadIcon,
  LaptopIcon,
  Loader2Icon,
  PowerIcon,
} from "lucide-react";
import { useState } from "react";
import {
  useComputePreference,
  useSetComputePreference,
} from "@/hooks/queries/use-compute-preference";
import { useComputeTargetStatusStream } from "@/hooks/queries/use-compute-target-status-stream";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import { sortByDateDesc } from "@/lib/table-utils";

// Mirrors the internal MAX_RECONNECT_ATTEMPTS in use-compute-target-status-stream.ts
const SSE_MAX_RECONNECT_ATTEMPTS = 3;

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
  const { user } = useUser();
  const userId = user?.id ?? "";
  const sidebar = useSidebar();

  // Keep SSE stream alive for real-time target status updates
  useComputeTargetStatusStream(true);

  const { data: targets = [], isLoading: targetsLoading } = useComputeTargets();
  const { data: preferenceData, isLoading: preferenceLoading } =
    useComputePreference(userId, { enabled: !!userId });
  const setPreference = useSetComputePreference(userId);

  const isDegraded = isStreamDegraded(streamReconnectAttempts);
  const currentPreference =
    preferenceData?.preferredComputeMode ?? ComputePreference.Cloud;
  const ownTargets = targets.filter((t) => !t.ownerName);
  const sharedTargets = targets.filter((t) => !!t.ownerName);
  const onlineTargets = targets.filter((t) => t.isOnline);
  const isLocal = currentPreference === ComputePreference.Local;

  // Only use persisted target if it is currently online; otherwise fall back to
  // the most recently active online target so the UI matches backend dispatch.
  const persistedTargetId = preferenceData?.computeTargetId;
  const persistedIsOnline =
    persistedTargetId != null &&
    onlineTargets.some((t) => t.id === persistedTargetId);
  const defaultActiveTargetId = persistedIsOnline
    ? persistedTargetId
    : sortByDateDesc(onlineTargets, "lastSeenAt")[0]?.id;

  const activeLocalTarget = isLocal
    ? (targets.find((t) => t.id === defaultActiveTargetId) ??
      onlineTargets[0] ??
      null)
    : null;

  // T-4.4: no registered targets at all
  const notInstalled = !targetsLoading && targets.length === 0;
  // T-4.5: targets registered but all offline
  const allOffline =
    !targetsLoading && targets.length > 0 && targets.every((t) => !t.isOnline);

  const triggerLabel = isLocal
    ? `Compute: ${activeLocalTarget?.machineName ?? "Local"}`
    : "Compute: Cloud";

  function getTriggerIcon() {
    if (isDegraded) {
      return (
        <AlertTriangleIcon
          aria-label="SSE stream degraded"
          className="size-4 text-amber-500"
        />
      );
    }
    // T-4.5: show warning badge on trigger when local preference is set but all targets are offline
    if (isLocal && allOffline) {
      return (
        <AlertTriangleIcon
          aria-label="Desktop app offline"
          className="size-4 text-amber-500"
        />
      );
    }
    if (isLocal) {
      return <LaptopIcon className="size-4" />;
    }
    return <CloudIcon className="size-4" />;
  }

  function handleSelectCloud(): void {
    setPreference.mutate({ mode: ComputePreference.Cloud });
    setShowDownloadPrompt(false);
    setOpen(false);
  }

  function handleSelectLocal(targetId: string): void {
    const target = targets.find((t) => t.id === targetId);
    if (!target?.isOnline) {
      return;
    }
    setShowDownloadPrompt(false);
    setPreference.mutate({
      mode: ComputePreference.Local,
      computeTargetId: targetId,
    });
    setOpen(false);
  }

  function handleLocalOptionClick(): void {
    // T-4.4: no registered targets -- show download prompt, do NOT set preference
    if (notInstalled) {
      setShowDownloadPrompt(true);
      return;
    }
  }

  function handleLaunchDesktopApp(): void {
    // T-4.5: invoke custom URI scheme registered by the desktop installer.
    globalThis.location.href = "closedloop://";
  }

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setShowDownloadPrompt(false);
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <SidebarMenuButton
          aria-label={triggerLabel}
          tooltip={sidebar.open ? undefined : triggerLabel}
        >
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
          <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400">
            <AlertTriangleIcon className="size-3.5 shrink-0" />
            <p className="text-xs">
              Live status updates unavailable. Reconnect attempts exhausted.
            </p>
          </div>
        )}

        {/* T-4.5: offline warning banner -- shown when preference is Local but all targets are offline */}
        {isLocal && allOffline && (
          <div className="mb-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400">
            <div className="mb-1.5 flex items-center gap-2">
              <AlertTriangleIcon className="size-3.5 shrink-0" />
              <p className="font-medium text-xs">Desktop app is offline</p>
            </div>
            <p className="mb-2 text-xs">
              Your local compute target is not reachable. Switch to Cloud or
              relaunch the desktop app.
            </p>
            <div className="flex gap-2">
              <Button
                className="h-7 flex-1 text-xs"
                onClick={handleSelectCloud}
                size="sm"
                variant="outline"
              >
                <CloudIcon className="size-3 shrink-0" />
                Switch to Cloud
              </Button>
              {/* Gate on having at least one registered ComputeTarget (user has previously installed the app) */}
              {targets.length > 0 && (
                <Button
                  className="h-7 flex-1 text-xs"
                  onClick={handleLaunchDesktopApp}
                  size="sm"
                  variant="outline"
                >
                  <PowerIcon className="size-3 shrink-0" />
                  Launch Desktop App
                </Button>
              )}
            </div>
          </div>
        )}

        <div
          aria-label="Available compute targets"
          className="space-y-0.5"
          role="listbox"
        >
          <TargetOption
            description="Runs in ClosedLoop cloud infrastructure"
            icon={<CloudIcon className="size-4 text-blue-500" />}
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
          {notInstalled && (
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
                target.id === defaultActiveTargetId
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
                    target.id === defaultActiveTargetId
                  }
                  key={target.id}
                  label={target.machineName}
                  onClick={() => handleSelectLocal(target.id)}
                />
              ))}
            </>
          )}
        </div>

        {/* T-4.4: download prompt -- popover stays open, preference NOT changed */}
        {showDownloadPrompt && notInstalled && (
          <div className="mt-2 rounded-md border border-blue-400/30 bg-blue-400/10 px-3 py-2 text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-400">
            <div className="mb-1.5 flex items-center gap-2">
              <DownloadIcon className="size-3.5 shrink-0" />
              <p className="font-medium text-xs">Install Desktop App</p>
            </div>
            <p className="mb-2 text-xs">
              Local compute requires the ClosedLoop Desktop app.
            </p>
            {/* TODO: Get desktop app download URL from product team */}
            <Button
              className="h-7 w-full text-xs"
              disabled
              size="sm"
              variant="outline"
            >
              <DownloadIcon className="size-3 shrink-0" />
              Download ClosedLoop Desktop
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
