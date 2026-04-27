import type { DesktopProvisioningPlatform } from "@repo/api/src/types/electron";

/**
 * Normalizes browser platform hints into the server-side Desktop provisioning contract.
 */
export function getClientDesktopProvisioningPlatform(
  navigatorLike?: Pick<Navigator, "platform" | "userAgent">
): DesktopProvisioningPlatform {
  const source =
    navigatorLike ?? (typeof navigator === "undefined" ? null : navigator);
  if (!source) {
    return "unknown";
  }

  const platform = source.platform.toLowerCase();
  if (
    platform.includes("ipad") ||
    platform.includes("iphone") ||
    platform.includes("ipod")
  ) {
    return "unknown";
  }
  if (platform.includes("mac")) {
    return "darwin";
  }
  if (platform.includes("linux")) {
    return "linux";
  }
  if (platform.includes("win")) {
    return "win32";
  }
  const userAgent = source.userAgent.toLowerCase();
  if (userAgent.includes("linux")) {
    return "linux";
  }
  if (userAgent.includes("windows")) {
    return "win32";
  }
  return "unknown";
}
