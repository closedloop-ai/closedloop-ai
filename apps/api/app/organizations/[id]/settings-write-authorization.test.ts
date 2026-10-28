/**
 * ISS-7121 — pins the authorization of the `settings` field on
 * `PUT /organizations/[id]`, and the route's verbatim forwarding of it.
 *
 * BEHAVIOUR CHANGE, recorded deliberately. This suite previously pinned
 * `settings` as writable by ANY member, which was the correct pin at the time:
 * it captured a real exposure and left the product question open. The operator
 * (Marisol) decided that question on 2026-08-19 — "ISS-7121, limit it to admin
 * only" — so the four non-admin cases that asserted 200 now assert 403. The
 * expectation moved because the decision moved, not to make a red suite green.
 *
 * The operator answered the AUTHORIZATION question only. Replace-vs-merge was
 * NOT decided and is NOT changed: an admin write still replaces the whole
 * column. The admin-driven forwarding case below keeps that pinned rather than
 * letting the contract lapse with the non-admin case that used to carry it.
 *
 * Scope, stated so this suite is not read as more than it is: the service layer
 * is mocked here, so replace-vs-merge PERSISTENCE is not observable and is not
 * pinned by this file — `__tests__/integration/iss7121-organization-settings-
 * replace.integration.test.ts` owns that. What this file pins is which callers
 * the route admits, and that it hands the admitted caller's object to the
 * service untouched.
 *
 * The fixtures are chosen so that they can actually fail:
 *
 * - The refusal cases are driven by a NON-ADMIN member (`getOrgAdminStatus` →
 *   not_admin),
 *   and each asserts the write never reached persistence — a 403 that still
 *   wrote would pass a status-only assertion.
 * - The ADMIN cases are the over-gating guard. A gate that refused everyone
 *   would satisfy every refusal case above; these fail if `settings` becomes
 *   unwritable.
 * - The forwarding case sends a body whose `settings` OMITS a key the stored
 *   blob already has, which is the shape that tells a route-level merge from a
 *   passthrough. It says nothing about what the service then persists.
 */
import { SESSION_FRUSTRATION_SETTING_KEY } from "@repo/api/src/types/settings";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    authMethod: "session",
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    user: {
      id: "user-1",
      clerkId: "clerk-user-1",
      organizationId: "org-1",
    },
  },
  clerkUpdateOrganization: vi.fn(),
  getOrgAdminStatus: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  organizationsService: {
    findById: vi.fn(),
    findBySlug: vi.fn(),
    findDetailById: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<{ id: string }> }) =>
      handler(mocks.authContext, request, context.params),
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    updateOrganization: mocks.clerkUpdateOrganization,
  },
}));

vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: mocks.getOrgAdminStatus,
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: mocks.logError,
    // This suite REPLACES `withAuth`, so it never reaches the terminal flush.
    // Flush behaviour is pinned in `./admin-denial-flush.test.ts`, which runs
    // the real wrapper; asserting on it here could only ever be vacuous.
    flush: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
    warn: mocks.logWarn,
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("../service", () => ({
  organizationsService: mocks.organizationsService,
}));

import { orgAdminDenialThrottle } from "@/lib/observability/admin-denial-telemetry";
import { PUT } from "./route";

const ORG_ID = "org-1";
/**
 * Settings keys written as independent literals on purpose. Importing the
 * canonical key constants here would make this suite pass by construction if
 * one of them were deleted — the whole point is an expectation that does not
 * move when the code under test moves.
 */
