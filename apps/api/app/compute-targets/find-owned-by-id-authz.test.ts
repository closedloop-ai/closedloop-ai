import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-4504: authz invariant of the REAL `computeTargetsService.findOwnedById`
 * lookup query. The member-pack-install suite mocks this method, so it can only
 * pin that the dispatcher forwards org/user args — a regression that dropped the
 * `organizationId` or `userId` predicate from the underlying `findFirst` would
 * still pass there. This suite drives the actual service against a fake Prisma
 * and asserts the owner-only `where` clause, so a cross-org caller cannot reach
 * a node it does not own.
 */

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  isDesktopManagedPopEnforcementEnabled: vi.fn(),
  loadActiveDesktopManagedGatewayIds: vi.fn(),
  isAgentSessionSyncSupportedForUser: vi.fn(),
  deleteTranscriptObjects: vi.fn(),
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
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
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

import { computeTargetsService } from "./service";

const now = new Date("2026-07-29T00:00:00.000Z");

function buildRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "target-1",
    organizationId: "org-1",
    userId: "user-1",
    machineName: "machine-1",
    platform: "darwin",
    capabilities: {},
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
  mocks.withDb.mockImplementation((cb: (client: unknown) => unknown) => cb(db));
  mocks.withDb.tx.mockImplementation((cb: (client: unknown) => unknown) =>
    cb(db)
  );
}

describe("computeTargetsService.findOwnedById authz predicate", () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) {
      if (typeof m === "function") {
        m.mockReset();
      }
    }
    // Keep the desktop-security branch out of the way: this suite asserts the
    // ownership predicate, not the protected-gateway augmentation.
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
  });

  it("scopes the lookup by id AND organizationId AND userId", async () => {
    const findFirst = vi.fn().mockResolvedValue(buildRow());
    installDb({ computeTarget: { findFirst } });

    await computeTargetsService.findOwnedById(
      "target-1",
      "org-1",
      "user-1",
      "clerk-1"
    );

    // The owner-only gate lives in the query itself — dropping either the org or
    // the user predicate would let a cross-org / non-owner caller resolve a
    // foreign node. Assert all three are present.
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "target-1", organizationId: "org-1", userId: "user-1" },
    });
  });

  it("returns null (never a foreign node) when the owner-scoped row is absent", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    installDb({ computeTarget: { findFirst } });

    const result = await computeTargetsService.findOwnedById(
      "target-1",
      "org-OTHER",
      "user-2",
      "clerk-2"
    );

    expect(result).toBeNull();
    // A cross-org caller's org/user still reach the predicate, so the DB — not a
    // post-filter — is what excludes the foreign node.
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: "target-1",
        organizationId: "org-OTHER",
        userId: "user-2",
      },
    });
  });
});
