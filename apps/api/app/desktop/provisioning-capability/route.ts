import type { DesktopProvisioningCapability } from "@repo/api/src/types/electron";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  DESKTOP_MANAGED_POP_SUPPORTED_PLATFORM,
  isDesktopManagedPopPlatformSupported,
  isDesktopManagedPopProvisioningEnabled,
} from "@/lib/desktop-managed-pop-provisioning";
import { successResponse } from "@/lib/route-utils";

/**
 * GET /desktop/provisioning-capability
 * Resolves whether the current user may start automated managed Desktop provisioning.
 */
export const GET = withAnyAuth<
  DesktopProvisioningCapability,
  "/desktop/provisioning-capability"
>(async ({ user }, request) => {
  const platform = request.nextUrl.searchParams.get("platform");
  const platformSupported = isDesktopManagedPopPlatformSupported(platform);
  const automatedManagedProvisioningEnabled =
    platformSupported &&
    (await isDesktopManagedPopProvisioningEnabled(
      { userId: user.id, clerkUserId: user.clerkId },
      platform
    ));

  return successResponse({
    automatedManagedProvisioningEnabled,
    supportedPlatform: platformSupported
      ? DESKTOP_MANAGED_POP_SUPPORTED_PLATFORM
      : null,
    ...(platformSupported ? {} : { unsupportedReason: "unsupported_platform" }),
  });
});
