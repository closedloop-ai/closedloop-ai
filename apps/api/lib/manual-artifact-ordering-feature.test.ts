import { beforeEach, describe, expect, it, vi } from "vitest";

const isFeatureFlagEnabledForAnyIdentity = vi.hoisted(() => vi.fn());

vi.mock("@/lib/feature-flag-identity", () => ({
  isFeatureFlagEnabledForAnyIdentity,
}));

import { MANUAL_ARTIFACT_ORDERING_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";
import { withProjectArtifactPlacementGate } from "./manual-artifact-ordering-feature";

const auth = {
  user: { id: "user-1" },
  clerkUserId: "clerk-1",
} as Parameters<typeof withProjectArtifactPlacementGate>[0];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("project artifact placement feature gate", () => {
  it.each([
    [false, false],
    [true, true],
  ])(
    "admits placement when manual ordering is %s",
    async (manual, expected) => {
      isFeatureFlagEnabledForAnyIdentity.mockResolvedValue(manual);

      const onEnabled = vi.fn(() => "enabled");
      const onDisabled = vi.fn(() => "disabled");

      await expect(
        withProjectArtifactPlacementGate(auth, onEnabled, onDisabled)
      ).resolves.toBe(expected ? "enabled" : "disabled");
      expect(onEnabled).toHaveBeenCalledTimes(expected ? 1 : 0);
      expect(onDisabled).toHaveBeenCalledTimes(expected ? 0 : 1);
      expect(isFeatureFlagEnabledForAnyIdentity).toHaveBeenCalledOnce();
      expect(isFeatureFlagEnabledForAnyIdentity).toHaveBeenCalledWith(
        MANUAL_ARTIFACT_ORDERING_SERVER_FLAG,
        { userId: "user-1", clerkUserId: "clerk-1" },
        "manual_artifact_ordering_feature_flag_unavailable"
      );
    }
  );
});
