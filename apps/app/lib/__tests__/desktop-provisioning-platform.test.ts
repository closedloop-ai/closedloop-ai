import { describe, expect, it } from "vitest";
import { getClientDesktopProvisioningPlatform } from "../desktop-provisioning-platform";

describe("getClientDesktopProvisioningPlatform", () => {
  it("normalizes macOS, Linux, Windows, and unknown browser hints", () => {
    expect(
      getClientDesktopProvisioningPlatform({
        platform: "MacIntel",
        userAgent: "Mozilla/5.0",
      })
    ).toBe("darwin");
    expect(
      getClientDesktopProvisioningPlatform({
        platform: "Linux x86_64",
        userAgent: "Mozilla/5.0",
      })
    ).toBe("linux");
    expect(
      getClientDesktopProvisioningPlatform({
        platform: "Win32",
        userAgent: "Mozilla/5.0",
      })
    ).toBe("win32");
    expect(
      getClientDesktopProvisioningPlatform({
        platform: "",
        userAgent: "Mozilla/5.0",
      })
    ).toBe("unknown");
  });

  it("does not classify iPad or iPhone user agents as macOS", () => {
    expect(
      getClientDesktopProvisioningPlatform({
        platform: "iPad",
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      })
    ).toBe("unknown");
    expect(
      getClientDesktopProvisioningPlatform({
        platform: "iPhone",
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      })
    ).toBe("unknown");
  });
});
