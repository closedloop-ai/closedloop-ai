"use client";

import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { isAllowedDesktopReleaseDownloadUrl } from "@repo/api/src/types/desktop-release";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { ComputeTargetCard } from "@repo/app/compute/components/compute-target-card";
import { ComputeTargetSystemCheck as DesignSystemComputeTargetSystemCheck } from "@repo/app/compute/components/compute-target-system-check";
import {
  DesktopSecurityBadge,
  DesktopUpdateDownloadButton,
  getTargetSecurity,
  requiresDesktopUpdateAction,
} from "@repo/app/compute/components/desktop-security";
import { useLatestElectronRelease } from "@repo/app/desktop/hooks/use-electron-release";
import { useUser } from "@repo/auth/client";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Link } from "@repo/navigation/link";
import { useIsFetching, useQuery } from "@tanstack/react-query";
import { KeyRound, Laptop, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { SystemCheckResults } from "@/components/system-check/system-check-results";
import { env } from "@/env";
import {
  useComputeTargets,
  useDeleteComputeTarget,
  useToggleComputeTargetSharing,
} from "@/hooks/queries/use-compute-targets";
import {
  useRegisterBrowserCommandKey,
  useUnregisterBrowserCommandKey,
} from "@/hooks/queries/use-public-keys";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { hasEffectiveCommandSigningSupport } from "@/lib/desktop-command-signing/command-signer";
import { getStoredBrowserSigningKeyMetadata } from "@/lib/desktop-command-signing/key-store";
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
import { SettingsActionPanel } from "./settings-action-panel";
import { UpdateAndRestartButton } from "./update-and-restart-button";

function isAllowedDownloadUrl(url: string): boolean {
  return isAllowedDesktopReleaseDownloadUrl(url);
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

function ComputeTargetSystemCheckSection({
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

  const handleRunCheck = async () => {
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
  const hasHealthCheckResult = healthCheckData !== undefined;

  return (
    <DesignSystemComputeTargetSystemCheck
      actionDisabled={!canRunHealthCheck || isHealthCheckFetching}
      checkedAtLabel={
        hasHealthCheckResult ? formatLastChecked(dataUpdatedAt) : undefined
      }
      content={
        healthCheckData ? (
          <SystemCheckResults checks={renderableChecks} />
        ) : undefined
      }
      failureCount={failureCount}
      hasResult={hasHealthCheckResult}
      isEligible={isEligible}
      isLoading={isHealthCheckFetching}
      onAction={handleRunCheck}
      targetName={target.machineName}
    />
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
    <SettingsActionPanel
      action={
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
      }
      description={
        registeredFingerprint
          ? `Registered key ${registeredFingerprint}`
          : "Register this browser before authorizing it in Desktop."
      }
      icon={<KeyRound className="size-4" />}
      title="Browser Command Signing"
    />
  );
}

export function LocalComputeTargetsCard() {
  const orgSlug = useOrgSlug();
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
          Install the Closedloop Desktop client, then connect with an API key
          from{" "}
          <Link
            className="underline"
            href={`/${orgSlug}/settings?tab=api-keys`}
          >
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
            <ComputeTargetCard
              actions={
                <>
                  {security.upgradeSupported && (
                    <Button asChild size="sm" variant="outline">
                      <Link
                        aria-disabled={isUpdating}
                        className={
                          isUpdating ? "pointer-events-none opacity-50" : ""
                        }
                        href={`/${orgSlug}/settings/compute-targets/${target.id}/security-upgrade`}
                      >
                        <ShieldAlert className="h-4 w-4" />
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
                </>
              }
              isOnline={target.isOnline}
              key={target.id}
              name={target.machineName}
              onShareCheckedChange={(checked) =>
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
              securityBadge={<DesktopSecurityBadge security={security} />}
              shareChecked={target.isSharedWithOrg}
              shareDisabled={toggleSharing.isPending || isUpdating}
              subtitle={
                <>
                  {target.platform} - Last seen{" "}
                  {formatLastSeen(target.lastSeenAt)}
                </>
              }
              systemCheck={
                <ComputeTargetSystemCheckSection
                  expectedMcpUrl={expectedMcpUrl}
                  isLatestVersionLoading={isDesktopReleaseLoading}
                  latestVersion={latestDesktopVersion}
                  target={target}
                />
              }
            />
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
