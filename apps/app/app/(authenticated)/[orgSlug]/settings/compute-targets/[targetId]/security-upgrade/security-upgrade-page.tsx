"use client";

import type { TargetSecurity } from "@repo/app/compute/components/desktop-security";
import {
  DesktopSecurityBadge,
  DesktopUpdateDownloadButton,
  getTargetSecurity,
  requiresDesktopUpdateAction,
} from "@repo/app/compute/components/desktop-security";
import { useLatestElectronRelease } from "@repo/app/desktop/hooks/use-electron-release";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Separator } from "@repo/design-system/components/ui/separator";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Link } from "@repo/navigation/link";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  useComputeTargets,
  useStartDesktopSecurityUpgrade,
} from "@/hooks/queries/use-compute-targets";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { COMPUTE_TARGETS_QUERY_OPTIONS } from "@/lib/engineer/constants";

type SecurityUpgradePageProperties = {
  targetId: string;
};

function formatLastSeen(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function formatExpiresAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "soon";
  }
  return new Intl.DateTimeFormat(undefined, {
    timeStyle: "short",
  }).format(date);
}

function getBlockedCopy(security: TargetSecurity): string {
  if (security.status === "protected") {
    return "This target already uses a Desktop-managed key.";
  }
  if (security.reason === "TARGET_OFFLINE") {
    return "Reconnect this Desktop target to this workspace before upgrading.";
  }
  if (security.reason === "MISSING_GATEWAY_ID") {
    return "Update Desktop so it can advertise a gateway identity before upgrading.";
  }
  if (security.reason === "UNSUPPORTED_DESKTOP_VERSION") {
    return "Update Desktop to a version that supports the security-upgrade protocol.";
  }
  if (security.reason === "SHARED_TARGET") {
    return "Only the owner of a shared target can upgrade its Desktop security.";
  }
  if (security.reason === "LOOKUP_FAILED") {
    return "Security status could not be checked. Retry after the target list refreshes.";
  }
  if (security.reason === "FEATURE_DISABLED") {
    return "Enhanced Desktop security is not enabled for this workspace.";
  }
  return "This target is not currently eligible for a security upgrade.";
}

function getErrorCopy(error: Error): string {
  if (error.message === "TARGET_NOT_FOUND") {
    return "The target could not be found for your account.";
  }
  if (error.message === "TARGET_NOT_UPGRADEABLE") {
    return "This target is no longer eligible for a security upgrade.";
  }
  if (error.message === "UPGRADE_COMMAND_DISPATCH_FAILED") {
    return "The command could not be delivered to Desktop. Retry once the target reconnects.";
  }
  return "The security upgrade could not be started.";
}

export function DesktopSecurityUpgradePage({
  targetId,
}: SecurityUpgradePageProperties) {
  const orgSlug = useOrgSlug();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { data: targets = [], isLoading } = useComputeTargets({
    ...COMPUTE_TARGETS_QUERY_OPTIONS,
    refetchOnMount: "always",
  });
  const { data: latestDesktopRelease, isLoading: isDesktopReleaseLoading } =
    useLatestElectronRelease();
  const startSecurityUpgrade = useStartDesktopSecurityUpgrade();
  const target = useMemo(
    () => targets.find((entry) => entry.id === targetId),
    [targetId, targets]
  );
  const security = getTargetSecurity(target);
  const commandExpiresAt = startSecurityUpgrade.data?.expiresAt;
  const isEligible = Boolean(target && security.upgradeSupported);
  const desktopUpdateUrl = latestDesktopRelease?.downloadUrl ?? null;
  let targetContent: React.ReactNode;

  if (isLoading) {
    targetContent = (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="size-4 animate-spin" />
        Loading target...
      </div>
    );
  } else if (target) {
    targetContent = (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{target.machineName}</span>
          <Badge variant={target.isOnline ? "default" : "secondary"}>
            {target.isOnline ? "online" : "offline"}
          </Badge>
          <DesktopSecurityBadge security={security} />
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Platform</dt>
            <dd>{target.platform}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last seen</dt>
            <dd>{formatLastSeen(target.lastSeenAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Gateway</dt>
            <dd className="break-all">{target.gatewayId ?? "Missing"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Status reason</dt>
            <dd>{security.reason}</dd>
          </div>
        </dl>
      </>
    );
  } else {
    targetContent = (
      <p className="text-muted-foreground text-sm">
        This target was not found for your account.
      </p>
    );
  }

  const startUpgrade = () => {
    if (!target) {
      return;
    }
    setErrorMessage(null);
    startSecurityUpgrade.mutate(
      {
        targetId: target.id,
        webAppOrigin: globalThis.location.origin,
      },
      {
        onSuccess: () => {
          toast.success(`Security upgrade sent to ${target.machineName}`);
        },
        onError: (error) => {
          const message = getErrorCopy(error);
          setErrorMessage(message);
        },
      }
    );
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
      <div>
        <Button asChild size="sm" variant="ghost">
          <Link href={`/${orgSlug}/settings?tab=integrations`}>
            <ArrowLeft className="size-4" />
            Settings
          </Link>
        </Button>
      </div>

      <div className="max-w-3xl space-y-6">
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">
            Desktop security upgrade
          </h1>
          <p className="text-muted-foreground">
            Review the target and send a one-time upgrade command to Desktop.
          </p>
        </div>

        <Separator />

        <Card>
          <CardHeader>
            <CardTitle>Target</CardTitle>
            <CardDescription>
              The command is bound to this compute target and the current web
              origin.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">{targetContent}</CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Upgrade Command</CardTitle>
            <CardDescription>
              Desktop will still ask for confirmation before it claims a managed
              key.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {commandExpiresAt ? (
              <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/12 p-3 text-sm text-success">
                <CheckCircle2 className="size-4" />
                Command sent. It expires at {formatExpiresAt(commandExpiresAt)}.
              </div>
            ) : null}

            {errorMessage ? (
              <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
                <ShieldAlert className="size-4" />
                {errorMessage}
              </div>
            ) : null}

            {isEligible ? (
              <Button
                disabled={startSecurityUpgrade.isPending}
                onClick={startUpgrade}
              >
                {startSecurityUpgrade.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ShieldCheck className="size-4" />
                )}
                Send upgrade command
              </Button>
            ) : (
              <div className="space-y-3">
                <p className="text-muted-foreground text-sm">
                  {getBlockedCopy(security)}
                </p>
                {requiresDesktopUpdateAction(security) && (
                  <DesktopUpdateDownloadButton
                    downloadUrl={desktopUpdateUrl}
                    isLoading={isDesktopReleaseLoading}
                  />
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
