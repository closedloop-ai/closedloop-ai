import {
  type ComputeTarget,
  DesktopSecurityStatus,
} from "@repo/api/src/types/compute-target";

export type TargetSecurity = NonNullable<ComputeTarget["security"]>;

/** Normalizes an optional target security payload for UI rendering. */
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

/** Returns the compact badge label for a Desktop security state. */
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

/** True when the browser can offer a Desktop app update instead of upgrade dispatch. */
export function requiresDesktopUpdateAction(security: TargetSecurity): boolean {
  return (
    security.reason === "MISSING_GATEWAY_ID" ||
    security.reason === "UNSUPPORTED_DESKTOP_VERSION"
  );
}
