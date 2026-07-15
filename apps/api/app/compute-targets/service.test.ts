import { DESKTOP_API_NAMESPACE_CAPABILITY_KEY } from "@repo/api/src/desktop-api-namespace";
import type {
  HealthCheckResponse,
  McpProviderAvailability,
} from "@repo/api/src/types/compute-target";
import {
  COMMAND_SIGNING_CAPABILITY_KEY,
  COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY,
  DesktopSecurityStatus,
  deriveAvailableHarnesses,
  HarnessType,
  PluginUpdateOutcome,
} from "@repo/api/src/types/compute-target";
import { beforeEach, describe, expect, it, test, vi } from "vitest";
import { hasDesktopCommandSigningEnforcement } from "@/lib/command-signing-enforcement";

const mocks = vi.hoisted(() => ({
  isDesktopManagedPopEnforcementEnabled: vi.fn(),
  loadActiveDesktopManagedGatewayIds: vi.fn(),
  isAgentSessionSyncSupportedForUser: vi.fn(),
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

vi.mock("@repo/aws", () => ({
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

vi.mock("@/lib/agent-session-sync-feature", () => ({
  isAgentSessionSyncSupportedForUser: mocks.isAgentSessionSyncSupportedForUser,
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
  const dbWithDefaults =
    typeof db === "object" && db !== null
      ? {
          computeTargetHealthCheck: { deleteMany: vi.fn() },
          ...db,
        }
      : db;
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
}

describe("computeTargetsService security status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(true);
    mocks.loadActiveDesktopManagedGatewayIds.mockResolvedValue({
      status: "ineligible",
      gatewayIds: new Set<string>(),
      reason: "feature_disabled",
    });
    mocks.isAgentSessionSyncSupportedForUser.mockResolvedValue(false);
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

  it("maps an unknown persisted selectedHarness to claude", async () => {
    installDb({
      computeTarget: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            buildTarget({ selectedHarness: "future-harness" }),
          ]),
      },
      apiKey: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const [target] = await computeTargetsService.listAvailableForOrg(
      "org-1",
      "user-1",
      "clerk-user-1"
    );

    expect(target?.selectedHarness).toBe(HarnessType.Claude);
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

  it("computes target response signing support from each target owner", async () => {
    const targets = [
      buildTarget({
        id: "viewer-target",
        userId: "user-1",
        gatewayId: "gateway-viewer",
        user: { clerkId: "clerk-user-1", firstName: "Viewer", lastName: null },
      }),
      buildTarget({
        id: "shared-target",
        userId: "owner-2",
        gatewayId: "gateway-shared",
        isSharedWithOrg: true,
        user: {
          clerkId: "clerk-owner-2",
          firstName: "Owner",
          lastName: "Two",
        },
      }),
    ];
    mocks.loadActiveDesktopManagedGatewayIds.mockImplementation(
      async (input) =>
        input.userId === "owner-2"
          ? {
              status: "eligible",
              gatewayIds: new Set(["gateway-shared"]),
            }
          : {
              status: "eligible",
              gatewayIds: new Set<string>(),
            }
    );
    mocks.isAgentSessionSyncSupportedForUser.mockImplementation(
      async (identity) => identity.userId === "owner-2"
    );
    installDb({
      computeTarget: {
        findMany: vi.fn().mockResolvedValue(targets),
      },
      apiKey: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await computeTargetsService.listAvailableForOrg(
      "org-1",
      "user-1",
      "clerk-user-1"
    );
    const byId = new Map(result.map((target) => [target.id, target]));

    expect(byId.get("viewer-target")?.serverCapabilities).toBeUndefined();
    expect(byId.get("shared-target")?.serverCapabilities).toEqual({
      computeTargetSigning: true,
      agentSessionSync: true,
    });
    expect(mocks.loadActiveDesktopManagedGatewayIds).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      clerkUserId: "clerk-user-1",
      gatewayIds: ["gateway-viewer"],
    });
    expect(mocks.loadActiveDesktopManagedGatewayIds).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "owner-2",
      clerkUserId: "clerk-owner-2",
      gatewayIds: ["gateway-shared"],
    });
    expect(mocks.isAgentSessionSyncSupportedForUser).toHaveBeenCalledWith({
      userId: "user-1",
      clerkUserId: "clerk-user-1",
    });
    expect(mocks.isAgentSessionSyncSupportedForUser).toHaveBeenCalledWith({
      userId: "owner-2",
      clerkUserId: "clerk-owner-2",
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
    expect(mocks.withDb.tx).toHaveBeenCalledTimes(1);
    expect(mocks.withDb).not.toHaveBeenCalled();
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
            [DESKTOP_API_NAMESPACE_CAPABILITY_KEY]: "engineer", // legacy namespace value — LEGACY_DESKTOP_API_NAMESPACE was deleted in this PR
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
    expect(mocks.withDb.tx).toHaveBeenCalledTimes(1);
    expect(mocks.withDb).not.toHaveBeenCalled();
  });

  it("clears stale command signing enforcement opt-in when current capability payload omits it", async () => {
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
    const update = vi.fn().mockResolvedValue(
      buildTarget({
        capabilities: {
          [COMMAND_SIGNING_CAPABILITY_KEY]: true,
        },
      })
    );
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({
          capabilities: {
            [COMMAND_SIGNING_CAPABILITY_KEY]: true,
            [COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY]: true,
            pluginVersion: "1.11.3",
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
          [COMMAND_SIGNING_CAPABILITY_KEY]: true,
        },
      },
      "clerk-user-1"
    );

    const capabilities = update.mock.calls[0][0].data.capabilities;
    expect(capabilities).toEqual({
      [COMMAND_SIGNING_CAPABILITY_KEY]: true,
      pluginVersion: "1.11.3",
    });
    expect(hasDesktopCommandSigningEnforcement(capabilities)).toBe(false);
    expect(mocks.withDb.tx).toHaveBeenCalledTimes(1);
    expect(mocks.withDb).not.toHaveBeenCalled();
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

  it("rejects a gateway already bound to another owner when updating", async () => {
    const update = vi.fn();
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "conflict" }),
        update,
      },
    });

    const result = await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      { gatewayId: "gateway-taken" },
      null
    );

    expect(isComputeTargetGatewayConflictResult(result)).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(mocks.withDb.tx).toHaveBeenCalledTimes(1);
    expect(mocks.withDb).not.toHaveBeenCalled();
  });

  it("maps a gateway DB unique-constraint violation to a gateway conflict result", async () => {
    const gatewayP2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: "compute_targets_gateway_id_unique_idx" },
    });
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ capabilities: {} });
    installDb({
      computeTarget: {
        findFirst,
        update: vi.fn().mockRejectedValue(gatewayP2002),
      },
    });

    const result = await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      { gatewayId: "gateway-contested" },
      null
    );

    expect(isComputeTargetGatewayConflictResult(result)).toBe(true);
  });

  it("maps a gateway DB unique-constraint violation reported by field array", async () => {
    const gatewayP2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["gatewayId"] },
    });
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ capabilities: {} });
    installDb({
      computeTarget: {
        findFirst,
        update: vi.fn().mockRejectedValue(gatewayP2002),
      },
    });

    const result = await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      { gatewayId: "gateway-contested" },
      null
    );

    expect(isComputeTargetGatewayConflictResult(result)).toBe(true);
  });

  it("maps a gateway DB unique-constraint violation reported by column array", async () => {
    const gatewayP2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["gateway_id"] },
    });
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ capabilities: {} });
    installDb({
      computeTarget: {
        findFirst,
        update: vi.fn().mockRejectedValue(gatewayP2002),
      },
    });

    const result = await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      { gatewayId: "gateway-contested" },
      null
    );

    expect(isComputeTargetGatewayConflictResult(result)).toBe(true);
  });

  it("re-throws a machine-name unique-constraint violation without remapping", async () => {
    const machineNameP2002 = Object.assign(
      new Error("Unique constraint failed"),
      {
        code: "P2002",
        meta: { target: ["userId", "machineName"] },
      }
    );
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ capabilities: {} }),
        update: vi.fn().mockRejectedValue(machineNameP2002),
      },
    });

    await expect(
      computeTargetsService.updateOwned(
        "target-1",
        "org-1",
        "user-1",
        { machineName: "taken-name" },
        null
      )
    ).rejects.toThrow("Unique constraint failed");
  });

  it("maps a gateway DB unique-constraint violation during register to a gateway conflict result", async () => {
    const gatewayP2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: "compute_targets_gateway_id_unique_idx" },
    });
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockRejectedValue(gatewayP2002),
      },
    });

    const result = await computeTargetsService.register("org-1", "user-1", {
      machineName: "machine-1",
      platform: "darwin",
      gatewayId: "019dd545-b11d-444d-9956-0310752e2481",
      capabilities: {},
      supportedOperations: [],
    });

    expect(isComputeTargetGatewayConflictResult(result)).toBe(true);
  });

  it("maps a gateway DB unique-constraint violation during register reported by field array", async () => {
    const gatewayP2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["gatewayId"] },
    });
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockRejectedValue(gatewayP2002),
      },
    });

    const result = await computeTargetsService.register("org-1", "user-1", {
      machineName: "machine-1",
      platform: "darwin",
      gatewayId: "019dd545-b11d-444d-9956-0310752e2481",
      capabilities: {},
      supportedOperations: [],
    });

    expect(isComputeTargetGatewayConflictResult(result)).toBe(true);
  });

  it("maps a gateway DB unique-constraint violation during register reported by column array", async () => {
    const gatewayP2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["gateway_id"] },
    });
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockRejectedValue(gatewayP2002),
      },
    });

    const result = await computeTargetsService.register("org-1", "user-1", {
      machineName: "machine-1",
      platform: "darwin",
      gatewayId: "019dd545-b11d-444d-9956-0310752e2481",
      capabilities: {},
      supportedOperations: [],
    });

    expect(isComputeTargetGatewayConflictResult(result)).toBe(true);
  });

  it("re-throws non-gateway errors from register unchanged", async () => {
    const dbError = new Error("connection refused");
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockRejectedValue(dbError),
      },
    });

    await expect(
      computeTargetsService.register("org-1", "user-1", {
        machineName: "machine-1",
        platform: "darwin",
        gatewayId: "019dd545-b11d-444d-9956-0310752e2481",
        capabilities: {},
        supportedOperations: [],
      })
    ).rejects.toThrow("connection refused");
  });
});

