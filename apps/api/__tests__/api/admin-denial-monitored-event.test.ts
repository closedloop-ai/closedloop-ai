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

// Isolation only: `settings/frustration/route.ts` also imports `withAnyAuth`
// for its ungated GET, which this suite never invokes.
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

import { log } from "@repo/observability/log";
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
import {
  drainOrgAdminDenials,
  ORG_ADMIN_GATE_DENIED_EVENT,
  OrgAdminGate,
  orgAdminDenialThrottle,
} from "@/lib/observability/admin-denial-telemetry";
import {
  EmissionRollupCause,
  FIXED_WINDOW_EMISSION_WINDOW_MS,
} from "@/lib/observability/fixed-window-emission-throttle";

mockAuthContext = createTestAuthContext({
  clerkOrgId: ADMIN_GATE_CLERK_ORG_ID,
  clerkUserId: ADMIN_GATE_CLERK_USER_ID,
});

/**
 * The `gate` / `route` / `method` each site must stamp on its emitted line,
 * keyed by the shared invocation name. This is the ONLY part of the table that
 * is specific to this suite — the requests themselves come from
 * `buildAdminGateInvocations`, so the "does the gate admit an admin" suite and
 * this "does the gate report its refusal" suite drive byte-identical requests.
 *
 * Three, not two: the organization route refuses from more than one gate, and
 * a `route`/`method` pair alone would claim route scope for gate scope.
 *
 * This table is also what makes a one-route wiring fail: implementing the event
 * on `/settings/frustration` alone leaves two of these three red.
 */
const GATE_EXPECTATIONS: Record<
  string,
  { gate: string; method: string; route: string }
> = {
  "PUT /settings/frustration": {
    gate: OrgAdminGate.FrustrationSetting,
    method: "PUT",
    route: "/settings/frustration",
  },
  "PUT /organizations/[id] (admin-only field)": {
    gate: OrgAdminGate.AdminOnlyField,
    method: "PUT",
    route: "/organizations/[id]",
  },
  "PUT /organizations/[id] (slug change)": {
    gate: OrgAdminGate.SlugChange,
    method: "PUT",
    route: "/organizations/[id]",
  },
};

const denialSites = buildAdminGateInvocations({
  putOrganization,
  putFrustration,
}).map((site) => ({ ...site, ...GATE_EXPECTATIONS[site.name] }));

function warnCalls(): [string, Record<string, unknown>][] {
  return vi.mocked(log.warn).mock.calls as unknown as [
    string,
    Record<string, unknown>,
  ][];
}

function monitoredCalls(): [string, Record<string, unknown>][] {
  return warnCalls().filter(([name]) => name === ORG_ADMIN_GATE_DENIED_EVENT);
}

