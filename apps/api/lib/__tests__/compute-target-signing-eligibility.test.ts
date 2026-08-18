import {
  COMMAND_SIGNING_CAPABILITY_KEY,
  COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY,
  COMPUTE_TARGET_SIGNING_FEATURE_FLAG_KEY,
} from "@repo/api/src/types/compute-target";
import { ApiKeySource } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const withDb = vi.fn();
  const isFeatureFlagEnabledForDistinctId = vi.fn();
  const ApiKeySource = {
    USER_CREATED: "USER_CREATED",
    DESKTOP_MANAGED: "DESKTOP_MANAGED",
  } as const;

  return {
    ApiKeySource,
    isFeatureFlagEnabledForDistinctId,
    withDb,
  };
});

vi.mock("@repo/database", () => ({
  ApiKeySource: mocks.ApiKeySource,
  withDb: mocks.withDb,
}));

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId: mocks.isFeatureFlagEnabledForDistinctId,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
  },
}));

import {
  COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_REASON,
  CommandSigningEligibilityStatus,
  CommandSigningRequirementStatus,
  isComputeTargetSigningEligible,
  isDirectDesktopAuthSigningEligible,
  loadActiveDesktopManagedGatewayIds,
  resolveCommandSigningRequirement,
} from "../compute-target-signing-eligibility";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const CLERK_USER_ID = "clerk-1";
const GATEWAY_ID = "gateway-1";
const BOUND_PUBLIC_KEY = "public-key-1";

type MockDb = {
  user: { findUnique: ReturnType<typeof vi.fn> };
  apiKey: { findMany: ReturnType<typeof vi.fn> };
};

function installDb({
  owner = { active: true, organization: { active: true } },
  keys = [{ gatewayId: GATEWAY_ID }],
}: {
  owner?: { active: boolean; organization: { active: boolean } | null } | null;
  keys?: Array<{ gatewayId: string | null }>;
} = {}): MockDb {
  const db: MockDb = {
    user: {
      findUnique: vi.fn().mockResolvedValue(owner),
    },
    apiKey: {
      findMany: vi.fn().mockResolvedValue(keys),
    },
  };
  mocks.withDb.mockImplementation((callback: (db: MockDb) => unknown) =>
    callback(db)
  );
  return db;
}

function enableFeatureForExactFlag() {
  mocks.isFeatureFlagEnabledForDistinctId.mockImplementation(
    async (key: string) => key === COMPUTE_TARGET_SIGNING_FEATURE_FLAG_KEY
  );
}

function expectedUnknownResult() {
  return {
    status: CommandSigningEligibilityStatus.Unknown,
    reason: COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_REASON,
  };
}

