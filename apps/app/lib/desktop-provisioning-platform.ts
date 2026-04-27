import { DesktopProvisioningPlatform } from "@repo/api/src/types/electron";

/**
 * Normalizes browser platform hints into the server-side Desktop provisioning contract.
 */
export function getClientDesktopProvisioningPlatform(
  navigatorLike?: Pick<Navigator, "platform" | "userAgent">
): DesktopProvisioningPlatform {
  const source =
    navigatorLike ?? (typeof navigator === "undefined" ? null : navigator);
  if (!source) {
    return DesktopProvisioningPlatform.Unknown;
  }

  const platform = source.platform.toLowerCase();
  if (
    platform.includes("ipad") ||
    platform.includes("iphone") ||
    platform.includes("ipod")
  ) {
    return DesktopProvisioningPlatform.Unknown;
  }
  if (platform.includes("mac")) {
    return DesktopProvisioningPlatform.Darwin;
  }
  if (platform.includes("linux")) {
    return DesktopProvisioningPlatform.Linux;
  }
  if (platform.includes("win")) {
    return DesktopProvisioningPlatform.Win32;
  }
  const userAgent = source.userAgent.toLowerCase();
  if (userAgent.includes("linux")) {
    return DesktopProvisioningPlatform.Linux;
  }
  if (userAgent.includes("windows")) {
    return DesktopProvisioningPlatform.Win32;
  }
  return DesktopProvisioningPlatform.Unknown;
}
