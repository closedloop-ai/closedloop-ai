"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  type ComputeTarget,
  DesktopSecurityStatus,
} from "@closedloop-ai/loops-api/compute-target";
import { Download, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";

export type TargetSecurity = NonNullable<ComputeTarget["security"]>;

type DesktopSecurityBadgeProps = {
  security: TargetSecurity;
};

type DesktopUpdateDownloadButtonProps = {
  downloadUrl: string | null;
  isLoading: boolean;
};

export function getTargetSecurity(
  target: { security?: TargetSecurity } | undefined
): TargetSecurity {
  return (
    target?.security ?? {
      status: DesktopSecurityStatus.Unknown,
      reason: "LOOKUP_FAILED",
      upgradeSupported: false,
    }
  );
}

export function getSecurityLabel(security: TargetSecurity): string {
  if (security.reason === "FEATURE_DISABLED") {
    return "Standard";
  }
  if (security.status === DesktopSecurityStatus.Protected) {
    return "Protected";
  }
  if (security.status === DesktopSecurityStatus.UpgradeAvailable) {
    return "Upgrade available";
  }
  if (security.status === DesktopSecurityStatus.LegacyManual) {
    return "Reconnect Desktop";
  }
  if (security.status === DesktopSecurityStatus.Unknown) {
    return "Status unavailable";
  }
  if (
    security.reason === "MISSING_GATEWAY_ID" ||
    security.reason === "UNSUPPORTED_DESKTOP_VERSION"
  ) {
    return "Update required";
  }
  return "Not upgradeable";
}

export function requiresDesktopUpdateAction(security: TargetSecurity): boolean {
  return (
    security.reason === "MISSING_GATEWAY_ID" ||
    security.reason === "UNSUPPORTED_DESKTOP_VERSION"
  );
}

export function DesktopSecurityBadge({
  security,
}: Readonly<DesktopSecurityBadgeProps>) {
  return (
    <Badge className="gap-1" variant="outline">
      {security.status === DesktopSecurityStatus.Protected ? (
        <ShieldCheck className="size-3" />
      ) : (
        <ShieldAlert className="size-3" />
      )}
      {getSecurityLabel(security)}
    </Badge>
  );
}

export function DesktopUpdateDownloadButton({
  downloadUrl,
  isLoading,
}: Readonly<DesktopUpdateDownloadButtonProps>) {
  if (downloadUrl) {
    return (
      <Button asChild size="sm" variant="outline">
        <a href={downloadUrl} rel="noreferrer" target="_blank">
          <Download className="h-4 w-4" />
          Download update
        </a>
      </Button>
    );
  }

  return (
    <Button disabled size="sm" variant="outline">
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Download className="h-4 w-4" />
      )}
      {isLoading ? "Loading update" : "Download unavailable"}
    </Button>
  );
}
