import {
  DesktopSecurityStatus,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  isDesktopManagedPopEnforcementEnabled: vi.fn(),
  loadActiveDesktopManagedGatewayIds: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  ApiKeySource: { DESKTOP_MANAGED: "DESKTOP_MANAGED" },
  withDb: mocks.withDb,
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

import {
  createModelDouble,
  type Row,
} from "@/__tests__/support/read-narrowing-projection.test-db";
import { computeTargetsService } from "@/app/compute-targets/service";
import { mockWithDbAll } from "../utils/db-helpers";

/**
 * ISS-9189 — the compute-target reads narrowed in this change, characterized
 * through {@link createModelDouble} so the `select` is actually APPLIED. A
 * plain resolved-value mock hands the mappers every column whatever the query
 * asked for, so an output-only assertion here would pass with the whole diff
 * reverted (the failure `review-soul` caught on #5216).
 */

const ORG_ID = "org-1";
const USER_ID = "user-1";
const OTHER_USER_ID = "user-2";
const TARGET_ID = "target-1";
const NOW = new Date("2026-09-04T12:00:00.000Z");

/** Every column the table has — including the five no mapper reads. */
function targetRow(overrides: Row = {}): Row {
  return {
    id: TARGET_ID,
    organizationId: ORG_ID,
    userId: USER_ID,
    machineName: "machine-1",
    platform: "darwin",
    capabilities: { desktopSecurityUpgradeProtocolVersion: 1 },
    supportedOperations: ["git_action"],
    lastSeenAt: NOW,
    lastAgentSessionSyncAt: NOW,
    lastAgentSessionSyncAttemptAt: NOW,
    isOnline: true,
    isSharedWithOrg: false,
    isCloudSentinel: false,
    gatewayId: "gateway-1",
    selectedHarness: HarnessType.Codex,
    queuedCommandCount: 3,
    queuedDepthSweptAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const RECORD_COLUMNS = [
  "id",
  "organizationId",
  "userId",
  "machineName",
  "platform",
  "capabilities",
  "supportedOperations",
  "lastSeenAt",
  "isOnline",
  "gatewayId",
  "selectedHarness",
  "createdAt",
  "updatedAt",
];

const MATERIAL_CHANGE_COLUMNS = [
  "id",
  "machineName",
  "platform",
  "capabilities",
  "supportedOperations",
  "gatewayId",
];

/**
 * What an UNNARROWED read of this fixture returns. `computeTarget.update`'s
 * RETURNING is unnarrowed and out of this change's scope, so the register and
 * update paths record one of these after the read they do narrow — listing it
 * keeps the `returnedColumns` assertions exact rather than partial.
 */
const ALL_COLUMNS = Object.keys(targetRow());

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
  mocks.loadActiveDesktopManagedGatewayIds.mockResolvedValue({
    status: "ineligible",
    gatewayIds: new Set<string>(),
  });
});

describe("compute-target record reads", () => {
  it("hands listByOwner exactly the columns the ComputeTarget mapper reads", async () => {
    const computeTarget = createModelDouble([targetRow()]);
    mockWithDbAll({ computeTarget });

    const targets = await computeTargetsService.listByOwner(ORG_ID, USER_ID);

    // Exact, so this reddens both on an absent select (the row would arrive
    // carrying queuedCommandCount / isCloudSentinel / the two sync watermarks,
    // none of which any mapper reads) and on a widened one.
    expect(computeTarget.returnedColumns).toEqual([RECORD_COLUMNS]);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.selectedHarness).toBe(HarnessType.Codex);
    expect(targets[0]?.gatewayId).toBe("gateway-1");
  });

  it("renders findOwnedById from the narrowed row without losing an optional column", async () => {
    const computeTarget = createModelDouble([targetRow()]);
    mockWithDbAll({ computeTarget });

    const target = await computeTargetsService.findOwnedById(
      TARGET_ID,
      ORG_ID,
      USER_ID
    );

    expect(computeTarget.returnedColumns).toEqual([RECORD_COLUMNS]);
    // `gatewayId` and `selectedHarness` are OPTIONAL on ComputeTargetRecord, so
    // dropping either key from the select still assigns cleanly and only shows
    // up here: an undefined gateway and a harness silently coerced to the
    // Claude default. This is the pair `satisfies` exists to protect.
    expect(target?.gatewayId).toBe("gateway-1");
    expect(target?.selectedHarness).toBe(HarnessType.Codex);
    expect(target?.security?.status).toBe(DesktopSecurityStatus.LegacyManual);
  });

  it("narrows the accessible read to the caller's own target", async () => {
    const computeTarget = createModelDouble([targetRow()]);
    mockWithDbAll({ computeTarget });

    const target = await computeTargetsService.findAccessibleById(
      TARGET_ID,
      ORG_ID,
      USER_ID
    );

    expect(computeTarget.returnedColumns).toEqual([RECORD_COLUMNS]);
    expect(target?.id).toBe(TARGET_ID);
    // ISS-12617 retired sharing: the API still sends the field, always false.
    expect(target?.isSharedWithOrg).toBe(false);
  });

  it("does not reach a teammate's target that was shared before ISS-12617", async () => {
    const computeTarget = createModelDouble([
      targetRow({ userId: OTHER_USER_ID, isSharedWithOrg: true }),
    ]);
    mockWithDbAll({ computeTarget });

    const target = await computeTargetsService.findAccessibleById(
      TARGET_ID,
      ORG_ID,
      USER_ID
    );

    expect(target).toBeNull();
  });
});