describe("computeTargetsService health-check snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
  });

  it("upserts the latest health-check snapshot for an accessible target", async () => {
    const checkedAt = new Date("2026-05-08T16:00:00.000Z");
    const upsert = vi.fn().mockResolvedValue({
      id: "snapshot-1",
      organizationId: "org-1",
      computeTargetId: "target-1",
      checkedAt,
      expectedMcpUrl: "https://mcp.example.com",
      latestVersion: "1.2.3",
      pluginAutoUpdateEnabled: true,
      result: {
        checks: [
          { id: "git", label: "Git", required: true, passed: true },
          {
            id: "plugin-code",
            label: "Symphony Plugin",
            required: true,
            passed: false,
            enableAttempted: true,
            enableOutcome: PluginUpdateOutcome.Failed,
            enablePluginIds: ["code@closedloop-ai"],
          },
        ],
        allRequiredPassed: false,
      },
      allRequiredPassed: false,
      requiredFailureIds: ["plugin-code"],
      schemaVersion: 1,
      createdAt: checkedAt,
      updatedAt: checkedAt,
    });
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(buildTarget()),
      },
      computeTargetHealthCheck: {
        upsert,
      },
    });

    const snapshot = await computeTargetsService.upsertHealthCheckSnapshot(
      "org-1",
      "user-1",
      "target-1",
      {
        expectedMcpUrl: "https://mcp.example.com",
        latestVersion: "1.2.3",
        pluginAutoUpdateEnabled: true,
        result: {
          checks: [
            { id: "git", label: "Git", required: true, passed: true },
            {
              id: "plugin-code",
              label: "Symphony Plugin",
              required: true,
              passed: false,
              enableAttempted: true,
              enableOutcome: PluginUpdateOutcome.Failed,
              enablePluginIds: ["code@closedloop-ai"],
            },
          ],
          allRequiredPassed: true,
        },
      }
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { computeTargetId: "target-1" },
        create: expect.objectContaining({
          allRequiredPassed: false,
          pluginAutoUpdateEnabled: true,
          requiredFailureIds: ["plugin-code"],
          result: expect.objectContaining({
            checks: [
              { id: "git", label: "Git", required: true, passed: true },
              expect.objectContaining({
                enableAttempted: true,
                enableOutcome: PluginUpdateOutcome.Failed,
                enablePluginIds: ["code@closedloop-ai"],
              }),
            ],
          }),
        }),
        update: expect.objectContaining({
          allRequiredPassed: false,
          pluginAutoUpdateEnabled: true,
          requiredFailureIds: ["plugin-code"],
        }),
      })
    );
    expect(snapshot?.requiredFailureIds).toEqual(["plugin-code"]);
    expect(snapshot?.result.checks[1]).toEqual(
      expect.objectContaining({
        enableOutcome: PluginUpdateOutcome.Failed,
        enablePluginIds: ["code@closedloop-ai"],
      })
    );
    expect(snapshot?.pluginAutoUpdateEnabled).toBe(true);
  });

  it("coerces enabled plugin auto-update snapshots from shared targets to disabled", async () => {
    const checkedAt = new Date("2026-05-08T16:00:00.000Z");
    const upsert = vi.fn().mockResolvedValue({
      id: "snapshot-1",
      organizationId: "org-1",
      computeTargetId: "target-1",
      checkedAt,
      expectedMcpUrl: "https://mcp.example.com",
      latestVersion: "1.2.3",
      pluginAutoUpdateEnabled: false,
      result: {
        checks: [{ id: "git", label: "Git", required: true, passed: true }],
        allRequiredPassed: true,
      },
      allRequiredPassed: true,
      requiredFailureIds: [],
      schemaVersion: 1,
      createdAt: checkedAt,
      updatedAt: checkedAt,
    });
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(
          buildTarget({
            isSharedWithOrg: true,
            userId: "owner-user",
          })
        ),
      },
      computeTargetHealthCheck: {
        upsert,
      },
    });

    const snapshot = await computeTargetsService.upsertHealthCheckSnapshot(
      "org-1",
      "shared-user",
      "target-1",
      {
        latestVersion: "1.2.3",
        pluginAutoUpdateEnabled: true,
        result: {
          checks: [{ id: "git", label: "Git", required: true, passed: true }],
          allRequiredPassed: true,
        },
      }
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          pluginAutoUpdateEnabled: false,
        }),
        update: expect.objectContaining({
          pluginAutoUpdateEnabled: false,
        }),
      })
    );
    expect(snapshot?.pluginAutoUpdateEnabled).toBe(false);
  });

  it("returns null when upserting a snapshot for an inaccessible target", async () => {
    const upsert = vi.fn();
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      computeTargetHealthCheck: {
        upsert,
      },
    });

    const snapshot = await computeTargetsService.upsertHealthCheckSnapshot(
      "org-1",
      "user-1",
      "target-2",
      {
        result: {
          checks: [],
          allRequiredPassed: true,
        },
      }
    );

    expect(snapshot).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("clears a snapshot when owned target metadata changes", async () => {
    const deleteMany = vi.fn();
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(buildTarget()),
        update: vi.fn().mockResolvedValue(
          buildTarget({
            platform: "linux",
          })
        ),
      },
      computeTargetHealthCheck: {
        deleteMany,
      },
      apiKey: {
        findMany: vi.fn(),
      },
    });

    await computeTargetsService.updateOwned(
      "target-1",
      "org-1",
      "user-1",
      { platform: "linux" },
      null
    );

    expect(deleteMany).toHaveBeenCalledWith({
      where: { computeTargetId: "target-1" },
    });
  });

  it("does not clear a snapshot when JSON metadata only changes key order", async () => {
    const deleteMany = vi.fn();
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(
          buildTarget({
            capabilities: {
              config: { beta: true, alpha: "enabled" },
              tools: ["git", { version: "2.54.0", name: "cli" }],
            },
          })
        ),
        update: vi.fn().mockResolvedValue(
          buildTarget({
            capabilities: {
              tools: ["git", { name: "cli", version: "2.54.0" }],
              config: { alpha: "enabled", beta: true },
            },
          })
        ),
      },
      computeTargetHealthCheck: {
        deleteMany,
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
          tools: ["git", { name: "cli", version: "2.54.0" }],
          config: { alpha: "enabled", beta: true },
        },
      },
      null
    );

    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("does not clear a snapshot for heartbeat-only updates", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deleteMany = vi.fn();
    installDb({
      computeTarget: {
        updateMany,
      },
      computeTargetHealthCheck: {
        deleteMany,
      },
    });

    await computeTargetsService.heartbeat("target-1", "org-1", "user-1");

    expect(updateMany).toHaveBeenCalledOnce();
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe("computeTargetsService deleteOwned", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes session transcripts before the compute target", async () => {
    const artifactDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const transcriptFindMany = vi.fn().mockResolvedValue([]);
    const transcriptDeleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const targetDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        deleteMany: targetDeleteMany,
      },
      artifact: {
        deleteMany: artifactDeleteMany,
      },
      sessionTranscript: {
        findMany: transcriptFindMany,
        deleteMany: transcriptDeleteMany,
      },
    });

    const deleted = await computeTargetsService.deleteOwned(
      "target-1",
      "org-1",
      "user-1"
    );

    expect(deleted).toBe(true);
    // The RESTRICT FK on session_transcript.compute_target_id requires the
    // transcript rows to be cleared before the target row (FEA-2807).
    expect(transcriptDeleteMany).toHaveBeenCalledWith({
      where: { computeTargetId: "target-1" },
    });
    expect(transcriptDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      targetDeleteMany.mock.invocationCallOrder[0]
    );
  });

  it("purges the collected transcript objects after the rows are deleted", async () => {
    const transcriptFindMany = vi.fn().mockResolvedValue([
      { objectStorageKey: "transcripts/org-1/a.jsonl" },
      { objectStorageKey: "transcripts/org-1/b.jsonl" },
      // An empty key is filtered out so it never reaches the purge call.
      { objectStorageKey: "" },
    ]);
    const transcriptDeleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const targetDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    mocks.deleteTranscriptObjects.mockResolvedValue(undefined);
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        deleteMany: targetDeleteMany,
      },
      artifact: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      sessionTranscript: {
        findMany: transcriptFindMany,
        deleteMany: transcriptDeleteMany,
      },
    });

    const deleted = await computeTargetsService.deleteOwned(
      "target-1",
      "org-1",
      "user-1"
    );

    expect(deleted).toBe(true);
    // Keys are collected before the rows carrying them are dropped.
    expect(transcriptFindMany).toHaveBeenCalledWith({
      where: { computeTargetId: "target-1" },
      select: { objectStorageKey: true },
    });
    expect(transcriptFindMany.mock.invocationCallOrder[0]).toBeLessThan(
      transcriptDeleteMany.mock.invocationCallOrder[0]
    );
    // The S3 objects are purged with exactly the non-empty collected keys.
    expect(mocks.deleteTranscriptObjects).toHaveBeenCalledTimes(1);
    expect(mocks.deleteTranscriptObjects).toHaveBeenCalledWith([
      "transcripts/org-1/a.jsonl",
      "transcripts/org-1/b.jsonl",
    ]);
  });

  it("does not purge transcript objects when there are none", async () => {
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    const deleted = await computeTargetsService.deleteOwned(
      "target-1",
      "org-1",
      "user-1"
    );

    expect(deleted).toBe(true);
    expect(mocks.deleteTranscriptObjects).not.toHaveBeenCalled();
  });

  it("still reports success and logs the orphaned keys when the object purge fails", async () => {
    mocks.deleteTranscriptObjects.mockRejectedValue(new Error("s3 down"));
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      sessionTranscript: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { objectStorageKey: "transcripts/org-1/a.jsonl" },
          ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });

    const deleted = await computeTargetsService.deleteOwned(
      "target-1",
      "org-1",
      "user-1"
    );

    // The FK-ordering fix must not be corrupted by an S3 failure: the target
    // row is already gone, so the delete still reports success.
    expect(deleted).toBe(true);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError.mock.calls[0][1]).toMatchObject({
      computeTargetId: "target-1",
      objectStorageKeys: ["transcripts/org-1/a.jsonl"],
    });
  });

  it("does not purge transcript objects when the target row was not deleted", async () => {
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        // A concurrent delete won the race: count 0.
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      sessionTranscript: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { objectStorageKey: "transcripts/org-1/a.jsonl" },
          ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });

    const deleted = await computeTargetsService.deleteOwned(
      "target-1",
      "org-1",
      "user-1"
    );

    expect(deleted).toBe(false);
    expect(mocks.deleteTranscriptObjects).not.toHaveBeenCalled();
  });

  it("returns false without deleting when the target is not owned", async () => {
    const artifactDeleteMany = vi.fn();
    const transcriptFindMany = vi.fn();
    const transcriptDeleteMany = vi.fn();
    const targetDeleteMany = vi.fn();
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(null),
        deleteMany: targetDeleteMany,
      },
      artifact: {
        deleteMany: artifactDeleteMany,
      },
      sessionTranscript: {
        findMany: transcriptFindMany,
        deleteMany: transcriptDeleteMany,
      },
    });

    const deleted = await computeTargetsService.deleteOwned(
      "target-1",
      "org-1",
      "user-1"
    );

    expect(deleted).toBe(false);
    expect(artifactDeleteMany).not.toHaveBeenCalled();
    expect(transcriptFindMany).not.toHaveBeenCalled();
    expect(transcriptDeleteMany).not.toHaveBeenCalled();
    expect(targetDeleteMany).not.toHaveBeenCalled();
    expect(mocks.deleteTranscriptObjects).not.toHaveBeenCalled();
  });
});

