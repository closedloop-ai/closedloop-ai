import {
  DESKTOP_API_NAMESPACE_CAPABILITY_KEY,
  LEGACY_DESKTOP_API_NAMESPACE,
} from "@repo/api/src/desktop-api-namespace";
import { DesktopSecurityStatus } from "@repo/api/src/types/compute-target";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isDesktopManagedPopEnforcementEnabled: vi.fn(),
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  ApiKeySource: {
    DESKTOP_MANAGED: "DESKTOP_MANAGED",
    USER_CREATED: "USER_CREATED",
  },
  withDb: mocks.withDb,
}));

vi.mock("@/lib/auth/desktop-managed-pop", () => ({
  isDesktopManagedPopEnforcementEnabled:
    mocks.isDesktopManagedPopEnforcementEnabled,
}));

import {
  computeTargetsService,
  isComputeTargetGatewayConflictResult,
} from "./service";

const now = new Date("2026-04-28T17:00:00.000Z");

function buildTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: "target-1",
    organizationId: "org-1",
    userId: "user-1",
    machineName: "machine-1",
    platform: "darwin",
    capabilities: { desktopSecurityUpgradeProtocolVersion: 1 },
    supportedOperations: ["symphony_plan_loop"],
    lastSeenAt: now,
    isOnline: true,
    isSharedWithOrg: false,
    gatewayId: "gateway-1",
    createdAt: now,
    updatedAt: now,
    user: null,
    ...overrides,
  };
}

function installDb(db: unknown) {
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );
}

describe("computeTargetsService security status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(true);
  });

  it("computes the full owned/shared Desktop security status matrix", async () => {
    const targets = [
      buildTarget({ id: "protected", gatewayId: "gateway-protected" }),
      buildTarget({ id: "upgrade", gatewayId: "gateway-upgrade" }),
      buildTarget({ id: "missing-gateway", gatewayId: null }),
      buildTarget({
        id: "unsupported",
        gatewayId: "gateway-unsupported",
        capabilities: { desktopSecurityUpgradeProtocolVersion: 99 },
      }),
      buildTarget({
        id: "offline",
        gatewayId: "gateway-offline",
        isOnline: false,
      }),
      buildTarget({
        id: "shared",
        userId: "user-2",
        gatewayId: "gateway-shared",
        isSharedWithOrg: true,
        user: { firstName: "Ada", lastName: "Lovelace" },
      }),
    ];
    const db = {
      computeTarget: {
        findMany: vi.fn().mockResolvedValue(targets),
      },
      apiKey: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ gatewayId: "gateway-protected" }]),
      },
    };
    installDb(db);

    const result = await computeTargetsService.listAvailableForOrg(
      "org-1",
      "user-1",
      "clerk-user-1"
    );
    const byId = new Map(result.map((target) => [target.id, target]));

    expect(mocks.isDesktopManagedPopEnforcementEnabled).toHaveBeenCalledWith({
      userId: "user-1",
      clerkUserId: "clerk-user-1",
    });
    expect(byId.get("protected")?.security).toEqual({
      status: DesktopSecurityStatus.Protected,
      reason: "BOUND_DESKTOP_MANAGED_KEY",
      upgradeSupported: false,
    });
    expect(byId.get("upgrade")?.security).toEqual({
      status: DesktopSecurityStatus.UpgradeAvailable,
      reason: "NO_BOUND_MANAGED_KEY",
      upgradeSupported: true,
    });
    expect(byId.get("missing-gateway")?.security).toEqual({
      status: DesktopSecurityStatus.UpdateRequired,
      reason: "MISSING_GATEWAY_ID",
      upgradeSupported: false,
    });
    expect(byId.get("unsupported")?.security).toEqual({
      status: DesktopSecurityStatus.UpdateRequired,
      reason: "UNSUPPORTED_DESKTOP_VERSION",
      upgradeSupported: false,
    });
    expect(byId.get("offline")?.security).toEqual({
      status: DesktopSecurityStatus.LegacyManual,
      reason: "TARGET_OFFLINE",
      upgradeSupported: false,
    });
    expect(byId.get("shared")?.security).toEqual({
      status: DesktopSecurityStatus.UpdateRequired,
      reason: "SHARED_TARGET",
      upgradeSupported: false,
    });
  });

  it("returns unknown when managed-key lookup fails", async () => {
    installDb({
      computeTarget: {
        findMany: vi.fn().mockResolvedValue([buildTarget()]),
      },
      apiKey: {
        findMany: vi.fn().mockRejectedValue(new Error("db unavailable")),
      },
    });

    const [target] = await computeTargetsService.listAvailableForOrg(
      "org-1",
      "user-1",
      "clerk-user-1"
    );

    expect(target?.security).toEqual({
      status: DesktopSecurityStatus.Unknown,
      reason: "LOOKUP_FAILED",
      upgradeSupported: false,
    });
  });

  it("degrades to legacy manual without key lookup when the rollout flag is disabled", async () => {
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
    const apiKeyFindMany = vi.fn();
    installDb({
      computeTarget: {
        findMany: vi.fn().mockResolvedValue([buildTarget()]),
      },
      apiKey: {
        findMany: apiKeyFindMany,
      },
    });

    const [target] = await computeTargetsService.listAvailableForOrg(
      "org-1",
      "user-1",
      "clerk-user-1"
    );

    expect(apiKeyFindMany).not.toHaveBeenCalled();
    expect(target?.security).toEqual({
      status: DesktopSecurityStatus.LegacyManual,
      reason: "FEATURE_DISABLED",
      upgradeSupported: false,
    });
  });

  it("threads Clerk user ID through owned target lists for rollout targeting", async () => {
    installDb({
      computeTarget: {
        findMany: vi.fn().mockResolvedValue([buildTarget()]),
      },
      apiKey: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    await computeTargetsService.listByOwner("org-1", "user-1", "clerk-user-1");

    expect(mocks.isDesktopManagedPopEnforcementEnabled).toHaveBeenCalledWith({
      userId: "user-1",
      clerkUserId: "clerk-user-1",
    });
  });

  it("merges protocol-only updates into the existing capabilities blob", async () => {
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
    const update = vi.fn().mockResolvedValue(
      buildTarget({
        capabilities: {
          pluginVersion: "0.13.22",
          socketProtocolVersion: 2,
          desktopSecurityUpgradeProtocolVersion: 1,
        },
      })
    );
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({
          capabilities: {
            pluginVersion: "0.13.22",
            socketProtocolVersion: 2,
          },
        }),
        update,
      },
      apiKey: {
        findMany: vi.fn(),
      },
    });

    await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      { desktopSecurityUpgradeProtocolVersion: 1 },
      "clerk-user-1"
    );

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          capabilities: {
            pluginVersion: "0.13.22",
            socketProtocolVersion: 2,
            desktopSecurityUpgradeProtocolVersion: 1,
          },
        }),
      })
    );
  });

  it("clears stale desktop API namespace when current capability payload omits it", async () => {
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
    const update = vi.fn().mockResolvedValue(
      buildTarget({
        capabilities: {
          pluginVersion: "1.11.3",
          socketProtocolVersion: "1",
        },
      })
    );
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({
          capabilities: {
            [DESKTOP_API_NAMESPACE_CAPABILITY_KEY]:
              LEGACY_DESKTOP_API_NAMESPACE,
            pluginVersion: "1.10.0",
          },
        }),
        update,
      },
      apiKey: {
        findMany: vi.fn(),
      },
    });

    await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      {
        capabilities: {
          pluginVersion: "1.11.3",
          socketProtocolVersion: "1",
        },
      },
      "clerk-user-1"
    );

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          capabilities: {
            pluginVersion: "1.11.3",
            socketProtocolVersion: "1",
          },
        }),
      })
    );
  });
});

