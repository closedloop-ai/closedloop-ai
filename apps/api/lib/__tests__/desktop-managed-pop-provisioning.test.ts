import { DesktopProvisioningPlatform } from "@repo/api/src/types/electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockIsFeatureEnabled } = vi.hoisted(() => ({
  mockIsFeatureEnabled: vi.fn(),
}));

vi.mock("@repo/analytics/server", () => ({
  analytics: {
    isFeatureEnabled: mockIsFeatureEnabled,
  },
}));

import { DESKTOP_MANAGED_POP_ENFORCEMENT_FLAG } from "../auth/desktop-managed-pop";
import {
  DESKTOP_MANAGED_POP_PROVISIONING_FLAG,
  isDesktopManagedPopPlatformSupported,
  isDesktopManagedPopProvisioningEnabled,
} from "../desktop-managed-pop-provisioning";

describe("isDesktopManagedPopProvisioningEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true only when provisioning and enforcement flags are enabled", async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);

    await expect(
      isDesktopManagedPopProvisioningEnabled("user-1")
    ).resolves.toBe(true);
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      DESKTOP_MANAGED_POP_PROVISIONING_FLAG,
      "user-1"
    );
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      DESKTOP_MANAGED_POP_ENFORCEMENT_FLAG,
      "user-1"
    );
  });

  it("checks provisioning and enforcement against the Clerk distinct ID first", async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);

    await expect(
      isDesktopManagedPopProvisioningEnabled({
        userId: "user-1",
        clerkUserId: "clerk-user-1",
      })
    ).resolves.toBe(true);

    expect(mockIsFeatureEnabled).toHaveBeenNthCalledWith(
      1,
      DESKTOP_MANAGED_POP_PROVISIONING_FLAG,
      "clerk-user-1"
    );
    expect(mockIsFeatureEnabled).toHaveBeenNthCalledWith(
      2,
      DESKTOP_MANAGED_POP_ENFORCEMENT_FLAG,
      "clerk-user-1"
    );
  });

  it("fails closed when enforcement is disabled", async () => {
    mockIsFeatureEnabled
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      isDesktopManagedPopProvisioningEnabled("user-1")
    ).resolves.toBe(false);
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
      isDesktopManagedPopProvisioningEnabled(
        "user-1",
        DesktopProvisioningPlatform.Linux
      )
    ).resolves.toBe(false);

    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
    expect(
      isDesktopManagedPopPlatformSupported(DesktopProvisioningPlatform.Darwin)
    ).toBe(true);
    expect(
      isDesktopManagedPopPlatformSupported(DesktopProvisioningPlatform.Win32)
    ).toBe(false);
  });
});