describe("upsertHealthCheckSnapshot auto-default harness selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildHealthCheckResult(
    claudeAvailable: boolean,
    codexAvailable: boolean
  ): HealthCheckResponse {
    return {
      checks: [],
      allRequiredPassed: true,
      mcpServers: {
        claude: {
          available: claudeAvailable,
          serverName: null,
          matchedUrl: null,
          checkedAt: "2026-06-09T00:00:00.000Z",
        },
        codex: {
          available: codexAvailable,
          serverName: null,
          matchedUrl: null,
          checkedAt: "2026-06-09T00:00:00.000Z",
        },
      },
    };
  }

  const cases: {
    label: string;
    currentSelectedHarness: string;
    claudeAvailable: boolean;
    codexAvailable: boolean;
    expectsHarnessUpdate: boolean;
    expectedHarness?: string;
  }[] = [
    {
      label:
        "current selectedHarness is available → no update to selectedHarness",
      currentSelectedHarness: HarnessType.Claude,
      claudeAvailable: true,
      codexAvailable: true,
      expectsHarnessUpdate: false,
    },
    {
      label:
        "current selectedHarness becomes unavailable but claude is available → sets to claude",
      currentSelectedHarness: HarnessType.Codex,
      claudeAvailable: true,
      codexAvailable: false,
      expectsHarnessUpdate: true,
      expectedHarness: HarnessType.Claude,
    },
    {
      label:
        "current selectedHarness becomes unavailable and only codex is available → sets to codex",
      currentSelectedHarness: HarnessType.Claude,
      claudeAvailable: false,
      codexAvailable: true,
      expectsHarnessUpdate: true,
      expectedHarness: HarnessType.Codex,
    },
    {
      label: "neither harness is available → selectedHarness left unchanged",
      currentSelectedHarness: HarnessType.Claude,
      claudeAvailable: false,
      codexAvailable: false,
      expectsHarnessUpdate: false,
    },
    {
      label:
        "current selectedHarness was codex and only claude becomes available → switches to claude",
      currentSelectedHarness: HarnessType.Codex,
      claudeAvailable: true,
      codexAvailable: false,
      expectsHarnessUpdate: true,
      expectedHarness: HarnessType.Claude,
    },
  ];

  test.each(cases)("$label", async ({
    currentSelectedHarness,
    claudeAvailable,
    codexAvailable,
    expectsHarnessUpdate,
    expectedHarness,
  }) => {
    const computeTargetUpdate = vi.fn().mockResolvedValue(
      buildTarget({
        selectedHarness: expectedHarness ?? currentSelectedHarness,
      })
    );
    const healthCheckUpsert = vi.fn().mockResolvedValue({
      id: "snapshot-1",
      organizationId: "org-1",
      computeTargetId: "target-1",
      checkedAt: new Date(),
      expectedMcpUrl: null,
      latestVersion: null,
      pluginAutoUpdateEnabled: false,
      result: buildHealthCheckResult(claudeAvailable, codexAvailable),
      allRequiredPassed: true,
      requiredFailureIds: [],
      schemaVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    installDb({
      computeTarget: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            buildTarget({ selectedHarness: currentSelectedHarness })
          ),
        update: computeTargetUpdate,
      },
      computeTargetHealthCheck: {
        upsert: healthCheckUpsert,
      },
    });

    await computeTargetsService.upsertHealthCheckSnapshot(
      "org-1",
      "user-1",
      "target-1",
      {
        result: buildHealthCheckResult(claudeAvailable, codexAvailable),
      }
    );

    if (expectsHarnessUpdate) {
      expect(computeTargetUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "target-1" },
          data: { selectedHarness: expectedHarness },
        })
      );
    } else {
      expect(computeTargetUpdate).not.toHaveBeenCalled();
    }
  });

  it("does not mutate selectedHarness when a shared target health check is stored", async () => {
    const computeTargetUpdate = vi.fn();
    const healthCheckUpsert = vi.fn().mockResolvedValue({
      id: "snapshot-1",
      organizationId: "org-1",
      computeTargetId: "target-1",
      checkedAt: new Date(),
      expectedMcpUrl: null,
      latestVersion: null,
      pluginAutoUpdateEnabled: false,
      result: buildHealthCheckResult(true, false),
      allRequiredPassed: true,
      requiredFailureIds: [],
      schemaVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(
          buildTarget({
            userId: "owner-user",
            isSharedWithOrg: true,
            selectedHarness: HarnessType.Codex,
          })
        ),
        update: computeTargetUpdate,
      },
      computeTargetHealthCheck: {
        upsert: healthCheckUpsert,
      },
    });

    await computeTargetsService.upsertHealthCheckSnapshot(
      "org-1",
      "viewer-user",
      "target-1",
      {
        result: buildHealthCheckResult(true, false),
      }
    );

    expect(healthCheckUpsert).toHaveBeenCalledOnce();
    expect(computeTargetUpdate).not.toHaveBeenCalled();
  });
});