describe("compute-target material-change reads", () => {
  it("reads only the invalidation columns when re-registering an unchanged gateway target", async () => {
    const computeTarget = createModelDouble([targetRow()]);
    const computeTargetHealthCheck = createModelDouble([
      { id: "hc-1", computeTargetId: TARGET_ID },
    ]);
    mockWithDbAll({ computeTarget, computeTargetHealthCheck });

    await computeTargetsService.register(ORG_ID, USER_ID, {
      machineName: "machine-1",
      platform: "darwin",
      capabilities: { desktopSecurityUpgradeProtocolVersion: 1 },
      supportedOperations: ["git_action"],
      gatewayId: "gateway-1",
    });

    // The gateway-conflict probe matches nothing (same org and owner), so it
    // records no projection; the narrowed read is the first entry.
    expect(computeTarget.returnedColumns).toEqual([
      MATERIAL_CHANGE_COLUMNS,
      ALL_COLUMNS,
    ]);
    // Nothing material changed, so the stored health check must survive. This
    // is the falsifiable half: drop `machineName`, `platform`, `capabilities`,
    // `supportedOperations` or `gatewayId` from the select and the comparison
    // reads `undefined` on that side, declares a material change, and deletes a
    // snapshot that was still valid.
    expect(computeTargetHealthCheck.rows).toHaveLength(1);
  });

  it("still invalidates the health check when a material column actually changed", async () => {
    const computeTarget = createModelDouble([targetRow()]);
    const computeTargetHealthCheck = createModelDouble([
      { id: "hc-1", computeTargetId: TARGET_ID },
    ]);
    mockWithDbAll({ computeTarget, computeTargetHealthCheck });

    await computeTargetsService.register(ORG_ID, USER_ID, {
      machineName: "machine-1",
      platform: "linux",
      capabilities: { desktopSecurityUpgradeProtocolVersion: 1 },
      supportedOperations: ["git_action"],
      gatewayId: "gateway-1",
    });

    expect(computeTargetHealthCheck.rows).toHaveLength(0);
  });

  it("reads only the invalidation columns on an owned update", async () => {
    const computeTarget = createModelDouble([targetRow()]);
    const computeTargetHealthCheck = createModelDouble([
      { id: "hc-1", computeTargetId: TARGET_ID },
    ]);
    mockWithDbAll({ computeTarget, computeTargetHealthCheck });

    const result = await computeTargetsService.updateOwned(
      TARGET_ID,
      ORG_ID,
      USER_ID,
      { capabilities: { pluginVersion: "9.9.9" } }
    );

    expect(computeTarget.returnedColumns).toEqual([
      MATERIAL_CHANGE_COLUMNS,
      ALL_COLUMNS,
    ]);
    // `capabilities` is the one material column the update path also MERGES
    // from, so dropping it would silently discard the stored protocol version
    // rather than carry it forward alongside the incoming plugin version.
    expect(result.ok && result.value?.capabilities).toEqual({
      desktopSecurityUpgradeProtocolVersion: 1,
      pluginVersion: "9.9.9",
    });
  });
});

describe("compute-target health-check snapshot read", () => {
  it("pins the snapshot projection so a newly added column is not disclosed", async () => {
    const computeTarget = createModelDouble([targetRow()]);
    const computeTargetHealthCheck = createModelDouble([
      {
        id: "hc-1",
        organizationId: ORG_ID,
        computeTargetId: TARGET_ID,
        checkedAt: NOW,
        expectedMcpUrl: null,
        latestVersion: "1.2.3",
        pluginAutoUpdateEnabled: true,
        result: { checks: [] },
        allRequiredPassed: true,
        requiredFailureIds: [],
        schemaVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
        // Stands in for a column added to `compute_target_health_checks` after
        // this select was written. The record type and the table agree today,
        // so the select narrows nothing — what it buys is that the NEXT column
        // does not reach the response by default.
        internalDiagnosticsBlob: "not-for-the-wire",
      },
    ]);
    mockWithDbAll({ computeTarget, computeTargetHealthCheck });

    const snapshot = await computeTargetsService.getLatestHealthCheckForTarget(
      ORG_ID,
      USER_ID,
      TARGET_ID
    );

    expect(computeTargetHealthCheck.returnedColumns.flat()).not.toContain(
      "internalDiagnosticsBlob"
    );
    expect(snapshot?.latestVersion).toBe("1.2.3");
    expect(snapshot?.schemaVersion).toBe(1);
  });
});
