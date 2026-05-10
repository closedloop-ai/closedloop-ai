"use client";

import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { useUser } from "@repo/auth/client";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Switch } from "@repo/design-system/components/ui/switch";
import { useIsFetching, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Info,
  KeyRound,
  Laptop,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { type MouseEvent, useCallback, useEffect, useState } from "react";
import { SystemCheckResults } from "@/components/system-check/system-check-results";
import { env } from "@/env";
import {
  useComputeTargets,
  useDeleteComputeTarget,
  useToggleComputeTargetSharing,
} from "@/hooks/queries/use-compute-targets";
import { useLatestElectronRelease } from "@/hooks/queries/use-electron-release";
import {
  useRegisterBrowserCommandKey,
  useUnregisterBrowserCommandKey,
} from "@/hooks/queries/use-public-keys";
import { hasEffectiveCommandSigningSupport } from "@/lib/crypto/command-signer";
import { getStoredBrowserSigningKeyMetadata } from "@/lib/crypto/key-store";
import {
  COMPUTE_TARGETS_QUERY_OPTIONS,
  DESKTOP_SETUP_URL,
} from "@/lib/engineer/constants";
import type { CheckResult } from "@/lib/engineer/queries/health-check";
import {
  getHealthCheckTargetKey,
  getRenderableHealthChecks,
  healthCheckOptions,
} from "@/lib/engineer/queries/health-check";
import { queryKeys } from "@/lib/engineer/queries/keys";
import {
  getSecurityLabel,
  getTargetSecurity,
  requiresDesktopUpdateAction,
} from "./desktop-security-helpers";
import { DesktopUpdateDownloadButton } from "./desktop-update-download-button";
import { UpdateAndRestartButton } from "./update-and-restart-button";

const DOWNLOAD_URL_ALLOWLIST = ["github.com", "objects.githubusercontent.com"];

function isAllowedDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      DOWNLOAD_URL_ALLOWLIST.includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function formatLastSeen(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function formatLastChecked(value: number): string {
  if (value <= 0) {
    return "Not run yet";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function getFailureCount(checks: CheckResult[] | undefined): number {
  return checks?.filter((check) => !check.passed).length ?? 0;
}

function getSystemCheckSummary(
  checks: CheckResult[] | undefined,
  isFetching: boolean,
  isEligible: boolean
): string {
  if (!checks?.length) {
    if (isFetching) {
      return "Running system check...";
    }
    return isEligible
      ? "Awaiting first system check"
      : "System check unavailable";
  }

  const failureCount = getFailureCount(checks);
  return failureCount === 0
    ? "All checks passed"
    : `${failureCount} failure${failureCount === 1 ? "" : "s"}`;
}

function getStatusDescription(
  hasHealthCheckResult: boolean,
  dataUpdatedAt: number,
  isHealthCheckFetching: boolean,
  isEligible: boolean,
  targetName: string
): string {
  if (hasHealthCheckResult) {
    return `Last checked ${formatLastChecked(dataUpdatedAt)}`;
  }

  if (isHealthCheckFetching) {
    return `Checking ${targetName}.`;
  }

  if (isEligible) {
    return `Run a check for ${targetName}.`;
  }

  return "System checks require this target to be online.";
}

function renderStatusIcon({
  hasHealthCheckResult,
  hasPassingResult,
  isHealthCheckFetching,
}: {
  hasHealthCheckResult: boolean;
  hasPassingResult: boolean;
  isHealthCheckFetching: boolean;
}) {
  if (isHealthCheckFetching) {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  }

  if (hasPassingResult) {
    return <CheckCircle2 className="size-4 text-emerald-500" />;
  }

  if (hasHealthCheckResult) {
    return <AlertCircle className="size-4 text-amber-500" />;
  }

  return <Info className="size-4 text-muted-foreground" />;
}

function getSummaryBadgeClassName({
  hasHealthCheckResult,
  hasPassingResult,
  isHealthCheckFetching,
  isEligible,
}: {
  hasHealthCheckResult: boolean;
  hasPassingResult: boolean;
  isHealthCheckFetching: boolean;
  isEligible: boolean;
}): string {
  if (isHealthCheckFetching) {
    return "border-primary/30 bg-primary/10 text-primary";
  }
  if (hasPassingResult) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (hasHealthCheckResult) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (!isEligible) {
    return "border-border bg-background/70 text-muted-foreground";
  }
  return "border-primary/20 bg-primary/5 text-primary";
}

function ComputeTargetSystemCheck({
  expectedMcpUrl,
  isLatestVersionLoading,
  latestVersion,
  target,
}: {
  expectedMcpUrl: string | null;
  isLatestVersionLoading: boolean;
  latestVersion: string | null;
  target: ComputeTarget;
}) {
  const [open, setOpen] = useState(false);
  const healthCheckTargetKey = getHealthCheckTargetKey({
    mode: EngineerRoutingMode.CloudRelay,
    computeTargetId: target.id,
  });
  const healthCheckQueryKey = queryKeys.healthCheck(
    healthCheckTargetKey,
    expectedMcpUrl,
    latestVersion
  );
  const {
    data: healthCheckData,
    dataUpdatedAt,
    refetch: refetchHealthCheck,
  } = useQuery({
    ...healthCheckOptions(healthCheckTargetKey, expectedMcpUrl, {
      relayTargetId: target.id,
      latestVersion,
    }),
    enabled: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const isHealthCheckFetching =
    useIsFetching({ queryKey: healthCheckQueryKey }) > 0;
  const isEligible = target.isOnline;
  const canRunHealthCheck = isEligible && !isLatestVersionLoading;

  const handleRunCheck = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    if (!canRunHealthCheck) {
      return;
    }

    await refetchHealthCheck();
  };

  const renderableChecks = getRenderableHealthChecks(
    healthCheckData,
    expectedMcpUrl
  );
  const failureCount = getFailureCount(renderableChecks);
  const summary = getSystemCheckSummary(
    renderableChecks,
    isHealthCheckFetching,
    isEligible
  );
  const hasHealthCheckResult = healthCheckData !== undefined;
  const hasPassingResult = healthCheckData !== undefined && failureCount === 0;
  const statusDescription = getStatusDescription(
    hasHealthCheckResult,
    dataUpdatedAt,
    isHealthCheckFetching,
    isEligible,
    target.machineName
  );
  const summaryBadgeClassName = getSummaryBadgeClassName({
    hasHealthCheckResult,
    hasPassingResult,
    isHealthCheckFetching,
    isEligible,
  });

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <div className="-mx-3 mt-3 border-t bg-muted/15 px-4 py-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <CollapsibleTrigger className="group flex min-w-0 items-start gap-3 rounded-sm text-left">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/55 text-muted-foreground transition-colors group-hover:bg-muted group-hover:text-foreground">
              <ChevronDown className="size-4 transition-transform group-data-[state=closed]:-rotate-90" />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                {renderStatusIcon({
                  hasHealthCheckResult,
                  hasPassingResult,
                  isHealthCheckFetching,
                })}
                <p className="font-medium text-sm">System Check</p>
                <Badge
                  className={`h-6 rounded-md px-2 font-medium text-xs tabular-nums ${summaryBadgeClassName}`}
                  variant="outline"
                >
                  {summary}
                </Badge>
              </div>
              <p className="text-muted-foreground text-sm">
                {statusDescription}
              </p>
            </div>
          </CollapsibleTrigger>

          <Button
            className="w-full shrink-0 gap-1.5 md:w-auto"
            disabled={!canRunHealthCheck || isHealthCheckFetching}
            onClick={handleRunCheck}
            size="sm"
            variant="outline"
          >
            <RefreshCw
              className={`size-3.5 ${isHealthCheckFetching ? "animate-spin" : ""}`}
            />
            {hasHealthCheckResult ? "Re-check" : "Run check"}
          </Button>
        </div>

        <CollapsibleContent className="mt-4 border-t pt-4">
          {healthCheckData ? (
            <SystemCheckResults checks={renderableChecks} />
          ) : (
            <p className="text-muted-foreground text-sm">
              {isEligible
                ? "Run a system check to inspect this compute target."
                : "System checks are available when this compute target is online."}
            </p>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function BrowserCommandSigningPanel() {
  const registerBrowserKey = useRegisterBrowserCommandKey();
  const unregisterBrowserKey = useUnregisterBrowserCommandKey();
  const [registeredFingerprint, setRegisteredFingerprint] = useState<
    string | null
  >(null);
  const isMutating =
    registerBrowserKey.isPending || unregisterBrowserKey.isPending;

  useEffect(() => {
    let cancelled = false;

    getStoredBrowserSigningKeyMetadata().then((key) => {
      if (!cancelled && key.ok) {
        setRegisteredFingerprint(key.fingerprint);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleRegisterBrowserKey = () => {
    if (registeredFingerprint) {
      return;
    }

    registerBrowserKey.mutate(undefined, {
      onSuccess: (key) => {
        setRegisteredFingerprint(key.fingerprint);
        toast.success("Browser signing key registered");
      },
    });
  };

  const handleUnregisterBrowserKey = () => {
    if (!registeredFingerprint) {
      return;
    }

    unregisterBrowserKey.mutate(registeredFingerprint, {
      onSuccess: () => {
        setRegisteredFingerprint(null);
        toast.success("Browser signing key unregistered");
      },
    });
  };

  let buttonIcon = <KeyRound className="size-4" />;
  if (isMutating) {
    buttonIcon = <Loader2 className="size-4 animate-spin" />;
  } else if (registeredFingerprint) {
    buttonIcon = <Trash2 className="size-4" />;
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          <p className="font-medium text-sm">Browser Command Signing</p>
        </div>
        <p className="text-muted-foreground text-xs">
          {registeredFingerprint
            ? `Registered key ${registeredFingerprint}`
            : "Register this browser before authorizing it in Desktop."}
        </p>
      </div>
      <Button
        disabled={isMutating}
        onClick={
          registeredFingerprint
            ? handleUnregisterBrowserKey
            : handleRegisterBrowserKey
        }
        size="sm"
        variant="outline"
      >
        {buttonIcon}
        {registeredFingerprint ? "Unregister" : "Register Browser"}
      </Button>
    </div>
  );
}

export function LocalComputeTargetsCard() {
  const { user } = useUser();
  const userId = user?.id ?? "";
  const [updatingTargets, setUpdatingTargets] = useState<Set<string>>(
    new Set()
  );
  const { data: targets = [], isLoading } = useComputeTargets({
    ...COMPUTE_TARGETS_QUERY_OPTIONS,
  });
  const { data: latestDesktopRelease, isLoading: isDesktopReleaseLoading } =
    useLatestElectronRelease();
  const deleteTarget = useDeleteComputeTarget(userId);
  const toggleSharing = useToggleComputeTargetSharing();
  const desktopUpdateUrl = latestDesktopRelease?.downloadUrl ?? null;
  const latestDesktopVersion = latestDesktopRelease?.version ?? null;

  const handleUpdateIsUpdatingChange = useCallback(
    (targetId: string, isUpdating: boolean) => {
      setUpdatingTargets((prev) => {
        if (isUpdating) {
          if (prev.has(targetId)) {
            return prev;
          }
          const next = new Set(prev);
          next.add(targetId);
          return next;
        }
        if (!prev.has(targetId)) {
          return prev;
        }
        const next = new Set(prev);
        next.delete(targetId);
        return next;
      });
    },
    []
  );

  const handleUpdateSuccess = useCallback((machineName: string) => {
    toast.success(`${machineName} updated and restarted successfully`);
  }, []);

  const handleUpdateError = useCallback(
    (machineName: string, downloadUrl: string) => {
      const safeUrl = isAllowedDownloadUrl(downloadUrl) ? downloadUrl : null;
      if (safeUrl) {
        toast.error(
          `Update failed for ${machineName}. Download manually: ${safeUrl}`
        );
      } else {
        toast.error(`Update failed for ${machineName}`);
      }
    },
    []
  );

  const handleUpdateExpired = useCallback((machineName: string) => {
    toast.warning(`Update command expired for ${machineName}. Please retry.`);
  }, []);
  const expectedMcpUrl = env.NEXT_PUBLIC_MCP_SERVER_URL ?? null;

  const handleDelete = (id: string, machineName: string) => {
    deleteTarget.mutate(id, {
      onSuccess: () => toast.success(`Removed ${machineName}`),
    });
  };

  let content: React.ReactNode;
  if (isLoading) {
    content = (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  } else if (targets.length === 0) {
    content = (
      <div className="space-y-3 rounded-lg border border-dashed p-4">
        <p className="text-sm">No compute targets registered yet.</p>
        <p className="text-muted-foreground text-sm">
          Install the ClosedLoop Desktop client, then connect with an API key
          from{" "}
          <Link className="underline" href="/settings?tab=api-keys">
            Settings - API Keys
          </Link>
          .
        </p>
        <a
          className="inline-flex text-primary text-sm underline"
          href={DESKTOP_SETUP_URL}
          rel="noreferrer"
          target="_blank"
        >
          Open desktop setup instructions
        </a>
      </div>
    );
  } else {
    // Only show the user's own targets in settings (not shared targets from others)
    const ownTargets = targets.filter((t) => !t.ownerName);
    const signingSupported = ownTargets.some(hasEffectiveCommandSigningSupport);
    content = (
      <div className="space-y-3">
        {signingSupported ? <BrowserCommandSigningPanel /> : null}
        {ownTargets.map((target) => {
          const isUpdating = updatingTargets.has(target.id);
          const security = getTargetSecurity(target);
          return (
            <div className="rounded-lg border p-3" key={target.id}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium">{target.machineName}</p>
                    <Badge
                      className="capitalize"
                      variant={target.isOnline ? "default" : "secondary"}
                    >
                      {target.isOnline ? "online" : "offline"}
                    </Badge>
                    <Badge className="gap-1" variant="outline">
                      {security.status === "protected" ? (
                        <ShieldCheck className="size-3" />
                      ) : (
                        <ShieldAlert className="size-3" />
                      )}
                      {getSecurityLabel(security)}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {target.platform} - Last seen{" "}
                    {formatLastSeen(target.lastSeenAt)}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {security.upgradeSupported && (
                    <Button asChild size="sm" variant="outline">
                      <Link
                        aria-disabled={isUpdating}
                        className={
                          isUpdating ? "pointer-events-none opacity-50" : ""
                        }
                        href={`/settings/compute-targets/${target.id}/security-upgrade`}
                      >
                        <ShieldCheck className="h-4 w-4" />
                        Upgrade security
                      </Link>
                    </Button>
                  )}

                  {requiresDesktopUpdateAction(security) && (
                    <DesktopUpdateDownloadButton
                      downloadUrl={desktopUpdateUrl}
                      isLoading={isDesktopReleaseLoading}
                    />
                  )}

                  <UpdateAndRestartButton
                    onError={(downloadUrl) =>
                      handleUpdateError(target.machineName, downloadUrl)
                    }
                    onExpired={() => handleUpdateExpired(target.machineName)}
                    onIsUpdatingChange={(updating) =>
                      handleUpdateIsUpdatingChange(target.id, updating)
                    }
                    onSuccess={() => handleUpdateSuccess(target.machineName)}
                    target={target}
                  />

                  <Button
                    disabled={deleteTarget.isPending || isUpdating}
                    onClick={() => handleDelete(target.id, target.machineName)}
                    size="sm"
                    variant="outline"
                  >
                    {deleteTarget.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    Delete
                  </Button>
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between border-t pt-2">
                <div>
                  <p className="text-sm">Share with team</p>
                  <p className="text-muted-foreground text-xs">
                    Allow anyone in your org to run jobs on this machine
                  </p>
                </div>
                <Switch
                  checked={target.isSharedWithOrg}
                  disabled={toggleSharing.isPending || isUpdating}
                  onCheckedChange={(checked) =>
                    toggleSharing.mutate(
                      { id: target.id, isSharedWithOrg: checked },
                      {
                        onSuccess: () =>
                          toast.success(
                            checked
                              ? `${target.machineName} is now shared with your org`
                              : `${target.machineName} is no longer shared`
                          ),
                      }
                    )
                  }
                />
              </div>

              <ComputeTargetSystemCheck
                expectedMcpUrl={expectedMcpUrl}
                isLatestVersionLoading={isDesktopReleaseLoading}
                latestVersion={latestDesktopVersion}
                target={target}
              />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Laptop className="h-5 w-5" />
          Local Compute Targets
        </CardTitle>
        <CardDescription>
          Manage desktop clients connected to your account for local agent job
          execution.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">{content}</CardContent>
    </Card>
  );
}
