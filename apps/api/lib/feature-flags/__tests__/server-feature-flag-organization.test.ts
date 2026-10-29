/**
 * PLN-2187 T-2.6: an organization's flag read goes to PostHog for the org's
 * `company` group alone, keyed by its Clerk id, so a percentage rollout splits
 * by org and never by person (marisolashgrove, #8828).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { isFeatureFlagEnabledForGroup } = vi.hoisted(() => ({
  isFeatureFlagEnabledForGroup: vi.fn(),
}));

vi.mock("@repo/analytics/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/analytics/feature-flags")>()),
  isFeatureFlagEnabledForGroup,
}));

import { evaluateServerFeatureFlagForOrganization } from "../server-feature-flag-evaluation";
import { DOCUMENT_UNIFIED_COMMENTS_SERVER_FLAG } from "../server-feature-flags";

describe("evaluateServerFeatureFlagForOrganization", () => {
  beforeEach(() => {
    isFeatureFlagEnabledForGroup.mockResolvedValue(null);
  });

  it("asks for the org's company group, keyed by its Clerk id", async () => {
    isFeatureFlagEnabledForGroup.mockResolvedValue(true);

    await expect(
      evaluateServerFeatureFlagForOrganization(
        DOCUMENT_UNIFIED_COMMENTS_SERVER_FLAG,
        "org_clerk_1"
      )
    ).resolves.toBe(true);
    expect(isFeatureFlagEnabledForGroup).toHaveBeenCalledWith(
      DOCUMENT_UNIFIED_COMMENTS_SERVER_FLAG.key,
      { type: "company", key: "org_clerk_1" }
    );
  });

  it("passes an unanswered lookup through as null", async () => {
    await expect(
      evaluateServerFeatureFlagForOrganization(
        DOCUMENT_UNIFIED_COMMENTS_SERVER_FLAG,
        "org_clerk_1"
      )
    ).resolves.toBeNull();
  });
});
