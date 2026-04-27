import { DesktopProvisioningPlatform } from "@repo/api/src/types/electron";
import { describe, expect, it } from "vitest";
import { getClientDesktopProvisioningPlatform } from "../desktop-provisioning-platform";

describe("getClientDesktopProvisioningPlatform", () => {
  it("normalizes macOS, Linux, Windows, and unknown browser hints", () => {
    expect(
      getClientDesktopProvisioningPlatform({
        platform: "MacIntel",
        userAgent: "Mozilla/5.0",
      })
    ).toBe(DesktopProvisioningPlatform.Darwin);
    expect(
      getClientDesktopProvisioningPlatform({
        platform: "Linux x86_64",
        userAgent: "Mozilla/5.0",
      })
    ).toBe(DesktopProvisioningPlatform.Linux);
    expect(
      getClientDesktopProvisioningPlatform({
        platform: "Win32",
        userAgent: "Mozilla/5.0",
      })
    ).toBe(DesktopProvisioningPlatform.Win32);
    expect(
      getClientDesktopProvisioningPlatform({
        platform: "",
        userAgent: "Mozilla/5.0",
      })
    ).toBe(DesktopProvisioningPlatform.Unknown);
  });

  it("does not classify iPad or iPhone user agents as macOS", () => {
    expect(
      getClientDesktopProvisioningPlatform({
        platform: "iPad",
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      })
    ).toBe(DesktopProvisioningPlatform.Unknown);
    expect(
      getClientDesktopProvisioningPlatform({
        platform: "iPhone",
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      })
    ).toBe(DesktopProvisioningPlatform.Unknown);
  });
});
