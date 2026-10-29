import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHostileOrderedFindMany } from "@/__tests__/utils/hostile-order-planner.test-helpers";

/**
 * ISS-9780: the compute-target list reads order on `isOnline` then `updatedAt`,
 * neither of which is unique.
 *
 * Both reads are UNPAGINATED, so the exposure is not a page boundary — it is
 * that two identical reads could hand the user two different orders. The
 * population these render is exactly the tie-prone one: a fleet of machines that
 * checked in during the same sync tick shares both columns.
 *
 * These live in their own file rather than beside the other list cases because
 * `service.test.ts` is on the shrink-only `noExcessiveLinesPerFile` grandfather
 * list — adding to it is not allowed, and padding around that would be the wrong
 * answer. Same reasoning as `service-p2002-adapter-shapes.test.ts`.
 *
 * The fake below APPLIES the ordering the service asks for and permutes tied
 * rows between calls, so these observe the ORDER SERVED rather than asserting
 * the `orderBy` literal back — a source-shaped assertion would stay green if the
 * terminal key were reordered into a position that does not break the tie.
 */
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

const { computeTargetsService } = await import("./service");

const TIED_AT = new Date("2026-09-01T00:00:00.000Z");

function installDb(db: unknown): void {
  const dbWithDefaults =
    typeof db === "object" && db !== null
      ? { computeTargetHealthCheck: { deleteMany: vi.fn() }, ...db }
      : db;
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
}

/** Four targets tied on BOTH ordering columns, in a deliberately unsorted order. */
function installTiedTargets(): void {
  const targets = ["target-d", "target-b", "target-a", "target-c"].map(
    targetRow
  );
  installDb({
    computeTarget: { findMany: createHostileOrderedFindMany(targets) },
    apiKey: { findMany: vi.fn().mockResolvedValue([]) },
  });
}

describe("computeTargetsService list ordering is total (ISS-9780)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
    mocks.loadActiveDesktopManagedGatewayIds.mockResolvedValue(new Set());
  });

  it("serves listByOwner in the same order twice when every row is tied", async () => {
    installTiedTargets();

    const first = await computeTargetsService.listByOwner("org-1", "user-1");
    const second = await computeTargetsService.listByOwner("org-1", "user-1");

    expect(first.map((target) => target.id)).toEqual(
      second.map((target) => target.id)
    );
    expect(first).toHaveLength(4);
    // The fixture really is tied, so the agreement above came from the terminal
    // key and not from there being nothing to disagree about.
    expect(new Set(first.map((target) => target.isOnline)).size).toBe(1);
  });

  it("serves listAvailableForOrg in the same order twice when every row is tied", async () => {
    installTiedTargets();

    const first = await computeTargetsService.listAvailableForOrg(
      "org-1",
      "user-1"
    );
    const second = await computeTargetsService.listAvailableForOrg(
      "org-1",
      "user-1"
    );

    expect(first.map((target) => target.id)).toEqual(
      second.map((target) => target.id)
    );
    expect(first).toHaveLength(4);
  });
});

// ISS-12617 retired target sharing: the list is the caller's own targets only.
// Exact `where`, so an `OR` that re-admits a teammate's target fails. It lives
// here, not in `service.test.ts`, for the grandfather-list reason above.
describe("computeTargetsService list read scope (ISS-12617)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
    mocks.loadActiveDesktopManagedGatewayIds.mockResolvedValue(new Set());
  });

  it("listAvailableForOrg reads only the caller's own targets", async () => {
    const findMany = vi.fn().mockResolvedValue([targetRow("target-1")]);
    installDb({
      computeTarget: { findMany },
      apiKey: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const result = await computeTargetsService.listAvailableForOrg(
      "org-1",
      "user-1",
      "clerk-user-1"
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          isCloudSentinel: false,
          userId: "user-1",
        },
      })
    );
    expect(result[0]?.isSharedWithOrg).toBe(false);
  });
});

function targetRow(id: string) {
  return {
    id,
    organizationId: "org-1",
    userId: "user-1",
    machineName: `machine-${id}`,
    platform: "darwin",
    capabilities: {},
    supportedOperations: [],
    lastSeenAt: TIED_AT,
    isOnline: true,
    isSharedWithOrg: false,
    gatewayId: `gateway-${id}`,
    createdAt: TIED_AT,
    updatedAt: TIED_AT,
    user: null,
  };
}
