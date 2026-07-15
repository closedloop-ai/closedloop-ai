import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_ENV = { ...process.env };

describe("isMcpFeatureFlagEnabled", () => {
  beforeEach(() => {
    // Empty string is treated as "not configured" by the module's `!POSTHOG_KEY`
    // guard, so the client stays null and evaluation fails closed.
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("fails closed (returns false) when PostHog is not configured", async () => {
    // The module reads NEXT_PUBLIC_POSTHOG_KEY at load, so import after unsetting it.
    const { isMcpFeatureFlagEnabled } = await import("../feature-flags.js");
    await expect(isMcpFeatureFlagEnabled("emergent", "user_1")).resolves.toBe(
      false
    );
  });

  it("exposes the shared emergent flag key", async () => {
    const { EMERGENT_FEATURE_FLAG } = await import("../feature-flags.js");
    expect(EMERGENT_FEATURE_FLAG).toBe("emergent");
  });
});
