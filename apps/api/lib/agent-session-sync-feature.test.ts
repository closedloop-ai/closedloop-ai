import { isFeatureFlagEnabledForDistinctId } from "@repo/analytics/feature-flags";
import { DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY } from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAgentSessionSyncSupportedForUser } from "./agent-session-sync-feature";

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
  },
}));

const isEnabled = vi.mocked(isFeatureFlagEnabledForDistinctId);

describe("isAgentSessionSyncSupportedForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed unless the exact desktop session-sync feature flag is enabled", async () => {
    isEnabled.mockImplementation((featureFlag) =>
      Promise.resolve(
        featureFlag === DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY
      )
    );

    await expect(
      isAgentSessionSyncSupportedForUser({
        clerkUserId: "clerk-user-1",
        userId: "user-1",
      })
    ).resolves.toBe(true);

    expect(isEnabled).toHaveBeenCalledWith(
      DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY,
      "clerk-user-1"
    );
  });

  it("tries the stable user id when the Clerk distinct id is not enabled", async () => {
    isEnabled.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(
      isAgentSessionSyncSupportedForUser({
        clerkUserId: "clerk-user-1",
        userId: "user-1",
      })
    ).resolves.toBe(true);

    expect(isEnabled).toHaveBeenNthCalledWith(
      1,
      DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY,
      "clerk-user-1"
    );
    expect(isEnabled).toHaveBeenNthCalledWith(
      2,
      DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY,
      "user-1"
    );
  });

  it("fails closed when the feature provider returns null", async () => {
    isEnabled.mockResolvedValue(null);

    await expect(
      isAgentSessionSyncSupportedForUser({
        clerkUserId: "clerk-user-1",
        userId: "user-1",
      })
    ).resolves.toBe(false);
  });

  it("fails closed when feature evaluation rejects", async () => {
    isEnabled.mockRejectedValue(new Error("PostHog unavailable"));

    await expect(
      isAgentSessionSyncSupportedForUser({
        clerkUserId: "clerk-user-1",
        userId: "user-1",
      })
    ).resolves.toBe(false);
  });
});
