import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAllFeatureFlagsForAnyIdentity: vi.fn(),
  // ISS-12552: two organizations, one the attribution flag is on for.
  clerkIdByOrganization: new Map<string, string>([
    ["org-on", "clerk-org-on"],
    ["org-off", "clerk-org-off"],
  ]),
  evaluateServerFeatureFlagForOrganization: vi.fn(
    (_flag: unknown, clerkOrganizationId: string): Promise<boolean | null> =>
      Promise.resolve(clerkOrganizationId === "clerk-org-on")
  ),
}));

vi.mock("@/lib/feature-flag-identity", () => ({
  getAllFeatureFlagsForAnyIdentity: mocks.getAllFeatureFlagsForAnyIdentity,
  // The organization gate keys its memo through this, with the organization
  // id carried as `userId`.
  resolveDistinctIdsForIdentity: ({ userId }: { userId: string }) => [userId],
}));
vi.mock("@repo/database", () => ({
  withDb: async (
    fn: (db: {
      organization: {
        findUnique: (args: {
          where: { id: string };
        }) => Promise<{ clerkId: string } | null>;
      };
    }) => unknown
  ) =>
    await fn({
      organization: {
        findUnique: ({ where }) => {
          const clerkId = mocks.clerkIdByOrganization.get(where.id);
          return Promise.resolve(clerkId ? { clerkId } : null);
        },
      },
    }),
}));
vi.mock("@/lib/feature-flags/feature-flag-request-scope", () => ({
  currentFeatureFlagRequestScope: () => undefined,
}));
vi.mock("@/lib/feature-flags/server-feature-flag-evaluation", () => ({
  evaluateServerFeatureFlagForOrganization:
    mocks.evaluateServerFeatureFlagForOrganization,
  evaluateServerFeatureFlagForDistinctId: vi.fn(),
  resolveUnmemoizedFeatureFlagValue: () => Promise.resolve(undefined),
}));

import { ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY } from "@repo/api/src/types/attribution-evidence-policy-flag";
import { clearAttributionEvidenceGateMemo } from "@/lib/attribution-evidence-policy-feature";
import { desktopFeatureFlagsService } from "./service";

const IDENTITY = {
  userId: "user-1",
  clerkUserId: "clerk-user-1",
  organizationId: "org-off",
};

describe("desktopFeatureFlagsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAttributionEvidenceGateMemo();
  });

  it("reports an evaluated assignment as resolved, verbatim", async () => {
    mocks.getAllFeatureFlagsForAnyIdentity.mockResolvedValue({
      "agents-nav": true,
      "branches-cohort-transparency": false,
    });

    await expect(desktopFeatureFlagsService.get(IDENTITY)).resolves.toEqual({
      userId: "user-1",
      resolved: true,
      flags: {
        "agents-nav": true,
        "branches-cohort-transparency": false,
        [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY]: false,
      },
      organizationEvaluated: [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY],
    });
  });

  it("reports an EMPTY evaluated assignment as resolved — no open gates is an answer", async () => {
    mocks.getAllFeatureFlagsForAnyIdentity.mockResolvedValue({});

    await expect(desktopFeatureFlagsService.get(IDENTITY)).resolves.toEqual({
      userId: "user-1",
      resolved: true,
      flags: { [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY]: false },
      organizationEvaluated: [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY],
    });
  });

  it("reports UNAVAILABLE as resolved:false, distinct from the empty assignment above", async () => {
    mocks.getAllFeatureFlagsForAnyIdentity.mockResolvedValue(null);

    await expect(desktopFeatureFlagsService.get(IDENTITY)).resolves.toEqual({
      userId: "user-1",
      resolved: false,
      flags: {},
    });
  });

  it("evaluates through the canonical multi-identity resolver, not a re-derived id", async () => {
    mocks.getAllFeatureFlagsForAnyIdentity.mockResolvedValue({});

    await desktopFeatureFlagsService.get(IDENTITY);

    expect(mocks.getAllFeatureFlagsForAnyIdentity).toHaveBeenCalledWith(
      { userId: "user-1", clerkUserId: "clerk-user-1" },
      expect.any(String)
    );
  });

  it("answers the attribution flag from each account's organization (ISS-12552)", async () => {
    // PostHog evaluates the group flag per person as off for everyone.
    mocks.getAllFeatureFlagsForAnyIdentity.mockResolvedValue({
      [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY]: false,
    });

    const onAccount = await desktopFeatureFlagsService.get({
      ...IDENTITY,
      userId: "user-on",
      organizationId: "org-on",
    });
    const offAccount = await desktopFeatureFlagsService.get({
      ...IDENTITY,
      userId: "user-off",
      organizationId: "org-off",
    });

    expect(onAccount.flags[ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY]).toBe(true);
    expect(offAccount.flags[ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY]).toBe(false);
    expect(onAccount.organizationEvaluated).toEqual([
      ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY,
    ]);
    expect(offAccount.organizationEvaluated).toEqual([
      ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY,
    ]);
  });

  it("omits the attribution flag when the organization's answer is unavailable", async () => {
    mocks.getAllFeatureFlagsForAnyIdentity.mockResolvedValue({
      "agents-nav": true,
      [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY]: false,
    });
    mocks.evaluateServerFeatureFlagForOrganization.mockResolvedValueOnce(null);

    await expect(
      desktopFeatureFlagsService.get({ ...IDENTITY, organizationId: "org-on" })
    ).resolves.toEqual({
      userId: "user-1",
      resolved: true,
      flags: { "agents-nav": true },
    });
  });
});
