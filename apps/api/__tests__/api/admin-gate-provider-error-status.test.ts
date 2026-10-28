/**
 * ISS-8661 — every admin gate tells an UNRESOLVED role apart from a REFUSED one.
 *
 * `getOrgAdminStatus` has always distinguished them, but every gate answered
 * 403 for both, so a Clerk outage told the caller they lack permission when the
 * truth was that nobody could check. This suite pins the split across every
 * gate that answers with a Response at once, because a fix applied to one route
 * and not its siblings is the drift the ticket names.
 *
 * SCOPE. The three `distributions` gates are NOT here: they answer with a
 * `Result<_, StatusCode>` a route maps later, so they need a different harness
 * and are pinned in `app/distributions/__tests__/{service,withdraw}.test.ts`
 * (the code is produced) plus `__tests__/api/distributions.test.ts` (the route
 * does not flatten it back to a 403).
 *
 * The Clerk client is stubbed and the REAL `org-admin` module runs behind each
 * REAL route handler: stubbing the gate itself cannot exercise the split,
 * because the throw has to originate at the provider call.
 *
 * Both halves are asserted per gate. The 503 alone would also pass if a gate
 * answered 503 for everything, and the 403 alone would also pass if the fix had
 * never landed.
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
} from "@/__tests__/utils/auth-helpers";
import { PUT as putOrganization } from "@/app/organizations/[id]/route";
import { PUT as putFrustration } from "@/app/settings/frustration/route";

mockAuthContext = createTestAuthContext({
  clerkOrgId: ADMIN_GATE_CLERK_ORG_ID,
  clerkUserId: ADMIN_GATE_CLERK_USER_ID,
});

/**
 * The wire code, written out rather than imported from
 * `@/lib/auth/org-admin-denial`. This suite is the ORACLE for that value: a
 * fixture that reads the constant it polices follows it silently when the
 * string is changed or the member deleted, and so cannot fail on the change it
 * exists to catch.
 */
const ROLE_UNRESOLVED_WIRE_CODE = "role_unresolved";

type AdminGate = {
  name: string;
  invoke: () => Promise<Response>;
  /** The privileged work behind the gate. Must not run on either outcome. */
  gatedEffect: () => ReturnType<typeof vi.fn>;
};

/**
 * The gated work behind each shared org-policy-write invocation, keyed by the
 * invocation name `buildAdminGateInvocations` gives it.
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
  }).map(({ name, invoke }) => ({
    name,
    invoke,
    gatedEffect: SHARED_GATE_EFFECTS[name],
  })),
];

describe("admin-gated routes — unresolved role is not a denial", () => {
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

  it.each(adminGates)(
    "answers 503 role_unresolved, never 403, when Clerk throws on $name",
    async ({ invoke, gatedEffect }) => {
      mocks.getOrganizationMembershipRole.mockRejectedValue(
        new Error("clerk unreachable")
      );

      const response = await invoke();

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        code: ROLE_UNRESOLVED_WIRE_CODE,
      });
      // Still fail-CLOSED. Without this the suite passes for a gate that ran the
      // privileged work and then reported 503, which is worse than the 403 this
      // replaces — the status assertions alone cannot see it.
      expect(gatedEffect()).not.toHaveBeenCalled();
    }
  );

  // The paired half: without it, a gate that answered 503 unconditionally would
  // pass the case above while having lost the denial it exists to make.
  it.each(adminGates)(
    "keeps 403 for a resolved unprivileged role on $name",
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