function makeNeutralAvailability(available: boolean): McpProviderAvailability {
  return {
    available,
    serverName: null,
    matchedUrl: null,
    checkedAt: "2026-06-09T00:00:00.000Z",
  };
}

function makeHealthCheck(
  mcpServers?: HealthCheckResponse["mcpServers"]
): HealthCheckResponse {
  return {
    checks: [],
    allRequiredPassed: true,
    ...(mcpServers === undefined ? {} : { mcpServers }),
  };
}

describe("deriveAvailableHarnesses", () => {
  const cases: {
    label: string;
    input: HealthCheckResponse;
    expected: HarnessType[];
  }[] = [
    {
      label: "both claude and codex available → returns both harnesses",
      input: makeHealthCheck({
        claude: makeNeutralAvailability(true),
        codex: makeNeutralAvailability(true),
      }),
      expected: [HarnessType.Claude, HarnessType.Codex],
    },
    {
      label: "only claude available → returns claude only",
      input: makeHealthCheck({
        claude: makeNeutralAvailability(true),
        codex: makeNeutralAvailability(false),
      }),
      expected: [HarnessType.Claude],
    },
    {
      label: "only codex available → returns codex only",
      input: makeHealthCheck({
        claude: makeNeutralAvailability(false),
        codex: makeNeutralAvailability(true),
      }),
      expected: [HarnessType.Codex],
    },
    {
      label: "neither available → returns empty set",
      input: makeHealthCheck({
        claude: makeNeutralAvailability(false),
        codex: makeNeutralAvailability(false),
      }),
      expected: [],
    },
    {
      label: "no mcpServers field → returns empty set",
      input: makeHealthCheck(),
      expected: [],
    },
    {
      label:
        "legacy closedloopAvailable=true for claude → includes claude harness",
      input: makeHealthCheck({
        claude: {
          closedloopAvailable: true,
          checkedAt: "2026-06-09T00:00:00.000Z",
        },
        codex: makeNeutralAvailability(false),
      }),
      expected: [HarnessType.Claude],
    },
    {
      label: "legacy closedloopAvailable=false for both → returns empty set",
      input: makeHealthCheck({
        claude: {
          closedloopAvailable: false,
          checkedAt: "2026-06-09T00:00:00.000Z",
        },
        codex: {
          closedloopAvailable: false,
          checkedAt: "2026-06-09T00:00:00.000Z",
        },
      }),
      expected: [],
    },
  ];

  test.each(cases)("$label", ({ input, expected }) => {
    expect(deriveAvailableHarnesses(input)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// FEA-2923 (Gap A): device-facing listings must exclude the synthetic per-org
// "cloud" sentinel compute target that owns backfilled cloud-authored agents.
// ---------------------------------------------------------------------------
describe("computeTargetsService cloud-sentinel exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(true);
    mocks.loadActiveDesktopManagedGatewayIds.mockResolvedValue(new Set());
  });

  it("listByOwner filters out the cloud sentinel (isCloudSentinel: false)", async () => {
    const findMany = vi.fn().mockResolvedValue([buildTarget()]);
    installDb({
      computeTarget: { findMany },
      apiKey: { findMany: vi.fn().mockResolvedValue([]) },
    });

    await computeTargetsService.listByOwner("org-1", "user-1", "clerk-user-1");

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          userId: "user-1",
          isCloudSentinel: false,
        }),
      })
    );
  });

  it("listAvailableForOrg filters out the cloud sentinel (isCloudSentinel: false)", async () => {
    const findMany = vi.fn().mockResolvedValue([buildTarget()]);
    installDb({
      computeTarget: { findMany },
      apiKey: { findMany: vi.fn().mockResolvedValue([]) },
    });

    await computeTargetsService.listAvailableForOrg(
      "org-1",
      "user-1",
      "clerk-user-1"
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          isCloudSentinel: false,
        }),
      })
    );
  });

  it("hasAnyForOwner filters out the cloud sentinel (isCloudSentinel: false)", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    installDb({ computeTarget: { findFirst } });

    await computeTargetsService.hasAnyForOwner("org-1", "user-1");

    // Defense-in-depth: a "does the owner have a real device?" gate must not be
    // satisfied by the synthetic cloud sentinel that owns cloud-authored agent
    // components.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          userId: "user-1",
          isCloudSentinel: false,
        }),
      })
    );
  });
});