const STORED_SETTINGS = {
  calculateSessionFrustration: true,
  maxConcurrentLoops: 25,
};
const PARTIAL_SETTINGS_BODY = { maxConcurrentLoops: 25 };
const BASE_ORGANIZATION = {
  active: true,
  clerkId: "clerk-org-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  id: ORG_ID,
  name: "Acme",
  searchIncludeTranscripts: false,
  settings: STORED_SETTINGS,
  slug: "acme",
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("PUT /organizations/[id] settings authorization (ISS-7121)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authContext.user.organizationId = ORG_ID;
    mocks.organizationsService.findById.mockResolvedValue(BASE_ORGANIZATION);
    mocks.organizationsService.findDetailById.mockResolvedValue(
      BASE_ORGANIZATION
    );
    mocks.organizationsService.findBySlug.mockResolvedValue(null);
    mocks.organizationsService.update.mockResolvedValue(BASE_ORGANIZATION);
    // Non-admin by default: the refusal cases are what the finding turns on,
    // and a case driven by an admin would pass under every candidate design.
    // The nested `admin caller` block overrides this to prove the gate did not
    // simply refuse everyone.
    // ISS-7200 moved the gate onto `getOrgAdminStatus` for its `reason`; the
    // expectation is unchanged, so the assertions just follow the helper.
    mocks.getOrgAdminStatus.mockResolvedValue({
      isAdmin: false,
      reason: "not_admin",
    });
    mocks.clerkUpdateOrganization.mockResolvedValue({ id: "clerk-org-1" });
  });

  it("refuses a settings write from a non-admin member", async () => {
    const response = await putOrganization({ settings: PARTIAL_SETTINGS_BODY });

    expect(response.status).toBe(403);
    // The check is asked, and asked about the CALLER's org and user — not the
    // org the request named. Sourcing it from the row would answer the wrong
    // question.
    expect(mocks.getOrgAdminStatus).toHaveBeenCalledWith(
      "clerk-org-1",
      "clerk-user-1"
    );
    // Refused BEFORE persistence. A 403 returned after the write landed would
    // still satisfy a status-only assertion, so this is the load-bearing half.
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
  });

  it("refuses the same non-admin member on the admin-gated privacy toggle", async () => {
    const response = await putOrganization({ searchIncludeTranscripts: true });

    // Unchanged by ISS-7121, and kept as the guard that the gate this field
    // already had was not disturbed while `settings` was added behind it.
    expect(response.status).toBe(403);
    expect(mocks.getOrgAdminStatus).toHaveBeenCalledWith(
      "clerk-org-1",
      "clerk-user-1"
    );
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
  });

  it("refuses a non-admin on the key that PUT /settings/frustration admin-gates", async () => {
    // The SET direction. This is the SAME persisted key that
    // `PUT /settings/frustration` refuses to let a non-admin write (that route
    // checks `getOrgAdminStatus` and logs the denial). Imported from its
    // canonical constant on purpose — the assertion IS that the two routes
    // converge on one key, so a rename that split them must fail this. Before
    // ISS-7121 the two routes disagreed about who could write it; they now
    // agree.
    const response = await putOrganization({
      settings: { [SESSION_FRUSTRATION_SETTING_KEY]: true },
    });

    expect(response.status).toBe(403);
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
  });

  it("refuses a non-admin settings write that would empty the blob entirely", async () => {
    const response = await putOrganization({ settings: {} });

    // An empty object is a present value, not an absent one: `{}` REPLACES the
    // stored blob with nothing, so it is the most destructive shape a member
    // could send and must be gated like any other.
    expect(response.status).toBe(403);
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
  });

  describe("admin caller", () => {
    beforeEach(() => {
      mocks.getOrgAdminStatus.mockResolvedValue({
        isAdmin: true,
        reason: "admin",
      });
    });

    it("still accepts a settings write from an org admin", async () => {
      const response = await putOrganization({
        settings: PARTIAL_SETTINGS_BODY,
      });
      const body = await response.json();

      // The over-gating guard. If this goes red the gate refuses everyone, and
      // every refusal case above would still pass.
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mocks.organizationsService.update).toHaveBeenCalledWith(ORG_ID, {
        settings: PARTIAL_SETTINGS_BODY,
      });
    });

    it("forwards the admin's settings object verbatim, without merging the stored blob", async () => {
      const response = await putOrganization({
        settings: PARTIAL_SETTINGS_BODY,
      });

      // Replace-vs-merge is UNCHANGED by ISS-7121 — the operator decided
      // authorization only. This case previously rode on a non-admin caller;
      // it is re-driven by an admin so the contract keeps its coverage instead
      // of lapsing with the caller that used to carry it.
      expect(response.status).toBe(200);
      // The stored blob has two keys; the body has one. What reaches the
      // service layer is the body's object alone, so the omitted key is not
      // carried forward AT THE ROUTE. A merge implemented in the route would
      // fail this; a merge implemented in the service would not, and is pinned
      // elsewhere.
      const [, updateInput] = mocks.organizationsService.update.mock.calls[0];
      expect(updateInput.settings).toEqual(PARTIAL_SETTINGS_BODY);
      // `findDetailById` (the payload read) stays untouched. Note the gate's
      // own `findById` DOES now read the row on this branch, so the route has a
      // merge source in hand where previously it had none — the structural
      // argument is weaker than it was, and the exact-key assertion above is
      // what actually catches a merge.
      expect(mocks.organizationsService.findDetailById).not.toHaveBeenCalled();
    });

    it("forwards an empty settings object verbatim rather than treating it as absent", async () => {
      const response = await putOrganization({ settings: {} });

      // Restores, under an admin caller, the route-level pin the non-admin
      // empty-blob case used to carry. Without it the surviving mutation is a
      // route that special-cases `{}` as "absent" and strips it: every 403 case
      // still passes (the gate keys on `!== undefined` and runs before any
      // strip), and every other admin case sends a NON-empty object. The
      // service-level suite cannot see this either — it calls the service
      // directly, below the route, and is DATABASE_URL-gated.
      expect(response.status).toBe(200);
      expect(mocks.organizationsService.update).toHaveBeenCalledWith(ORG_ID, {
        settings: {},
      });
    });
  });
});

