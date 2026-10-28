import { DesktopSecurityStatus } from "@repo/api/src/types/compute-target";
import { ApiKeySource } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTarget,
  installDb,
  now,
  protectedGatewayApiKeyWhere,
} from "@/__tests__/support/compute-targets/service.test-fixtures";

const mocks = vi.hoisted(() => ({
  isDesktopManagedPopEnforcementEnabled: vi.fn(),
  loadActiveDesktopManagedGatewayIds: vi.fn(),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  deleteTranscriptObjects: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  ApiKeySource: {
    DESKTOP_MANAGED: "DESKTOP_MANAGED",
    USER_CREATED: "USER_CREATED",
  },
  withDb: mocks.withDb,
}));

vi.mock("@repo/aws/transcript-storage", () => ({
  deleteTranscriptObjects: mocks.deleteTranscriptObjects,
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/auth/desktop-managed-pop", () => ({
  isDesktopManagedPopEnforcementEnabled:
    mocks.isDesktopManagedPopEnforcementEnabled,
}));

vi.mock("@/lib/compute-target-signing-eligibility", () => ({
  CommandSigningEligibilityStatus: {
    Eligible: "eligible",
    Ineligible: "ineligible",
    Unknown: "unknown",
  },
  loadActiveDesktopManagedGatewayIds: mocks.loadActiveDesktopManagedGatewayIds,
}));

import { computeTargetsService } from "./service";

describe("computeTargetsService updateOwned material-change lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a null result when the material-change lookup finds no owned target", async () => {
    const update = vi.fn();
    const findFirst = vi.fn().mockResolvedValue(null);
    installDb(mocks.withDb, {
      computeTarget: {
        findFirst,
        update,
      },
    });

    const result = await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      { platform: "linux" },
      null
    );

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "target-1", organizationId: "org-1", userId: "user-1" },
      })
    );
    expect(result).toEqual({ ok: true, value: null });
    expect(update).not.toHaveBeenCalled();
    // The null-result short-circuit must actually return early, not merely end
    // up at the same answer by falling through: the security lookup below it
    // would dereference the (now null) updated record.
    expect(mocks.isDesktopManagedPopEnforcementEnabled).not.toHaveBeenCalled();
  });
});

describe("computeTargetsService updateOwned building update data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
  });

  it("passes machineName, platform, gatewayId and supportedOperations through to the Prisma update when reassigning an owned target", async () => {
    const update = vi.fn().mockResolvedValue(
      buildTarget({
        machineName: "new-machine",
        platform: "linux",
        gatewayId: "gateway-new",
        supportedOperations: ["git_action", "other_op"],
      })
    );
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "target-1",
        machineName: "old-machine",
        platform: "darwin",
        capabilities: {},
        supportedOperations: ["git_action"],
        gatewayId: "gateway-old",
      });
    installDb(mocks.withDb, {
      computeTarget: { findFirst, update },
      apiKey: { findMany: vi.fn() },
    });

    await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      {
        machineName: "new-machine",
        platform: "linux",
        gatewayId: "gateway-new",
        supportedOperations: ["git_action", "other_op"],
      },
      null
    );

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "target-1", organizationId: "org-1", userId: "user-1" },
        data: expect.objectContaining({
          machineName: "new-machine",
          platform: "linux",
          gatewayId: "gateway-new",
          supportedOperations: ["git_action", "other_op"],
        }),
      })
    );
  });
});