describe("computeTargetsService gateway reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates the owned target with the same gateway even when the machine name changed", async () => {
    const update = vi.fn().mockResolvedValue(
      buildTarget({
        id: "target-existing",
        machineName: "renamed-machine",
        gatewayId: "gateway-1",
      })
    );
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(buildTarget({ id: "target-existing" }));
    installDb({
      computeTarget: {
        findFirst,
        update,
      },
    });

    await computeTargetsService.register("org-1", "user-1", {
      machineName: "renamed-machine",
      platform: "darwin",
      gatewayId: "gateway-1",
      capabilities: {},
      supportedOperations: ["symphony_plan_loop"],
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "target-existing" },
        data: expect.objectContaining({
          machineName: "renamed-machine",
          isOnline: true,
        }),
      })
    );
  });

  it("attaches a new gateway to an existing owned machine-name target", async () => {
    const update = vi.fn().mockResolvedValue(
      buildTarget({
        id: "machine-target",
        gatewayId: "gateway-1",
      })
    );
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        buildTarget({ id: "machine-target", gatewayId: null })
      );
    installDb({
      computeTarget: {
        findFirst,
        update,
      },
    });

    await computeTargetsService.register("org-1", "user-1", {
      machineName: "machine-1",
      platform: "darwin",
      gatewayId: "gateway-1",
      capabilities: {},
      supportedOperations: ["symphony_plan_loop"],
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "machine-target" },
        data: expect.objectContaining({
          gatewayId: "gateway-1",
          isOnline: true,
        }),
      })
    );
  });

  it("rejects a gateway already bound to another owner before mutating", async () => {
    const update = vi.fn();
    const upsert = vi.fn();
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "conflict" }),
        update,
        upsert,
      },
    });

    const result = await computeTargetsService.register("org-1", "user-1", {
      machineName: "machine-1",
      platform: "darwin",
      gatewayId: "gateway-1",
      capabilities: {},
      supportedOperations: ["symphony_plan_loop"],
    });

    expect(isComputeTargetGatewayConflictResult(result)).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});
