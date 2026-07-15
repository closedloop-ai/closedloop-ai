import { isFeatureFlagEnabledForDistinctId } from "@repo/analytics/feature-flags";
import { PUBLIC_GITHUB_REPOS_FEATURE_FLAG_KEY } from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPublicGithubReposEnabled } from "./public-github-repos-feature";

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
  },
}));

describe("isPublicGithubReposEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the exact public GitHub repos flag key", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockResolvedValue(true);

    await expect(
      isPublicGithubReposEnabled({ userId: "user-1" })
    ).resolves.toBe(true);

    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      PUBLIC_GITHUB_REPOS_FEATURE_FLAG_KEY,
      "user-1"
    );
    expect(PUBLIC_GITHUB_REPOS_FEATURE_FLAG_KEY).toBe("public-github-repos");
  });

  it("prefers the clerk distinct id and dedupes identities", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockResolvedValue(false);

    await expect(
      isPublicGithubReposEnabled({ clerkUserId: "clerk-1", userId: "clerk-1" })
    ).resolves.toBe(false);

    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledTimes(1);
    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      PUBLIC_GITHUB_REPOS_FEATURE_FLAG_KEY,
      "clerk-1"
    );
  });

  it.each([
    ["false", false],
    ["null", null],
  ])("fails closed when the feature provider returns %s", async (_label, value) => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockResolvedValue(value);

    await expect(
      isPublicGithubReposEnabled({ userId: "user-1" })
    ).resolves.toBe(false);
  });

  it("fails closed when feature evaluation throws", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockRejectedValue(
      new Error("PostHog unavailable")
    );

    await expect(
      isPublicGithubReposEnabled({ userId: "user-1" })
    ).resolves.toBe(false);
  });
});