describe("compute target signing eligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enableFeatureForExactFlag();
    installDb();
  });

  it("loads active desktop-managed gateway IDs with the full persisted-row predicate", async () => {
    const db = installDb({
      keys: [{ gatewayId: GATEWAY_ID }, { gatewayId: "gateway-2" }],
    });

    const result = await loadActiveDesktopManagedGatewayIds({
      organizationId: ORG_ID,
      userId: USER_ID,
      clerkUserId: CLERK_USER_ID,
      gatewayIds: [GATEWAY_ID, "gateway-2", GATEWAY_ID, ""],
    });

    expect(result.status).toBe(CommandSigningEligibilityStatus.Eligible);
    expect(result.gatewayIds).toEqual(new Set([GATEWAY_ID, "gateway-2"]));
    expect(mocks.isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      COMPUTE_TARGET_SIGNING_FEATURE_FLAG_KEY,
      CLERK_USER_ID
    );
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: {
        id: USER_ID,
        organizationId: ORG_ID,
      },
      select: {
        active: true,
        organization: { select: { active: true } },
      },
    });
    expect(db.apiKey.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG_ID,
        userId: USER_ID,
        source: ApiKeySource.DESKTOP_MANAGED,
        revokedAt: null,
        gatewayId: { in: [GATEWAY_ID, "gateway-2"] },
        boundPublicKey: { not: null },
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        scopes: { has: "write" },
      },
      select: { gatewayId: true },
    });
  });

  it("returns eligible for a target backed by an active managed write key", async () => {
    await expect(
      isComputeTargetSigningEligible({
        organizationId: ORG_ID,
        userId: USER_ID,
        clerkUserId: CLERK_USER_ID,
        gatewayId: GATEWAY_ID,
      })
    ).resolves.toEqual({
      status: CommandSigningEligibilityStatus.Eligible,
    });
  });

  it("returns ineligible before lookup when the target gateway is missing", async () => {
    await expect(
      isComputeTargetSigningEligible({
        organizationId: ORG_ID,
        userId: USER_ID,
        clerkUserId: CLERK_USER_ID,
        gatewayId: null,
      })
    ).resolves.toEqual({
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: "missing_gateway",
    });

    expect(mocks.withDb).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "feature disabled",
      arrange: () =>
        mocks.isFeatureFlagEnabledForDistinctId.mockResolvedValue(false),
      expectedReason: "feature_disabled",
    },
    {
      name: "owner not found",
      arrange: () => installDb({ owner: null }),
      expectedReason: "owner_not_found",
    },
    {
      name: "inactive user",
      arrange: () =>
        installDb({ owner: { active: false, organization: { active: true } } }),
      expectedReason: "inactive_user",
    },
    {
      name: "inactive organization",
      arrange: () =>
        installDb({ owner: { active: true, organization: { active: false } } }),
      expectedReason: "inactive_organization",
    },
    {
      name: "no desktop-managed key returned",
      arrange: () => installDb({ keys: [] }),
      expectedReason: "no_active_managed_key",
    },
    {
      name: "returned key does not match the requested gateway",
      arrange: () => installDb({ keys: [{ gatewayId: "gateway-other" }] }),
      expectedReason: "no_active_managed_key",
    },
  ])("returns ineligible for $name", async ({ arrange, expectedReason }) => {
    arrange();

    await expect(
      isComputeTargetSigningEligible({
        organizationId: ORG_ID,
        userId: USER_ID,
        clerkUserId: CLERK_USER_ID,
        gatewayId: GATEWAY_ID,
      })
    ).resolves.toEqual({
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: expectedReason,
    });
  });

  it("returns unknown when feature support cannot be verified", async () => {
    mocks.isFeatureFlagEnabledForDistinctId.mockRejectedValue(
      new Error("feature flag unavailable")
    );

    const result = await isComputeTargetSigningEligible({
      organizationId: ORG_ID,
      userId: USER_ID,
      clerkUserId: CLERK_USER_ID,
      gatewayId: GATEWAY_ID,
    });

    expect(result).toEqual(expectedUnknownResult());
    expect(mocks.withDb).not.toHaveBeenCalled();
  });

  it("returns unknown when owner lookup fails", async () => {
    const db = installDb();
    db.user.findUnique.mockRejectedValue(new Error("db unavailable"));

    const result = await isComputeTargetSigningEligible({
      organizationId: ORG_ID,
      userId: USER_ID,
      clerkUserId: CLERK_USER_ID,
      gatewayId: GATEWAY_ID,
    });

    expect(result).toEqual(expectedUnknownResult());
  });

  it("returns unknown when managed-key lookup fails", async () => {
    const db = installDb();
    db.apiKey.findMany.mockRejectedValue(new Error("db unavailable"));

    const result = await isComputeTargetSigningEligible({
      organizationId: ORG_ID,
      userId: USER_ID,
      clerkUserId: CLERK_USER_ID,
      gatewayId: GATEWAY_ID,
    });

    expect(result).toEqual(expectedUnknownResult());
  });

  it("loads no keys but keeps list projection eligible when no gateways are supplied", async () => {
    const db = installDb();

    const result = await loadActiveDesktopManagedGatewayIds({
      organizationId: ORG_ID,
      userId: USER_ID,
      clerkUserId: CLERK_USER_ID,
      gatewayIds: [],
    });

    expect(result).toEqual({
      status: CommandSigningEligibilityStatus.Eligible,
      gatewayIds: new Set(),
    });
    expect(db.apiKey.findMany).not.toHaveBeenCalled();
  });

  it("accepts direct desktop auth only for managed, bound, gateway-matched keys", async () => {
    await expect(
      isDirectDesktopAuthSigningEligible({
        organizationId: ORG_ID,
        userId: USER_ID,
        clerkUserId: CLERK_USER_ID,
        apiKeySource: ApiKeySource.DESKTOP_MANAGED,
        apiKeyGatewayId: GATEWAY_ID,
        apiKeyBoundPublicKey: BOUND_PUBLIC_KEY,
        targetGatewayId: GATEWAY_ID,
      })
    ).resolves.toEqual({
      status: CommandSigningEligibilityStatus.Eligible,
    });
  });

  it.each([
    {
      name: "missing target gateway",
      overrides: { targetGatewayId: null },
      expectedReason: "missing_gateway",
    },
    {
      name: "user-created key source",
      overrides: { apiKeySource: ApiKeySource.USER_CREATED },
      expectedReason: "no_active_managed_key",
    },
    {
      name: "missing bound public key",
      overrides: { apiKeyBoundPublicKey: null },
      expectedReason: "no_active_managed_key",
    },
    {
      name: "gateway mismatch",
      overrides: { apiKeyGatewayId: "gateway-other" },
      expectedReason: "no_active_managed_key",
    },
  ])("rejects direct desktop auth for $name", async ({
    overrides,
    expectedReason,
  }) => {
    await expect(
      isDirectDesktopAuthSigningEligible({
        organizationId: ORG_ID,
        userId: USER_ID,
        clerkUserId: CLERK_USER_ID,
        apiKeySource: ApiKeySource.DESKTOP_MANAGED,
        apiKeyGatewayId: GATEWAY_ID,
        apiKeyBoundPublicKey: BOUND_PUBLIC_KEY,
        targetGatewayId: GATEWAY_ID,
        ...overrides,
      })
    ).resolves.toEqual({
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: expectedReason,
    });
  });

  it("rejects direct desktop auth when the owning organization is inactive", async () => {
    installDb({ owner: { active: true, organization: { active: false } } });

    await expect(
      isDirectDesktopAuthSigningEligible({
        organizationId: ORG_ID,
        userId: USER_ID,
        clerkUserId: CLERK_USER_ID,
        apiKeySource: ApiKeySource.DESKTOP_MANAGED,
        apiKeyGatewayId: GATEWAY_ID,
        apiKeyBoundPublicKey: BOUND_PUBLIC_KEY,
        targetGatewayId: GATEWAY_ID,
      })
    ).resolves.toEqual({
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: "inactive_organization",
    });
  });

  it("returns unknown for direct desktop auth when owner lookup fails", async () => {
    const db = installDb();
    db.user.findUnique.mockRejectedValue(new Error("db unavailable"));

    const result = await isDirectDesktopAuthSigningEligible({
      organizationId: ORG_ID,
      userId: USER_ID,
      clerkUserId: CLERK_USER_ID,
      apiKeySource: ApiKeySource.DESKTOP_MANAGED,
      apiKeyGatewayId: GATEWAY_ID,
      apiKeyBoundPublicKey: BOUND_PUBLIC_KEY,
      targetGatewayId: GATEWAY_ID,
    });

    expect(result).toEqual(expectedUnknownResult());
  });

  describe("resolveCommandSigningRequirement (shared by the commands route + member-pack dispatch)", () => {
    const ENFORCING_CAPABILITIES = {
      [COMMAND_SIGNING_CAPABILITY_KEY]: true,
      [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]: true,
    } as const;

    it("returns NotRequired without any eligibility lookup when the node does not advertise enforcement", async () => {
      const db = installDb();

      const result = await resolveCommandSigningRequirement({
        capabilities: { [COMMAND_SIGNING_CAPABILITY_KEY]: true },
        organizationId: ORG_ID,
        targetUserId: USER_ID,
        targetGatewayId: GATEWAY_ID,
        requesterUserId: USER_ID,
        requesterClerkUserId: CLERK_USER_ID,
      });

      expect(result).toEqual({
        status: CommandSigningRequirementStatus.NotRequired,
      });
      // No eligibility work when enforcement is not even advertised.
      expect(db.user.findUnique).not.toHaveBeenCalled();
    });

    it("returns Required when the node enforces and the owner is eligible", async () => {
      installDb({ keys: [{ gatewayId: GATEWAY_ID }] });

      const result = await resolveCommandSigningRequirement({
        capabilities: ENFORCING_CAPABILITIES,
        organizationId: ORG_ID,
        targetUserId: USER_ID,
        targetGatewayId: GATEWAY_ID,
        requesterUserId: USER_ID,
        requesterClerkUserId: CLERK_USER_ID,
      });

      expect(result).toEqual({
        status: CommandSigningRequirementStatus.Required,
      });
    });

    it("returns NotRequired when the node enforces but the owner has no active managed key (Ineligible)", async () => {
      installDb({ keys: [] });

      const result = await resolveCommandSigningRequirement({
        capabilities: ENFORCING_CAPABILITIES,
        organizationId: ORG_ID,
        targetUserId: USER_ID,
        targetGatewayId: GATEWAY_ID,
        requesterUserId: USER_ID,
        requesterClerkUserId: CLERK_USER_ID,
      });

      expect(result).toEqual({
        status: CommandSigningRequirementStatus.NotRequired,
      });
    });

    it("returns Unknown when enforcement is advertised but eligibility cannot be verified", async () => {
      const db = installDb();
      db.user.findUnique.mockRejectedValue(new Error("db unavailable"));

      const result = await resolveCommandSigningRequirement({
        capabilities: ENFORCING_CAPABILITIES,
        organizationId: ORG_ID,
        targetUserId: USER_ID,
        targetGatewayId: GATEWAY_ID,
        requesterUserId: USER_ID,
        requesterClerkUserId: CLERK_USER_ID,
      });

      expect(result).toEqual({
        status: CommandSigningRequirementStatus.Unknown,
      });
    });

    it("returns Unknown when the target has no gateway (missing_gateway is Ineligible, but the resolver only collapses Eligible/Ineligible — missing gateway maps to NotRequired)", async () => {
      installDb();

      const result = await resolveCommandSigningRequirement({
        capabilities: ENFORCING_CAPABILITIES,
        organizationId: ORG_ID,
        targetUserId: USER_ID,
        targetGatewayId: null,
        requesterUserId: USER_ID,
        requesterClerkUserId: CLERK_USER_ID,
      });

      // missing_gateway is an Ineligible eligibility result → NotRequired.
      expect(result).toEqual({
        status: CommandSigningRequirementStatus.NotRequired,
      });
    });

    it("resolves eligibility against the TARGET OWNER identity (not the requester) for a shared target, using the owner clerk id and target gateway id", async () => {
      const findUnique = vi.fn().mockResolvedValue({
        active: true,
        organization: { active: true },
      });
      const findMany = vi
        .fn()
        .mockResolvedValue([{ gatewayId: "gateway-owner" }]);
      mocks.withDb.mockImplementation((callback: (db: MockDb) => unknown) =>
        callback({
          user: { findUnique },
          apiKey: { findMany },
        })
      );

      const result = await resolveCommandSigningRequirement({
        capabilities: ENFORCING_CAPABILITIES,
        organizationId: ORG_ID,
        targetUserId: "owner-1",
        targetGatewayId: "gateway-owner",
        requesterUserId: "viewer-1",
        requesterClerkUserId: "clerk-viewer",
        targetOwnerClerkUserId: "clerk-owner",
      });

      expect(result).toEqual({
        status: CommandSigningRequirementStatus.Required,
      });
      // Owner state was looked up by the OWNER id + org, not the requester.
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: "owner-1", organizationId: ORG_ID },
        select: {
          active: true,
          organization: { select: { active: true } },
        },
      });
      // The managed-key lookup was scoped to the owner + target gateway.
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: ORG_ID,
            userId: "owner-1",
            gatewayId: { in: ["gateway-owner"] },
          }),
        })
      );
    });

    it("uses the requester clerk id only when the requester IS the target owner", async () => {
      installDb({ keys: [{ gatewayId: GATEWAY_ID }] });

      const result = await resolveCommandSigningRequirement({
        capabilities: ENFORCING_CAPABILITIES,
        organizationId: ORG_ID,
        targetUserId: USER_ID,
        targetGatewayId: GATEWAY_ID,
        requesterUserId: USER_ID,
        requesterClerkUserId: CLERK_USER_ID,
        // A different owner clerk id must be ignored when requester === owner.
        targetOwnerClerkUserId: "clerk-should-not-be-used",
      });

      expect(result).toEqual({
        status: CommandSigningRequirementStatus.Required,
      });
      expect(mocks.isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
        COMPUTE_TARGET_SIGNING_FEATURE_FLAG_KEY,
        CLERK_USER_ID
      );
    });
  });
});

/**
 * The symbol→literal boundary, pinned once, loudly.
 *
 * Every OTHER test here — and the desktop-gateway socket tests — compares the
 * const against itself (`status === CommandSigningEligibilityStatus.Eligible`)
 * or mocks the module with an `importOriginal` spread. Both FOLLOW whatever the
 * source says, so a typo'd or renamed literal keeps every one of them green
 * while the wire value silently changes. This is the one place that asserts the
 * values themselves, so that failure has somewhere to surface.
 *
 * These strings cross a process boundary: they reach the desktop client through
 * the `desktop.hello.ack` server capabilities, so changing one is a wire-format
 * change, not a rename.
 */
describe("signing status wire values", () => {
  it("pins CommandSigningEligibilityStatus literals", () => {
    expect(CommandSigningEligibilityStatus).toEqual({
      Eligible: "eligible",
      Ineligible: "ineligible",
      Unknown: "unknown",
    });
  });

  it("pins CommandSigningRequirementStatus literals", () => {
    expect(CommandSigningRequirementStatus).toEqual({
      Required: "required",
      NotRequired: "not_required",
      Unknown: "unknown",
    });
  });
});