/**
 * ISS-7200 — the denial must be OBSERVABLE. The false-green to avoid is
 * asserting a 403: that passed with zero telemetry, which IS the defect, so
 * every case asserts on the emitted record. The two silence cases keep the
 * rest honest — a `log.warn` above the `isAdmin` branch would satisfy every
 * positive assertion here.
 */
describe("PUT /organizations/[id] admin-denial telemetry (ISS-7200)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The throttle is module-level process state, so without this each case
    // after the first would be suppressed by its predecessor's window.
    orgAdminDenialThrottle.clear();
    mocks.authContext.user.organizationId = ORG_ID;
    mocks.organizationsService.findById.mockResolvedValue(BASE_ORGANIZATION);
    mocks.organizationsService.findDetailById.mockResolvedValue(
      BASE_ORGANIZATION
    );
    mocks.organizationsService.findBySlug.mockResolvedValue(null);
    mocks.organizationsService.update.mockResolvedValue(BASE_ORGANIZATION);
    mocks.getOrgAdminStatus.mockResolvedValue({
      isAdmin: false,
      reason: "not_admin",
    });
    mocks.clerkUpdateOrganization.mockResolvedValue({ id: "clerk-org-1" });
  });

  it("emits a denial signal carrying the sibling route's fields", async () => {
    const response = await putOrganization({ settings: PARTIAL_SETTINGS_BODY });

    expect(response.status).toBe(403);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    const [, payload] = mocks.logWarn.mock.calls[0];
    // `method`/`route` are what make one line attributable in a shared stream.
    expect(payload).toMatchObject({
      clerkOrgId: "clerk-org-1",
      clerkUserId: "clerk-user-1",
      reason: "not_admin",
      method: "PUT",
      route: "/organizations/[id]",
      gate: "admin_only_field",
    });
  });

  it("tags the OTHER admin gate on this route distinctly", async () => {
    mocks.organizationsService.findDetailById.mockResolvedValue({
      ...BASE_ORGANIZATION,
      slug: "acme",
    });

    const response = await putOrganization({ slug: "renamed-acme" });

    // `route`/`method` alone would claim route scope for gate scope: this route
    // refuses from more than one admin gate, so without a discriminator a query
    // that saw no line could not tell "no denial" from "a gate that is silent".
    expect(response.status).toBe(403);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    const [, payload] = mocks.logWarn.mock.calls[0];
    expect(payload.gate).toBe("slug_change");
    expect(payload.fields).toEqual(["slug"]);
  });

  it("names the attempted field, so a refused policy-blob write is distinguishable", async () => {
    await putOrganization({ settings: PARTIAL_SETTINGS_BODY });

    const [, payload] = mocks.logWarn.mock.calls[0];
    // Without WHICH, a refused policy blob reads like a refused toggle.
    expect(payload.fields).toEqual(["settings"]);
  });

  it("carries the denied VALUE nowhere in the record", async () => {
    await putOrganization({ settings: { maxConcurrentLoops: 4321 } });

    // Load-bearing: without it this passes when NOTHING is logged.
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.logWarn.mock.calls[0])).not.toContain("4321");
  });

  // ISS-11449 removed a third row, `sessionSyncPolicyEnabled`, with the org
  // session-sync policy itself. `ADMIN_ONLY_ORGANIZATION_FIELDS` is now exactly
  // these two, and this table is the inventory of it.
  it.each([
    { field: "searchIncludeTranscripts", value: true },
    { field: "settings", value: { maxConcurrentLoops: 7 } },
  ])(
    "emits the denial for the gated field $field, not only for settings",
    async ({ field, value }) => {
      // A fix wired only to `settings` passes the cases above, fails the other.
      const response = await putOrganization({ [field]: value });

      expect(response.status).toBe(403);
      expect(mocks.logWarn).toHaveBeenCalledTimes(1);
      const [, payload] = mocks.logWarn.mock.calls[0];
      expect(payload.fields).toEqual([field]);
    }
  );

  it("reports the resolved denial reason rather than a fixed string", async () => {
    // Clerk failed, so the caller may well BE an admin.
    mocks.getOrgAdminStatus.mockResolvedValue({
      isAdmin: false,
      reason: "provider_error",
    });

    await putOrganization({ settings: PARTIAL_SETTINGS_BODY });

    const [, payload] = mocks.logWarn.mock.calls[0];
    expect(payload.reason).toBe("provider_error");
  });

  /**
   * #5485 review (whitlockk): `provider_error` means the role was never RESOLVED,
   * so a message asserting non-admin activity reports a Clerk outage as a
   * confirmed fact about the caller. The message must state only what the gate
   * knows; `reason` carries which of the two states it was.
   */
  it.each([{ reason: "not_admin" }, { reason: "provider_error" }])(
    "never asserts non-admin activity in the message, on reason $reason",
    async ({ reason }) => {
      mocks.getOrgAdminStatus.mockResolvedValue({ isAdmin: false, reason });

      await putOrganization({ settings: PARTIAL_SETTINGS_BODY });

      const [message, payload] = mocks.logWarn.mock.calls[0];
      // Goes red on the old "…for non-admin user" wording, for BOTH reasons.
      expect(message).not.toContain("non-admin");
      expect(payload.reason).toBe(reason);
    }
  );

  it("keeps emitting on a provider outage, not only on a confirmed non-admin", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue({
      isAdmin: false,
      reason: "provider_error",
    });

    const response = await putOrganization({ settings: PARTIAL_SETTINGS_BODY });

    // The remedy NOT taken: gating the emission on `not_admin` would leave a
    // Clerk outage refusing real admins with no record, so "no denials" and
    // "the provider is down" would read identically. ISS-8661 then gave the
    // outage its own status; the emission contract this case pins is unchanged.
    expect(response.status).toBe(503);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the admin caller is allowed through", async () => {
    mocks.getOrgAdminStatus.mockResolvedValue({
      isAdmin: true,
      reason: "admin",
    });

    const response = await putOrganization({ settings: PARTIAL_SETTINGS_BODY });

    // The counterfactual for every case above.
    expect(response.status).toBe(200);
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it("stays silent on a body that names no admin-only field", async () => {
    const response = await putOrganization({ name: "Renamed" });

    // The ungated member path: the gate returns before its row read.
    expect(response.status).toBe(200);
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.getOrgAdminStatus).not.toHaveBeenCalled();
  });
});

