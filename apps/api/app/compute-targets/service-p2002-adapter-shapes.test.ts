import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-8804: the gateway conflict on the P2002 envelope `@prisma/adapter-pg`
 * ACTUALLY raises.
 *
 * These live in their own file rather than beside the other gateway-conflict
 * cases because `service.test.ts` is on the shrink-only
 * `noExcessiveLinesPerFile` grandfather list — adding to it is not allowed, and
 * padding around that would be the wrong answer.
 *
 * What they protect: `isGatewayUniqueConstraintViolation` read `meta.target`
 * alone, which this adapter never populates, so it never fired. A lost
 * registration race returned a 500 instead of the 409 the non-race path has
 * always returned. Every pre-existing fixture built the legacy shape, so the
 * suite was green against a dead branch.
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

// `loadActiveDesktopManagedGatewayIds` lives here, NOT on desktop-managed-pop.
// An earlier draft of this file declared it on the wrong module, which made the
// stub inert and left the real eligibility loader in play — the drift cost of a
// second hand-maintained mock surface over one module.
vi.mock("@/lib/compute-target-signing-eligibility", () => ({
  CommandSigningEligibilityStatus: {
    Eligible: "eligible",
    Ineligible: "ineligible",
    Unknown: "unknown",
  },
  loadActiveDesktopManagedGatewayIds: mocks.loadActiveDesktopManagedGatewayIds,
}));

const { computeTargetsService, isComputeTargetGatewayConflictResult } =
  await import("./service");

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

/** The envelope adapter-pg raises: `meta.target` unset, constraint nested. */
function adapterPgUniqueViolation(indexName: string): Error {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: {
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: "23505",
          kind: "UniqueConstraintViolation",
          constraint: { index: indexName },
        },
      },
    },
  });
}

function installRejectingUpdate(error: Error): void {
  installDb({
    computeTarget: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ capabilities: {} }),
      update: vi.fn().mockRejectedValue(error),
    },
  });
}

/**
 * The `register` path to the failing write: three `findFirst` probes must all
 * miss (no cross-tenant holder, no target already on this gateway, no target
 * already on this machine name) before it reaches the `upsert` that races.
 */
function installRejectingUpsert(error: Error): void {
  installDb({
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockRejectedValue(error),
    },
    computeTargetHealthCheck: { deleteMany: vi.fn() },
  });
}

function registerWithContestedGateway(): ReturnType<
  typeof computeTargetsService.register
> {
  return computeTargetsService.register("org-1", "user-1", {
    machineName: "machine-1",
    platform: "darwin",
    supportedOperations: [],
    gatewayId: "gateway-contested",
  });
}

function updateOwnedWithContestedGateway(): ReturnType<
  typeof computeTargetsService.updateOwned
> {
  return computeTargetsService.updateOwned(
    "target-1",
    "org-1",
    "user-1",
    { gatewayId: "gateway-contested" },
    null
  );
}

describe("gateway conflict on the adapter-pg P2002 envelope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
    mocks.loadActiveDesktopManagedGatewayIds.mockResolvedValue({
      gatewayIds: new Set(),
      status: "eligible",
    });
  });

  it("maps the gateway unique violation to a gateway conflict result", async () => {
    installRejectingUpdate(
      adapterPgUniqueViolation("compute_targets_gateway_id_unique_idx")
    );

    const result = await updateOwnedWithContestedGateway();

    expect(isComputeTargetGatewayConflictResult(result)).toBe(true);
  });

  it("still rethrows the co-located machine-name unique on that envelope", async () => {
    // `compute_targets` also carries (userId, machineName). The narrowing has
    // to hold on the new shape, not only on the legacy one.
    const unrelated = adapterPgUniqueViolation(
      "compute_targets_user_id_machine_name_key"
    );
    installRejectingUpdate(unrelated);

    await expect(updateOwnedWithContestedGateway()).rejects.toBe(unrelated);
  });

  // ISS-8804 thread (whitlockk): BOTH callers of
  // `isGatewayUniqueConstraintViolation` have to be exercised on this envelope.
  // Until these two cases existed, only `updateOwned` was, so `register`'s
  // production path could go dead again — silently, because the matcher it
  // shares would still look covered. `register` is also the path a lost
  // REGISTRATION race actually takes, which is the 500-instead-of-409 this
  // ticket exists to fix.
  it("maps the gateway unique violation to a conflict on REGISTER too", async () => {
    installRejectingUpsert(
      adapterPgUniqueViolation("compute_targets_gateway_id_unique_idx")
    );

    const result = await registerWithContestedGateway();

    expect(isComputeTargetGatewayConflictResult(result)).toBe(true);
  });

  it("still rethrows the co-located machine-name unique from REGISTER", async () => {
    // The `upsert` targets `userId_machineName`, so this constraint is the one
    // most likely to fire here — the narrowing has to hold on the path where
    // the unrelated violation is most reachable, not only where it is rarest.
    const unrelated = adapterPgUniqueViolation(
      "compute_targets_user_id_machine_name_key"
    );
    installRejectingUpsert(unrelated);

    await expect(registerWithContestedGateway()).rejects.toBe(unrelated);
  });
});
