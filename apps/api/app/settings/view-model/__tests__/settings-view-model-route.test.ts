/**
 * ISS-8378 — the Settings view-model route, end to end from the auth context to
 * the projected model.
 *
 * ONLY the Clerk client is stubbed. The route, the role service, the projection
 * and the policy table all run for real, so deleting the service call from the
 * route, or the projection call from the service, fails here — a test that
 * stubbed the service would stay green through exactly that deletion.
 *
 * The eight cases the ticket names are covered as follows: member / admin /
 * owner by the role fixtures below; cross-org and removed-member by a
 * membership lookup that settles with no membership; stale-role by a session
 * claim that disagrees with the live read; malformed-input by a provider
 * returning a role string this build does not know; partial-upstream by the
 * provider throwing.
 */
import { OrgAdminRole } from "@repo/api/src/types/org-admin-role";
import {
  SettingsActorRoleStatus,
  SettingsActorRoleUnresolvedReason,
} from "@repo/api/src/types/settings-actor-role";
import {
  SettingsDomainFailureReason,
  SettingsDomainId,
  SettingsDomainStatus,
} from "@repo/api/src/types/settings-domain";
import {
  SETTINGS_PANEL_IDS,
  SettingsActorCapabilityStatus,
  SettingsPanelCapability,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import type { SettingsViewModel } from "@repo/api/src/types/settings-view-model";
import {
  projectSettingsViewModel,
  SettingsViewModelStatus,
} from "@repo/api/src/types/settings-view-model";
import { log } from "@repo/observability/log";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  orgRole: undefined as string | undefined,
  getOrganizationMembershipRole: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getOrganizationMembershipRole: mocks.getOrganizationMembershipRole,
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(
        {
          user: mocks.user,
          clerkOrgId: "clerk-org-1",
          clerkUserId: "clerk-user-1",
          orgRole: mocks.orgRole,
        },
        request,
        context.params
      ),
}));

import { GET } from "../route";

const REQUEST_URL = "http://localhost/settings/view-model";
const UNREADABLE_ROLE_EVENT = "settings_actor_role_unreadable";

async function getViewModel(): Promise<{
  status: number;
  body: {
    success: boolean;
    data?: SettingsViewModel;
    error?: string;
    code?: string;
  };
}> {
  const response = await GET(new NextRequest(REQUEST_URL), {
    params: Promise.resolve({}),
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orgRole = undefined;
});

describe("GET /settings/view-model — the live membership read is the authority", () => {
  it("asks Clerk for the caller's membership in the caller's organization", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(OrgAdminRole.Admin);

    await getViewModel();

    // Org-scoping: the lookup is keyed on the authenticated context, never on
    // anything the request could supply.
    expect(mocks.getOrganizationMembershipRole).toHaveBeenCalledWith(
      "clerk-org-1",
      "clerk-user-1"
    );
    expect(mocks.getOrganizationMembershipRole).toHaveBeenCalledTimes(1);
  });

  it("costs one provider call INSIDE THE HANDLER for all twelve panels", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(OrgAdminRole.Owner);

    const { body } = await getViewModel();

    // The query budget that justifies this endpoint: twelve capability answers
    // from one uncached membership round-trip, not one per gated surface.
    //
    // SCOPE, because `withAnyAuth` is stubbed here: this counts the HANDLER's
    // reads, not the request's. A request whose `x-organization-id` names a
    // non-session org spends a second `getOrganizationMembershipRole` in
    // `resolveOrgHeader` before the handler runs, and no assertion on this side
    // of the wrapper can see it. See the note on `buildSettingsViewModel`.
    expect(Object.keys(body.data?.capabilities.grants ?? {})).toHaveLength(
      SETTINGS_PANEL_IDS.length
    );
    expect(mocks.getOrganizationMembershipRole).toHaveBeenCalledTimes(1);
  });
});