/**
 * #5485 review (whitlockk): an authenticated member can drive one denial per
 * request here and `withAuth` bounds neither, so an unbounded `log.warn` at
 * this gate is a log stream a member can open at will — the amplification
 * vector `apps/api/AGENTS.md` ("Emission and Abuse Control") forbids.
 *
 * What each case has to be able to fail for: emission is bounded, refusal is
 * NOT (a throttle that changed who gets a 403 would be a far worse bug than
 * the one it fixes), and nothing suppressed is dropped from the count.
 */
describe("PUT /organizations/[id] admin-denial emission bounds (#5485)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00Z"));
    vi.clearAllMocks();
    orgAdminDenialThrottle.clear();
    mocks.authContext.user.organizationId = ORG_ID;
    mocks.organizationsService.findById.mockResolvedValue(BASE_ORGANIZATION);
    mocks.organizationsService.findDetailById.mockResolvedValue(
      BASE_ORGANIZATION
    );
    mocks.organizationsService.findBySlug.mockResolvedValue(null);
    mocks.organizationsService.update.mockResolvedValue(BASE_ORGANIZATION);
    mocks.getOrgAdminStatus.mockResolvedValue({
      isAdmin: false,
      reason: "not_admin",
    });
    mocks.clerkUpdateOrganization.mockResolvedValue({ id: "clerk-org-1" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits one line however many times the member replays the denial", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await putOrganization({ settings: PARTIAL_SETTINGS_BODY });
    }

    // Goes red the moment the emission is taken back out of the throttle.
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
  });

  it("still refuses every replayed request the emission suppressed", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await putOrganization({
        settings: PARTIAL_SETTINGS_BODY,
      });
      statuses.push(response.status);
    }

    // The bound is on the OBSERVATION, never on the decision being observed.
    expect(statuses).toEqual([403, 403, 403, 403, 403]);
    expect(mocks.organizationsService.update).not.toHaveBeenCalled();
  });

  it("rolls the suppressed denials up when the next window opens", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await putOrganization({ settings: PARTIAL_SETTINGS_BODY });
    }
    vi.setSystemTime(new Date("2026-08-20T00:05:00Z"));

    await putOrganization({ settings: PARTIAL_SETTINGS_BODY });

    // A throttle that dropped what it suppressed would report 2 lines totalling
    // 2 occurrences for 4 denials; the rollup keeps `sum(occurrences)` honest.
    const rollup = mocks.logWarn.mock.calls.find(
      ([, payload]) => payload.aggregated === true
    );
    expect(rollup).toBeDefined();
    expect(rollup?.[1]).toMatchObject({
      occurrences: 2,
      flushedBy: "window",
      gate: "admin_only_field",
      reason: "not_admin",
    });
    const total = mocks.logWarn.mock.calls.reduce(
      (sum, [, payload]) => sum + (payload.occurrences as number),
      0
    );
    expect(total).toBe(4);
  });

  it("keys the budget per gate, so one spent gate cannot silence the other", async () => {
    await putOrganization({ settings: PARTIAL_SETTINGS_BODY });
    mocks.logWarn.mockClear();

    const response = await putOrganization({ slug: "renamed-acme" });

    // A key without `gate` would suppress this second, different denial.
    expect(response.status).toBe(403);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({
      gate: "slug_change",
    });
  });

  it("keys the budget per org, so one org cannot silence another", async () => {
    await putOrganization({ settings: PARTIAL_SETTINGS_BODY });
    mocks.logWarn.mockClear();
    mocks.authContext.clerkOrgId = "clerk-org-2";

    try {
      await putOrganization({ settings: PARTIAL_SETTINGS_BODY });

      expect(mocks.logWarn).toHaveBeenCalledTimes(1);
      expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({
        clerkOrgId: "clerk-org-2",
      });
    } finally {
      mocks.authContext.clerkOrgId = "clerk-org-1";
    }
  });
});

function putOrganization(body: Record<string, unknown>): Promise<Response> {
  const request = new NextRequest(
    `http://localhost:3002/organizations/${ORG_ID}`,
    {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }
  );
  return PUT(request, { params: Promise.resolve({ id: ORG_ID }) });
}
