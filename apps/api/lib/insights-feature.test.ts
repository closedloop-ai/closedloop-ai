import { isFeatureFlagEnabledForDistinctId } from "@repo/analytics/feature-flags";
import { DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY } from "@repo/api/src/types/agent-session";
import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isInsightsEnabledForUser } from "./insights-feature";

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
  },
}));

describe("isInsightsEnabledForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("admits the exact insights flag key", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockImplementation(
      (flagKey: string) =>
        Promise.resolve(flagKey === INSIGHTS_FEATURE_FLAG_KEY)
    );

    await expect(isInsightsEnabledForUser({ userId: "user-1" })).resolves.toBe(
      true
    );

    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      INSIGHTS_FEATURE_FLAG_KEY,
      "user-1"
    );
    expect(INSIGHTS_FEATURE_FLAG_KEY).toBe("insights");
  });

  it("admits the desktop-agent-session-sync flag so the dashboard's /insights fetches are not 403'd", async () => {
    // Dashboard is gated behind desktop-agent-session-sync, not `insights`,
    // yet its WebInsightsDataSourceProvider fetches the same /insights routes.
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockImplementation(
      (flagKey: string) =>
        Promise.resolve(flagKey === DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY)
    );

    await expect(isInsightsEnabledForUser({ userId: "user-1" })).resolves.toBe(
      true
    );

    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY,
      "user-1"
    );
    expect(DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY).toBe(
      "desktop-agent-session-sync"
    );
  });

  it("denies when neither admitting flag is enabled", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockResolvedValue(false);

    await expect(
      isInsightsEnabledForUser({ clerkUserId: "clerk-1", userId: "user-1" })
    ).resolves.toBe(false);

    // Both flags evaluated against both distinct ids before failing closed.
    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      INSIGHTS_FEATURE_FLAG_KEY,
      "clerk-1"
    );
    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY,
      "clerk-1"
    );
  });

  it("prefers the clerk distinct id and dedupes identities per flag", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockResolvedValue(false);

    await expect(
      isInsightsEnabledForUser({ clerkUserId: "clerk-1", userId: "clerk-1" })
    ).resolves.toBe(false);

    // One deduped distinct id, evaluated once per admitting flag.
    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledTimes(2);
    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      INSIGHTS_FEATURE_FLAG_KEY,
      "clerk-1"
    );
    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY,
      "clerk-1"
    );
  });

  it.each([
    ["false", false],
    ["null", null],
  ])("fails closed when the feature provider returns %s", async (_label, value) => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockResolvedValue(value);

    await expect(isInsightsEnabledForUser({ userId: "user-1" })).resolves.toBe(
      false
    );
  });

  it("fails closed when feature evaluation is unavailable", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockRejectedValue(
      new Error("PostHog unavailable")
    );

    await expect(isInsightsEnabledForUser({ userId: "user-1" })).resolves.toBe(
      false
    );
  });
});
