import "server-only";

import { DesktopProvisioningPlatform } from "@repo/api/src/types/electron";
import { DESKTOP_MANAGED_POP_PROVISIONING_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";
import {
  type DesktopManagedFeatureFlagIdentity,
  isDesktopManagedFeatureFlagEnabled,
  isDesktopManagedPopEnforcementEnabled,
} from "./auth/desktop-managed-pop";

export const DESKTOP_MANAGED_POP_PROVISIONING_FLAG =
  DESKTOP_MANAGED_POP_PROVISIONING_SERVER_FLAG.key;
export const DESKTOP_MANAGED_POP_SUPPORTED_PLATFORM =
  DesktopProvisioningPlatform.Darwin;

/**
 * Returns whether automated installer provisioning is supported for a client platform.
 */
export function isDesktopManagedPopPlatformSupported(
  platform: string | null | undefined
): platform is typeof DESKTOP_MANAGED_POP_SUPPORTED_PLATFORM {
  return platform === DESKTOP_MANAGED_POP_SUPPORTED_PLATFORM;
}

/**
 * Server-side rollout gate for automated Desktop managed-key provisioning.
 * Missing, disabled, or unavailable flag evaluation fails closed.
 */
export async function isDesktopManagedPopProvisioningEnabled(
  identity: DesktopManagedFeatureFlagIdentity,
  platform: string | null | undefined = DESKTOP_MANAGED_POP_SUPPORTED_PLATFORM
): Promise<boolean> {
  if (!isDesktopManagedPopPlatformSupported(platform)) {
    return false;
  }

  try {
    const provisioningEnabled = await isDesktopManagedFeatureFlagEnabled(
      DESKTOP_MANAGED_POP_PROVISIONING_SERVER_FLAG,
      identity
    );
    return (
      provisioningEnabled &&
      (await isDesktopManagedPopEnforcementEnabled(identity))
    );
  } catch {
    return false;
  }
}
