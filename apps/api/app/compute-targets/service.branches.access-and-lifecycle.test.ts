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

import { COMPUTE_TARGET_STALE_MS, computeTargetsService } from "./service";

describe("computeTargetsService findOwnedById desktop security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when the target is not owned by the caller", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    installDb(mocks.withDb, {
      computeTarget: { findFirst },
    });

    const result = await computeTargetsService.findOwnedById(
      "target-1",
      "org-1",
      "user-1",
      "clerk-user-1"
    );

    // Pinned as an EXACT where, matching the pattern already used for
    // updateOwned's material-change lookup: dropping organizationId or
    // userId from findOwnedById's `where` would let a cross-org or
    // non-owner caller resolve a foreign target, and only an exact match
    // (not an objectContaining subset) fails when either predicate is lost.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "target-1", organizationId: "org-1", userId: "user-1" },
      })
    );
    expect(result).toBeNull();
  });

  it("loads protected-gateway state for a target with a gateway when Desktop-managed PoP enforcement is enabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(true);
    const apiKeyFindMany = vi
      .fn()
      .mockResolvedValue([{ gatewayId: "gateway-1" }]);
    installDb(mocks.withDb, {
      computeTarget: { findFirst: vi.fn().mockResolvedValue(buildTarget()) },
      apiKey: { findMany: apiKeyFindMany },
    });

    const result = await computeTargetsService.findOwnedById(
      "target-1",
      "org-1",
      "user-1",
      "clerk-user-1"
    );

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
    expect(result?.security).toEqual({
      status: DesktopSecurityStatus.Protected,
      reason: "BOUND_DESKTOP_MANAGED_KEY",
      upgradeSupported: false,
    });
  });

  it("returns a legacy-manual security status without querying protected gateways when Desktop-managed PoP enforcement is disabled", async () => {
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
    const apiKeyFindMany = vi.fn();
    installDb(mocks.withDb, {
      computeTarget: { findFirst: vi.fn().mockResolvedValue(buildTarget()) },
      apiKey: { findMany: apiKeyFindMany },
    });

    const result = await computeTargetsService.findOwnedById(
      "target-1",
      "org-1",
      "user-1",
      "clerk-user-1"
    );

    expect(apiKeyFindMany).not.toHaveBeenCalled();
    expect(result?.security).toEqual({
      status: DesktopSecurityStatus.LegacyManual,
      reason: "FEATURE_DISABLED",
      upgradeSupported: false,
    });
  });

  it("skips the protected-gateway lookup query for a target with no gateway when Desktop-managed PoP enforcement is enabled", async () => {
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(true);
    const apiKeyFindMany = vi.fn();
    installDb(mocks.withDb, {
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(buildTarget({ gatewayId: null })),
      },
      apiKey: { findMany: apiKeyFindMany },
    });

    const result = await computeTargetsService.findOwnedById(
      "target-1",
      "org-1",
      "user-1",
      "clerk-user-1"
    );

    expect(apiKeyFindMany).not.toHaveBeenCalled();
    expect(result?.security).toEqual({
      status: DesktopSecurityStatus.UpdateRequired,
      reason: "MISSING_GATEWAY_ID",
      upgradeSupported: false,
    });
  });
});

describe("computeTargetsService setOnlineState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks the target online and stamps a fresh lastSeenAt", async () => {
    const fixedNow = new Date("2026-06-01T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    installDb(mocks.withDb, { computeTarget: { updateMany } });

    const result = await computeTargetsService.setOnlineState(
      "target-1",
      "org-1",
      "user-1",
      true
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "target-1", organizationId: "org-1", userId: "user-1" },
      data: { isOnline: true, lastSeenAt: fixedNow },
    });
    expect(result).toBe(true);
  });

  it("marks the target offline without touching lastSeenAt", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    installDb(mocks.withDb, { computeTarget: { updateMany } });

    const result = await computeTargetsService.setOnlineState(
      "target-1",
      "org-1",
      "user-1",
      false
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "target-1", organizationId: "org-1", userId: "user-1" },
      data: { isOnline: false },
    });
    expect(result).toBe(false);
  });
});

describe("computeTargetsService markStaleTargetsOffline", () => {
  const fixedNow = new Date("2026-06-01T12:00:00.000Z");
  const cutoff = new Date(fixedNow.getTime() - COMPUTE_TARGET_STALE_MS);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("scopes the stale sweep to the given organization and user", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 3 });
    installDb(mocks.withDb, { computeTarget: { updateMany } });

    const result = await computeTargetsService.markStaleTargetsOffline({
      organizationId: "org-1",
      userId: "user-1",
    });

    // Exact (not objectContaining) `where`, so dropping `lastSeenAt: { lt:
    // cutoff }` is caught — without it this only pins "mark every online
    // target in org-1/user-1 offline", not a STALE sweep.
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        isOnline: true,
        lastSeenAt: { lt: cutoff },
        organizationId: "org-1",
        userId: "user-1",
      },
      data: { isOnline: false },
    });
    expect(result).toBe(3);
  });

  it("sweeps every organization when no scope is given", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    installDb(mocks.withDb, { computeTarget: { updateMany } });

    await computeTargetsService.markStaleTargetsOffline();

    // Exact (not objectContaining) `where`: pins both that no
    // organizationId/userId predicate is added AND that the sweep only ever
    // selects currently-online rows past `lastSeenAt: { lt: cutoff }` before
    // writing them offline — a flipped literal on either side would still
    // "sweep every organization" but would query or mutate the wrong rows.
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        isOnline: true,
        lastSeenAt: { lt: cutoff },
      },
      data: { isOnline: false },
    });
  });
});

describe("computeTargetsService getLatestHealthCheckForTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null without querying health checks when the target is not accessible", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const findUnique = vi.fn();
    installDb(mocks.withDb, {
      computeTarget: { findFirst },
      computeTargetHealthCheck: { findUnique },
    });

    const result = await computeTargetsService.getLatestHealthCheckForTarget(
      "org-1",
      "user-1",
      "target-1"
    );

    // Pins the accessibility predicate `findAccessibleTargetRecord` shares
    // with findAccessibleById: organizationId AND the caller owns it, with no
    // `OR` (ISS-12617 retired sharing). Dropping either half would let another
    // member's health check leak through.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "target-1",
          organizationId: "org-1",
          userId: "user-1",
        },
      })
    );
    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns the latest snapshot for an accessible target", async () => {
    const checkedAt = new Date("2026-05-08T16:00:00.000Z");
    const findFirst = vi.fn().mockResolvedValue(buildTarget());
    const findUnique = vi.fn().mockResolvedValue({
      id: "snapshot-1",
      organizationId: "org-1",
      computeTargetId: "target-1",
      checkedAt,
      expectedMcpUrl: null,
      latestVersion: "1.2.3",
      pluginAutoUpdateEnabled: false,
      result: { checks: [], allRequiredPassed: true },
      allRequiredPassed: true,
      requiredFailureIds: [],
      schemaVersion: 1,
      createdAt: checkedAt,
      updatedAt: checkedAt,
    });
    installDb(mocks.withDb, {
      computeTarget: { findFirst },
      computeTargetHealthCheck: { findUnique },
    });

    const result = await computeTargetsService.getLatestHealthCheckForTarget(
      "org-1",
      "user-1",
      "target-1"
    );

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "target-1",
          organizationId: "org-1",
          userId: "user-1",
        },
      })
    );
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { computeTargetId: "target-1" } })
    );
    expect(result?.latestVersion).toBe("1.2.3");
  });
});
