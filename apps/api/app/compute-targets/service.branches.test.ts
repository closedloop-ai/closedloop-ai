import type { JsonObject } from "@repo/api/src/types/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTarget,
  installDb,
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

describe("computeTargetsService register capabilities passthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("copies allowedDirectories and pluginVersion into the stored capabilities blob on first-time registration", async () => {
    const upsert = vi.fn().mockResolvedValue(buildTarget({ gatewayId: null }));
    installDb(mocks.withDb, {
      computeTarget: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert,
      },
    });

    await computeTargetsService.register("org-1", "user-1", {
      machineName: "machine-1",
      platform: "darwin",
      supportedOperations: ["git_action"],
      allowedDirectories: ["/repo"],
      pluginVersion: "2.0.0",
    });

    const expectedCapabilities: JsonObject = {
      allowedDirectories: ["/repo"],
      pluginVersion: "2.0.0",
    };
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ capabilities: expectedCapabilities }),
        update: expect.objectContaining({ capabilities: expectedCapabilities }),
      })
    );
  });

  it("omits allowedDirectories from capabilities when the key is present but falsy", async () => {
    const upsert = vi.fn().mockResolvedValue(buildTarget({ gatewayId: null }));
    installDb(mocks.withDb, {
      computeTarget: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert,
      },
    });

    await computeTargetsService.register("org-1", "user-1", {
      machineName: "machine-1",
      platform: "darwin",
      supportedOperations: ["git_action"],
      // Key present ("in" is true) but the value is falsy — distinguishes the
      // real `&&` from a mutated `||`, which a present-and-truthy value cannot.
      allowedDirectories: undefined,
    });

    const create = upsert.mock.calls[0]?.[0]?.create;
    expect(Object.hasOwn(create.capabilities, "allowedDirectories")).toBe(
      false
    );
  });

  it("omits pluginVersion from capabilities when the key is present but falsy", async () => {
    const upsert = vi.fn().mockResolvedValue(buildTarget({ gatewayId: null }));
    installDb(mocks.withDb, {
      computeTarget: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert,
      },
    });

    await computeTargetsService.register("org-1", "user-1", {
      machineName: "machine-1",
      platform: "darwin",
      supportedOperations: ["git_action"],
      pluginVersion: "",
    });

    const create = upsert.mock.calls[0]?.[0]?.create;
    expect(create.capabilities).toStrictEqual({});
  });
});

describe("computeTargetsService register without a gatewayId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates the stored health check when a machine-scoped upsert changes a material field", async () => {
    const deleteMany = vi.fn();
    const upsert = vi
      .fn()
      .mockResolvedValue(buildTarget({ platform: "linux" }));
    installDb(mocks.withDb, {
      computeTarget: {
        findUnique: vi.fn().mockResolvedValue({
          id: "existing-1",
          platform: "darwin",
          capabilities: {},
          supportedOperations: ["git_action"],
        }),
        upsert,
      },
      computeTargetHealthCheck: { deleteMany },
    });

    const result = await computeTargetsService.register("org-1", "user-1", {
      machineName: "machine-1",
      platform: "linux",
      capabilities: {},
      supportedOperations: ["git_action"],
    });

    expect(deleteMany).toHaveBeenCalledWith({
      where: { computeTargetId: "existing-1" },
    });
    expect(result.ok).toBe(true);
  });

  it("skips health-check invalidation when no machine-scoped target exists yet", async () => {
    const deleteMany = vi.fn();
    const upsert = vi.fn().mockResolvedValue(buildTarget({ gatewayId: null }));
    installDb(mocks.withDb, {
      computeTarget: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert,
      },
      computeTargetHealthCheck: { deleteMany },
    });

    await computeTargetsService.register("org-1", "user-1", {
      machineName: "new-machine",
      platform: "darwin",
      capabilities: {},
      supportedOperations: ["git_action"],
    });

    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe("computeTargetsService register with a gatewayId and no material change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips health-check invalidation when re-registering the same gateway with unchanged fields", async () => {
    const deleteMany = vi.fn();
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        buildTarget({
          id: "target-existing",
          gatewayId: "gateway-1",
          capabilities: {},
        })
      );
    installDb(mocks.withDb, {
      computeTarget: {
        findFirst,
        update: vi
          .fn()
          .mockResolvedValue(buildTarget({ gatewayId: "gateway-1" })),
      },
      computeTargetHealthCheck: { deleteMany },
    });

    await computeTargetsService.register("org-1", "user-1", {
      machineName: "machine-1",
      platform: "darwin",
      gatewayId: "gateway-1",
      capabilities: {},
      supportedOperations: ["git_action"],
    });

    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("skips health-check invalidation when attaching an unchanged machine-name target to its own gateway", async () => {
    const deleteMany = vi.fn();
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        buildTarget({
          id: "machine-target-2",
          gatewayId: "gateway-2",
          capabilities: {},
        })
      );
    installDb(mocks.withDb, {
      computeTarget: {
        findFirst,
        update: vi
          .fn()
          .mockResolvedValue(buildTarget({ gatewayId: "gateway-2" })),
      },
      computeTargetHealthCheck: { deleteMany },
    });

    await computeTargetsService.register("org-1", "user-1", {
      machineName: "machine-2",
      platform: "darwin",
      gatewayId: "gateway-2",
      capabilities: {},
      supportedOperations: ["git_action"],
    });

    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("re-throws a P2002 error whose target is neither a string nor an array without remapping it to a gateway conflict", async () => {
    const opaqueTargetP2002 = Object.assign(
      new Error("Unique constraint failed"),
      { code: "P2002", meta: { target: 42 } }
    );
    installDb(mocks.withDb, {
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockRejectedValue(opaqueTargetP2002),
      },
    });

    await expect(
      computeTargetsService.register("org-1", "user-1", {
        machineName: "machine-1",
        platform: "darwin",
        gatewayId: "gateway-1",
        capabilities: {},
        supportedOperations: [],
      })
    ).rejects.toThrow("Unique constraint failed");
  });
});
