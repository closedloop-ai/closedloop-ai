/**
 * ISS-6934 — every remaining admin-gated route admits BOTH privileged Clerk
 * roles, not just `org:admin`.
 *
 * `ADMIN_ROLES` (apps/api/lib/auth/org-admin.ts) is the single place a Clerk
 * membership role becomes an admin verdict. Dropping `org:owner` from it would
 * lock every org owner out of every route below with no other signal — and the
 * pre-existing tests for these routes could not catch it, because they stub
 * `getOrgAdminStatus` itself and so never reach the role check.
 *
 * So this suite stubs the CLERK CLIENT and runs the real `org-admin` module
 * behind each real route handler. `org:admin` and `org:owner` are separate
 * cases per gate: a suite that only exercises `org:admin` stays green under
 * exactly the change this file exists to catch. The unprivileged case is what
 * proves the harness is honest — the stubbed role genuinely drives the outcome
 * rather than the handler answering 200 regardless.
 *
 * Scope: the three gates below. ISS-8661 retired the `isOrgAdmin` boolean
 * wrapper for `requireOrgAdmin`; the gates that went through it are covered at
 * the same depth by `catalog-admin-gate-provider-error.test.ts` (route layer)
 * and `lib/auth/__tests__/org-admin.test.ts` (the decision itself).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Assigned after the imports below; the mocked middlewares read it lazily, at
// handler-invocation time, so the hoisted factories never see the TDZ.
let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

const mocks = vi.hoisted(() => ({
  getOrganizationMembershipRole: vi.fn(),
  frustrationSettingService: {
    isFrustrationEnabled: vi.fn(),
    setFrustrationEnabled: vi.fn(),
  },
  organizationsService: {
    findById: vi.fn(),
    findBySlug: vi.fn(),
    findDetailById: vi.fn(),
    update: vi.fn(),
  },
  updateClerkOrganization: vi.fn(),
}));

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getOrganizationMembershipRole: mocks.getOrganizationMembershipRole,
    updateOrganization: mocks.updateClerkOrganization,
  },
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params),
}));

// Isolation only, NOT coverage: every gate below is `withAuth`-wrapped. This
// exists because `settings/frustration/route.ts` also imports `withAnyAuth` for
// its ungated GET, which this suite never invokes. No admin gate in scope runs
// through `withAnyAuth`, so nothing here proves anything about one.
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params),
}));

vi.mock("@/app/settings/frustration-setting-service", () => ({
  frustrationSettingService: mocks.frustrationSettingService,
}));

vi.mock("@/app/organizations/service", () => ({
  organizationsService: mocks.organizationsService,
}));

import {
  ADMIN_GATE_CLERK_ORG_ID,
  ADMIN_GATE_CLERK_USER_ID,
  ADMIN_GATE_ORG_ROW,
  buildAdminGateInvocations,
} from "@/__tests__/support/auth/admin-gate-routes.test-fixtures";
import {
  ClerkOrgRoleFixture,
  createTestAuthContext,
  PRIVILEGED_CLERK_ORG_ROLES,
} from "@/__tests__/utils/auth-helpers";

import { PUT as putOrganization } from "@/app/organizations/[id]/route";
import { PUT as putFrustration } from "@/app/settings/frustration/route";

mockAuthContext = createTestAuthContext({
  clerkOrgId: ADMIN_GATE_CLERK_ORG_ID,
  clerkUserId: ADMIN_GATE_CLERK_USER_ID,
});

type AdminGate = {
  /** Route + method, as the gate is identified in its denial telemetry. */
  name: string;
  /** Invokes the real handler through the real `getOrgAdminStatus`. */
  invoke: () => Promise<Response>;
  /** The privileged work behind the gate; must run only when admitted. */
  gatedEffect: () => ReturnType<typeof vi.fn>;
};

/**
 * The privileged work behind each shared org-policy-write gate, keyed by the
 * shared invocation name. The REQUESTS come from `buildAdminGateInvocations`
 * (ISS-7350), so this suite and `admin-denial-monitored-event.test.ts` drive
 * byte-identical requests against the same three gates — a divergence between
 * them would mean "admits an admin" and "reports a refusal" were not actually
 * testing the same gate.
 */
const SHARED_GATE_EFFECTS: Record<string, () => ReturnType<typeof vi.fn>> = {
  "PUT /settings/frustration": () =>
    mocks.frustrationSettingService.setFrustrationEnabled,
  "PUT /organizations/[id] (admin-only field)": () =>
    mocks.organizationsService.update,
  "PUT /organizations/[id] (slug change)": () =>
    mocks.organizationsService.update,
};

const adminGates: AdminGate[] = [
  ...buildAdminGateInvocations({
    putOrganization,
    putFrustration,
  }).map((site) => ({
    ...site,
    gatedEffect: SHARED_GATE_EFFECTS[site.name],
  })),
];

describe("admin-gated routes — privileged Clerk roles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.organizationsService.findById.mockResolvedValue(ADMIN_GATE_ORG_ROW);
    mocks.organizationsService.findDetailById.mockResolvedValue(
      ADMIN_GATE_ORG_ROW
    );
    mocks.organizationsService.findBySlug.mockResolvedValue(null);
    mocks.organizationsService.update.mockResolvedValue(ADMIN_GATE_ORG_ROW);
    mocks.updateClerkOrganization.mockResolvedValue({
      id: ADMIN_GATE_CLERK_ORG_ID,
    });
  });

  // Both roles, as separate cases: a gate covered only for `org:admin` still
  // passes with `org:owner` removed from ADMIN_ROLES, which is the whole gap.
  for (const role of PRIVILEGED_CLERK_ORG_ROLES) {
    it.each(adminGates)(
      `admits the ${role} role on $name`,
      async ({ invoke, gatedEffect }) => {
        mocks.getOrganizationMembershipRole.mockResolvedValue(role);

        const response = await invoke();

        expect(response.status).toBe(200);
        expect(gatedEffect()).toHaveBeenCalled();
        expect(mocks.getOrganizationMembershipRole).toHaveBeenCalledWith(
          ADMIN_GATE_CLERK_ORG_ID,
          ADMIN_GATE_CLERK_USER_ID
        );
      }
    );
  }

  // Proves the stubbed role actually drives each gate — without this, a handler
  // that answered 200 unconditionally would pass both cases above.
  it.each(adminGates)(
    "denies an unprivileged role on $name",
    async ({ invoke, gatedEffect }) => {
      mocks.getOrganizationMembershipRole.mockResolvedValue(
        ClerkOrgRoleFixture.Member
      );

      const response = await invoke();

      expect(response.status).toBe(403);
      expect(gatedEffect()).not.toHaveBeenCalled();
    }
  );
});