describe("GET /settings/view-model — member, admin, owner", () => {
  it("projects a member without the Compliance panel", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue("org:member");

    const { status, body } = await getViewModel();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.actor).toEqual({
      status: SettingsActorRoleStatus.Resolved,
      role: "member",
      staleSessionRole: false,
    });
    expect(
      body.data?.capabilities.grants?.[SettingsPanelId.Compliance]
    ).toBeUndefined();
    expect(body.data?.domains[SettingsDomainId.Compliance].status).toBe(
      SettingsDomainStatus.Forbidden
    );
  });

  it("projects an admin WITH the Compliance panel — the member denial is not universal", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(OrgAdminRole.Admin);

    const { body } = await getViewModel();

    expect(
      body.data?.capabilities.grants?.[SettingsPanelId.Compliance]
    ).toEqual([SettingsPanelCapability.Read, SettingsPanelCapability.Admin]);
    expect(body.data?.status).toBe(SettingsViewModelStatus.Ready);
  });

  it("distinguishes an owner from an admin", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(OrgAdminRole.Owner);

    const { body } = await getViewModel();

    expect(body.data?.actor).toEqual({
      status: SettingsActorRoleStatus.Resolved,
      role: "owner",
      staleSessionRole: false,
    });
    expect(body.data?.capabilities.grants?.[SettingsPanelId.Tags]).toContain(
      SettingsPanelCapability.Owner
    );
  });
});

describe("GET /settings/view-model — removed member and cross-org", () => {
  it("denies every domain when the membership lookup settles with nothing", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(null);

    const { status, body } = await getViewModel();

    expect(status).toBe(200);
    expect(body.data?.actor).toEqual({
      status: SettingsActorRoleStatus.NotAMember,
      staleSessionRole: false,
    });
    for (const domain of Object.values(SettingsDomainId)) {
      expect(body.data?.domains[domain].status).toBe(
        SettingsDomainStatus.Forbidden
      );
    }
  });

  it("answers a settled denial, NOT an error — the two carry different advice", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(null);

    const { body } = await getViewModel();

    expect(body.data?.status).toBe(SettingsViewModelStatus.Ready);
    expect(body.data?.capabilities.status).toBe(
      SettingsActorCapabilityStatus.Ready
    );
    expect(body.data?.capabilities.grants).toEqual({});
  });
});

describe("GET /settings/view-model — provider outage", () => {
  beforeEach(() => {
    mocks.getOrganizationMembershipRole.mockRejectedValue(
      new Error("clerk unreachable")
    );
  });

  it("answers 503 with a role_unresolved code, not 200 and not 403", () => {
    // 503 rather than 403 because a denial is a DECISION and this is the
    // absence of one; 503 rather than 200 because `success: true` tells every
    // generic client wrapper the payload is trustworthy, and because only a
    // 5xx reaches `request_completed`'s error-level stream — a 200 would leave
    // an outage that zeroes every actor's capabilities visible in nothing but
    // an unmonitored log line.
    return getViewModel().then(({ status, body }) => {
      expect(status).toBe(503);
      expect(body.success).toBe(false);
      expect(body.code).toBe(SettingsDomainFailureReason.RoleUnresolved);
      expect(body.data).toBeUndefined();
    });
  });

  it("is a DIFFERENT status from the settled denial a removed member gets", async () => {
    const outage = await getViewModel();
    mocks.getOrganizationMembershipRole.mockReset();
    mocks.getOrganizationMembershipRole.mockResolvedValue(null);
    const removed = await getViewModel();

    // The collapse this route exists to prevent, asserted as a difference
    // rather than as two independent constants.
    expect(outage.status).toBe(503);
    expect(removed.status).toBe(200);
    expect(removed.body.data?.domains[SettingsDomainId.Members].status).toBe(
      SettingsDomainStatus.Forbidden
    );
  });

  it("emits the diagnostic event so an outage is greppable", async () => {
    await getViewModel();

    expect(log.error).toHaveBeenCalledWith(
      UNREADABLE_ROLE_EVENT,
      expect.objectContaining({
        clerkOrgId: "clerk-org-1",
        clerkUserId: "clerk-user-1",
        reason: "provider_error",
      })
    );
  });

  it("never falls back to the session role claim during the outage", async () => {
    // The stale-grant trap in the other direction: an admin claim minted before
    // a demotion must not authorize when the live read cannot confirm it.
    mocks.orgRole = OrgAdminRole.Admin;

    const { status, body } = await getViewModel();

    expect(status).toBe(503);
    expect(body.data).toBeUndefined();
  });
});

describe("GET /settings/view-model — the projection keeps outage states distinct", () => {
  it("marks every domain role_unresolved rather than forbidden or empty", () => {
    // The route answers 503, so this pins the projection the service produced
    // before the route mapped it — the shape a non-HTTP consumer receives.
    const model = projectSettingsViewModel({
      resolution: {
        status: SettingsActorRoleStatus.Unresolved,
        reason: "provider_error",
      },
      staleSessionRole: false,
    });

    expect(model.status).toBe(SettingsViewModelStatus.Error);
    expect(model.capabilities).toEqual({
      status: SettingsActorCapabilityStatus.Error,
    });
    for (const domain of Object.values(SettingsDomainId)) {
      expect(model.domains[domain]).toEqual({
        status: SettingsDomainStatus.Error,
        grants: { read: false, edit: false, admin: false, owner: false },
        reason: SettingsDomainFailureReason.RoleUnresolved,
      });
    }
  });
});

