import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("./server");
});

describe("isFeatureFlagEnabledForDistinctId", () => {
  it("uses the Next server analytics client and only accepts exact true", async () => {
    const isFeatureEnabled = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    vi.doMock("./server", () => ({ analytics: { isFeatureEnabled } }));
    const { isFeatureFlagEnabledForDistinctId } = await import(
      "./feature-flags"
    );

    await expect(
      isFeatureFlagEnabledForDistinctId("enabled-flag", "user-1")
    ).resolves.toBe(true);
    await expect(
      isFeatureFlagEnabledForDistinctId("disabled-flag", "user-1")
    ).resolves.toBe(false);
    expect(isFeatureEnabled).toHaveBeenNthCalledWith(
      1,
      "enabled-flag",
      "user-1"
    );
  });

  it("returns null when the available analytics client cannot evaluate flags", async () => {
    vi.doMock("./server", () => ({ analytics: {} }));
    const { isFeatureFlagEnabledForDistinctId } = await import(
      "./feature-flags"
    );

    await expect(
      isFeatureFlagEnabledForDistinctId("flag", "user-1")
    ).resolves.toBeNull();
  });
});