// Each case below isolates exactly one field of `buildMaterialHealthCheckUpdateFields`
// by setting only that field on the payload, so the health-check-invalidation
// side effect (`deleteMany`) can only fire because of the field under test —
// asserting the final `update()` call args (as the block above does) cannot
// distinguish these, since none of them feed the Prisma `update` write itself.
describe("computeTargetsService updateOwned material-change field comparisons", () => {
  const existingMaterialRecord = {
    id: "target-1",
    machineName: "old-name",
    platform: "darwin",
    capabilities: {},
    supportedOperations: ["op-a"],
    gatewayId: "old-gateway",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
  });

  it("invalidates the health check when only machineName changes", async () => {
    const deleteMany = vi.fn();
    installDb(mocks.withDb, {
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(existingMaterialRecord),
        update: vi.fn().mockResolvedValue(buildTarget()),
      },
      computeTargetHealthCheck: { deleteMany },
    });

    await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      { machineName: "new-name" },
      null
    );

    expect(deleteMany).toHaveBeenCalledWith({
      where: { computeTargetId: "target-1" },
    });
  });

  it("invalidates the health check when only gatewayId changes", async () => {
    const deleteMany = vi.fn();
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null) // no conflicting owner of the new gateway
      .mockResolvedValueOnce(existingMaterialRecord);
    installDb(mocks.withDb, {
      computeTarget: {
        findFirst,
        update: vi.fn().mockResolvedValue(buildTarget()),
      },
      computeTargetHealthCheck: { deleteMany },
    });

    await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      { gatewayId: "new-gateway" },
      null
    );

    expect(deleteMany).toHaveBeenCalledWith({
      where: { computeTargetId: "target-1" },
    });
  });

  it("invalidates the health check when only supportedOperations changes", async () => {
    const deleteMany = vi.fn();
    installDb(mocks.withDb, {
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(existingMaterialRecord),
        update: vi.fn().mockResolvedValue(buildTarget()),
      },
      computeTargetHealthCheck: { deleteMany },
    });

    await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      { supportedOperations: ["op-b"] },
      null
    );

    expect(deleteMany).toHaveBeenCalledWith({
      where: { computeTargetId: "target-1" },
    });
  });

  it("invalidates the health check when only capabilities is set on the payload and the stored capabilities differ", async () => {
    const deleteMany = vi.fn();
    installDb(mocks.withDb, {
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(existingMaterialRecord),
        update: vi
          .fn()
          .mockResolvedValue(buildTarget({ capabilities: { foo: "bar" } })),
      },
      computeTargetHealthCheck: { deleteMany },
    });

    await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      { capabilities: { foo: "bar" } },
      null
    );

    expect(deleteMany).toHaveBeenCalledWith({
      where: { computeTargetId: "target-1" },
    });
  });

  it("invalidates the health check when only desktopSecurityUpgradeProtocolVersion is set on the payload and the stored capabilities differ", async () => {
    const deleteMany = vi.fn();
    installDb(mocks.withDb, {
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(existingMaterialRecord),
        update: vi.fn().mockResolvedValue(
          buildTarget({
            capabilities: { desktopSecurityUpgradeProtocolVersion: 2 },
          })
        ),
      },
      computeTargetHealthCheck: { deleteMany },
    });

    await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      { desktopSecurityUpgradeProtocolVersion: 2 },
      null
    );

    expect(deleteMany).toHaveBeenCalledWith({
      where: { computeTargetId: "target-1" },
    });
  });

  it("does not invalidate the health check for a no-field update payload even when the stored capabilities differ", async () => {
    const deleteMany = vi.fn();
    installDb(mocks.withDb, {
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(existingMaterialRecord),
        update: vi
          .fn()
          .mockResolvedValue(
            buildTarget({ capabilities: { unexpected: true } })
          ),
      },
      computeTargetHealthCheck: { deleteMany },
    });

    await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      {},
      null
    );

    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe("computeTargetsService updateOwned error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a null result when the update races a deleted target (P2025)", async () => {
    const p2025 = Object.assign(new Error("Record not found"), {
      code: "P2025",
    });
    installDb(mocks.withDb, {
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ capabilities: {} }),
        update: vi.fn().mockRejectedValue(p2025),
      },
    });

    const result = await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      { platform: "linux" },
      null
    );

    expect(result).toEqual({ ok: true, value: null });
  });
});

describe("computeTargetsService updateOwned desktop security after a successful update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads protected-gateway state for the updated target when it has a gateway", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const apiKeyFindMany = vi
      .fn()
      .mockResolvedValue([{ gatewayId: "gateway-1" }]);
    installDb(mocks.withDb, {
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ capabilities: {} }),
        update: vi.fn().mockResolvedValue(buildTarget()),
      },
      apiKey: { findMany: apiKeyFindMany },
    });

    const result = await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      { platform: "darwin" },
      "clerk-user-1"
    );

    expect(mocks.isDesktopManagedPopEnforcementEnabled).toHaveBeenCalledWith({
      userId: "user-1",
      clerkUserId: "clerk-user-1",
    });
    // Pins every clause that makes a key a bound Desktop-managed key
    // (organizationId, userId, source, boundPublicKey, usableApiKeyWhere()),
    // not just gatewayId — reducing the real where to gatewayId alone would
    // report Protected for a gateway bound by another org's key or a revoked
    // one (ISS-4905).
    expect(apiKeyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: protectedGatewayApiKeyWhere({
          organizationId: "org-1",
          userId: "user-1",
          source: ApiKeySource.DESKTOP_MANAGED,
          gatewayIds: ["gateway-1"],
          asOf: now,
        }),
      })
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.value?.security).toEqual({
      status: DesktopSecurityStatus.Protected,
      reason: "BOUND_DESKTOP_MANAGED_KEY",
      upgradeSupported: false,
    });
  });

  it("passes no gateway ids to the protected-gateway lookup when the updated target has no gateway", async () => {
    const apiKeyFindMany = vi.fn();
    installDb(mocks.withDb, {
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ capabilities: {} }),
        update: vi.fn().mockResolvedValue(buildTarget({ gatewayId: null })),
      },
      apiKey: { findMany: apiKeyFindMany },
    });

    const result = await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      { platform: "darwin" },
      "clerk-user-1"
    );

    expect(apiKeyFindMany).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.ok && result.value?.security).toEqual({
      status: DesktopSecurityStatus.UpdateRequired,
      reason: "MISSING_GATEWAY_ID",
      upgradeSupported: false,
    });
  });
});