describe("GET /settings/view-model — stale session role", () => {
  it("flags a session claim that disagrees with the live read", async () => {
    mocks.orgRole = OrgAdminRole.Admin;
    mocks.getOrganizationMembershipRole.mockResolvedValue("org:member");

    const { body } = await getViewModel();

    expect(body.data?.actor).toEqual({
      status: SettingsActorRoleStatus.Resolved,
      role: "member",
      staleSessionRole: true,
    });
  });

  it("authorizes off the LIVE role, so a stale admin claim widens nothing", async () => {
    mocks.orgRole = OrgAdminRole.Admin;
    mocks.getOrganizationMembershipRole.mockResolvedValue("org:member");

    const { body } = await getViewModel();

    expect(
      body.data?.capabilities.grants?.[SettingsPanelId.Compliance]
    ).toBeUndefined();
    expect(
      body.data?.capabilities.grants?.[SettingsPanelId.CustomFields]
    ).toEqual([SettingsPanelCapability.Read]);
  });

  it("does not flag a caller that made no claim at all", async () => {
    // An sk_live_ API key and a desktop-session token carry no orgRole. Calling
    // that "stale" would send every desktop user to a pointless re-login.
    mocks.orgRole = undefined;
    mocks.getOrganizationMembershipRole.mockResolvedValue(OrgAdminRole.Admin);

    const { body } = await getViewModel();

    expect(body.data?.actor.staleSessionRole).toBe(false);
    // and it still gets the real admin projection, not a member fallback
    expect(
      body.data?.capabilities.grants?.[SettingsPanelId.Compliance]
    ).toEqual([SettingsPanelCapability.Read, SettingsPanelCapability.Admin]);
  });

  it("does not flag a claim that agrees with the live read", async () => {
    mocks.orgRole = OrgAdminRole.Admin;
    mocks.getOrganizationMembershipRole.mockResolvedValue(OrgAdminRole.Admin);

    const { body } = await getViewModel();

    expect(body.data?.actor.staleSessionRole).toBe(false);
  });
});

describe("GET /settings/view-model — malformed provider input", () => {
  it.each([
    ["an unknown role string", "org:billing_manager"],
    ["a prototype key", "constructor"],
  ])("never widens authority for %s", async (_label, role) => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(role);

    const { status, body } = await getViewModel();

    expect(status).toBe(200);
    expect(
      body.data?.capabilities.grants?.[SettingsPanelId.Compliance]
    ).toBeUndefined();
    expect(body.data?.domains[SettingsDomainId.CustomFields].grants.admin).toBe(
      false
    );
  });

  it.each([
    ["a blank role", "   "],
    ["an empty role", ""],
  ])(
    "answers 503 for %s — a present membership with an unreadable role",
    async (_label, role) => {
      // THREE STATES, NOT TWO. `null` is the only value that means "no
      // membership"; a present row whose role is unusable is corrupt provider
      // data, and answering the removed-member 200 for it tells a real member
      // they were removed from their organization during a provider fault.
      mocks.getOrganizationMembershipRole.mockResolvedValue(role);

      const { status, body } = await getViewModel();

      expect(status).toBe(503);
      expect(body.code).toBe(SettingsDomainFailureReason.RoleUnresolved);
      expect(body.data).toBeUndefined();
      expect(log.error).toHaveBeenCalledWith(
        UNREADABLE_ROLE_EVENT,
        expect.objectContaining({
          reason: SettingsActorRoleUnresolvedReason.MalformedRole,
        })
      );
    }
  );

  it("keeps the removed-member 200 distinct from the blank-role 503", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(null);
    const removed = await getViewModel();
    mocks.getOrganizationMembershipRole.mockResolvedValue("   ");
    const malformed = await getViewModel();

    expect(removed.status).toBe(200);
    expect(removed.body.data?.actor.status).toBe(
      SettingsActorRoleStatus.NotAMember
    );
    expect(malformed.status).toBe(503);
  });

  it("still admits a well-formed admin, so the assertions above are not vacuous", async () => {
    mocks.getOrganizationMembershipRole.mockResolvedValue(OrgAdminRole.Admin);

    const { body } = await getViewModel();

    expect(body.data?.domains[SettingsDomainId.CustomFields].grants.admin).toBe(
      true
    );
  });
});