describe("admin-denial monitored event (ISS-7350)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Process-level state: without this, the second case for a given
    // (org, gate, reason) would be suppressed by its predecessor's window and
    // the assertion would fail for a reason that is not the contract.
    orgAdminDenialThrottle.clear();
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

  it("pins the event name the Datadog monitor keys on", () => {
    expect(ORG_ADMIN_GATE_DENIED_EVENT).toBe("org_admin_gate_denied");
  });

  it.each(denialSites)(
    "emits the monitored event on a non-admin denial at $name",
    async ({ invoke, gate, method, route }) => {
      mocks.getOrganizationMembershipRole.mockResolvedValue(
        ClerkOrgRoleFixture.Member
      );

      const response = await invoke();

      expect(response.status).toBe(403);
      // The event name must be the log MESSAGE, not a field: the monitor
      // queries Datadog's reserved `message:` attribute, which metadata cannot
      // spoof.
      expect(monitoredCalls()).toHaveLength(1);
      const [, payload] = monitoredCalls()[0];
      expect(payload).toMatchObject({
        clerkOrgId: ADMIN_GATE_CLERK_ORG_ID,
        clerkUserId: ADMIN_GATE_CLERK_USER_ID,
        reason: "not_admin",
        gate,
        method,
        route,
      });
    }
  );

  /**
   * The over-emission guard. Without it, a `reportOrgAdminDenial` call placed
   * above the `isAdmin` branch — or one that ignores the verdict — satisfies
   * every positive case above while paging on ordinary admin traffic.
   */
  it.each(denialSites)(
    "stays silent when the caller IS an admin at $name",
    async ({ invoke }) => {
      mocks.getOrganizationMembershipRole.mockResolvedValue(
        ClerkOrgRoleFixture.Admin
      );

      const response = await invoke();

      expect(response.status).toBe(200);
      expect(monitoredCalls()).toHaveLength(0);
    }
  );

  /**
   * A Clerk outage refuses real admins. Folding that into "non-admin" would
   * make "no denials" and "the provider is down" read identically in the
   * monitored stream, so `reason` must stay separable at every gate — the same
   * property ISS-6692 pins at the route layer.
   */
  it.each(denialSites)(
    "distinguishes a provider outage from a refusal at $name",
    async ({ invoke, gate }) => {
      mocks.getOrganizationMembershipRole.mockRejectedValue(
        new Error("clerk is unreachable")
      );

      const response = await invoke();

      // ISS-8661 gave the outage its own status; the monitored `reason` this
      // case exists for is unchanged, and both must stay separable.
      expect(response.status).toBe(503);
      expect(monitoredCalls()).toHaveLength(1);
      const [, payload] = monitoredCalls()[0];
      expect(payload).toMatchObject({ gate, reason: "provider_error" });
    }
  );

  /**
   * #5508 review (whitlockk). Every other case in this suite clears the throttle in
   * `beforeEach`, so none of them can observe a key COLLISION — the suite stays
   * green with `reason` removed from `buildKey`, and a member's routine denial
   * would then suppress the first signal of a real Clerk outage at the same
   * gate. That is the failure the monitored stream exists to catch, and it is
   * the one the suite could not see.
   *
   * This case therefore deliberately does NOT reset process state between the
   * two denials: same org, same gate, one window, only `reason` differing.
   */
  it("does not let a member denial suppress a provider outage at the same gate", async () => {
    const site = denialSites[0];

    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Member
    );
    expect((await site.invoke()).status).toBe(403);

    // No `orgAdminDenialThrottle.clear()` here, on purpose.
    mocks.getOrganizationMembershipRole.mockReset();
    mocks.getOrganizationMembershipRole.mockRejectedValue(
      new Error("clerk is unreachable")
    );
    expect((await site.invoke()).status).toBe(503);

    const reasons = monitoredCalls().map(([, payload]) => payload.reason);
    expect(reasons).toEqual(["not_admin", "provider_error"]);
    for (const [, payload] of monitoredCalls()) {
      expect(payload.gate).toBe(site.gate);
    }
  });

  /**
   * The other half of that key: with `reason` in it, a REPEAT of the same
   * reason at the same gate must still be suppressed. Without this, "add
   * `reason`" and "throttle nothing at all" are indistinguishable.
   */
  it("still suppresses a repeat of the same reason at the same gate", async () => {
    const site = denialSites[0];

    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Member
    );
    await site.invoke();
    await site.invoke();

    expect(monitoredCalls()).toHaveLength(1);
  });

  /**
   * #5508 review (whitlockk): a suppressed count is materialised by an event, not a
   * clock, so before the terminal drain a burst followed by quiet left its
   * occurrences in process memory. `withAuth`'s `finally` now drains, and this
   * pins the drain's own contract — the rollup carries the suppressed total and
   * is marked `aggregated` so a query can tell it from a first occurrence.
   */
  it("drains a closed window's suppressed denials as one aggregate rollup", async () => {
    const site = denialSites[0];
    mocks.getOrganizationMembershipRole.mockResolvedValue(
      ClerkOrgRoleFixture.Member
    );

    await site.invoke();
    await site.invoke();
    await site.invoke();
    expect(monitoredCalls()).toHaveLength(1);

    // The gate is never touched again — only time passes and some other
    // request reaches the terminal path.
    drainOrgAdminDenials(Date.now() + FIXED_WINDOW_EMISSION_WINDOW_MS * 2);

    expect(monitoredCalls()).toHaveLength(2);
    const [, rollup] = monitoredCalls()[1];
    expect(rollup).toMatchObject({
      gate: site.gate,
      reason: "not_admin",
      occurrences: 2,
      aggregated: true,
      flushedBy: EmissionRollupCause.Expiry,
    });
  });

  it("keeps every gate discriminator distinct across the routes", () => {
    // `gate` is a throttle key part as well as a query facet, so two routes
    // sharing a value would silently suppress one another's first denial.
    const gates = denialSites.map((site) => site.gate);
    expect(new Set(gates).size).toBe(gates.length);
  });

  it("pins the monitored population to the three org-policy-write gates", () => {
    expect(Object.values(OrgAdminGate).sort()).toEqual(
      ["admin_only_field", "frustration_setting", "slug_change"].sort()
    );
    // Every gate in the enum must be driven by a case above, so the population
    // this suite proves and the population the monitor sees cannot diverge.
    expect(denialSites.map((site) => site.gate).sort()).toEqual(
      Object.values(OrgAdminGate).sort()
    );
  });
});
