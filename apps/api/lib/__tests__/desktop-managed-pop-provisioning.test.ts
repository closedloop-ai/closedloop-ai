import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockIsFeatureEnabled } = vi.hoisted(() => ({
  mockIsFeatureEnabled: vi.fn(),
}));

vi.mock("@repo/analytics/server", () => ({
  analytics: {
    isFeatureEnabled: mockIsFeatureEnabled,
  },
}));

import {
  DESKTOP_MANAGED_POP_PROVISIONING_FLAG,
  isDesktopManagedPopPlatformSupported,
  isDesktopManagedPopProvisioningEnabled,
} from "../desktop-managed-pop-provisioning";

describe("isDesktopManagedPopProvisioningEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true only when the server feature flag is enabled", async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);

    await expect(
      isDesktopManagedPopProvisioningEnabled("user-1")
    ).resolves.toBe(true);
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      DESKTOP_MANAGED_POP_PROVISIONING_FLAG,
      "user-1"
    );
  });

  it("fails closed when the flag is false, missing, or unavailable", async () => {
    mockIsFeatureEnabled.mockResolvedValueOnce(false);
    await expect(
      isDesktopManagedPopProvisioningEnabled("user-1")
    ).resolves.toBe(false);

    mockIsFeatureEnabled.mockResolvedValueOnce(undefined);
    await expect(
      isDesktopManagedPopProvisioningEnabled("user-1")
    ).resolves.toBe(false);

    mockIsFeatureEnabled.mockRejectedValueOnce(new Error("posthog down"));
    await expect(
      isDesktopManagedPopProvisioningEnabled("user-1")
    ).resolves.toBe(false);
  });

  it("fails closed before flag evaluation when the platform is unsupported", async () => {
    await expect(
      isDesktopManagedPopProvisioningEnabled("user-1", "linux")
    ).resolves.toBe(false);

    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
    expect(isDesktopManagedPopPlatformSupported("darwin")).toBe(true);
    expect(isDesktopManagedPopPlatformSupported("win32")).toBe(false);
  });
});
