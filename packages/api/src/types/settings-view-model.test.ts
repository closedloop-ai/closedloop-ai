import { describe, expect, it } from "vitest";
import {
  resolveSettingsActorRole,
  SettingsActorRole,
  SettingsActorRoleStatus,
  SettingsActorRoleUnresolvedReason,
} from "./settings-actor-role.ts";
import {
  SettingsDomainFailureReason,
  SettingsDomainId,
  SettingsDomainStatus,
} from "./settings-domain.ts";
import {
  SettingsActorCapabilityStatus,
  SettingsPanelCapability,
  SettingsPanelId,
} from "./settings-panel.ts";
import {
  projectSettingsViewModel,
  SettingsViewModelStatus,
} from "./settings-view-model.ts";

/**
 * Expectations here are written as INDEPENDENT LITERALS, never derived from
 * `SETTINGS_DOMAIN_ACCESS_POLICY`. Building them from the table the projection
 * reads would make the test a restatement of the implementation: deleting a
 * capability would change both sides together and nothing would go red. Each
 * capability list below was read off the `apps/api` route gate it mirrors, so
 * these assertions fail if either the policy or the gate it mirrors moves.
 */

const resolved = (role: SettingsActorRole) =>
  ({ status: SettingsActorRoleStatus.Resolved, role }) as const;

const READ = SettingsPanelCapability.Read;
const EDIT = SettingsPanelCapability.Edit;
const ADMIN = SettingsPanelCapability.Admin;
const OWNER = SettingsPanelCapability.Owner;

describe("projectSettingsViewModel — member", () => {
  const model = projectSettingsViewModel({
    resolution: resolved(SettingsActorRole.Member),
    staleSessionRole: false,
  });

  it("grants a member every read except Compliance, whose read is admin-gated", () => {
    expect(model.capabilities).toEqual({
      status: SettingsActorCapabilityStatus.Ready,
      grants: {
        [SettingsPanelId.Profile]: [READ, EDIT],
        [SettingsPanelId.ConnectedDevices]: [READ, EDIT],
        [SettingsPanelId.Plugins]: [READ, EDIT],
        [SettingsPanelId.OrganizationGeneral]: [READ, EDIT],
        [SettingsPanelId.Members]: [READ],
        [SettingsPanelId.CustomFields]: [READ],
        [SettingsPanelId.Tags]: [READ, EDIT],
        [SettingsPanelId.ApiKeys]: [READ, EDIT],
        [SettingsPanelId.DesktopApp]: [READ, EDIT],
        [SettingsPanelId.OtherLabs]: [READ],
      },
    });
  });

  it("omits Compliance from grants entirely and marks the domain forbidden", () => {
    expect(
      model.capabilities.grants?.[SettingsPanelId.Compliance]
    ).toBeUndefined();
    expect(model.domains[SettingsDomainId.Compliance]).toEqual({
      status: SettingsDomainStatus.Forbidden,
      grants: { read: false, edit: false, admin: false, owner: false },
    });
  });

  it("separates read from edit — Members is readable and not editable", () => {
    expect(model.domains[SettingsDomainId.Members]).toEqual({
      status: SettingsDomainStatus.Ready,
      grants: { read: true, edit: false, admin: false, owner: false },
    });
  });

  it("is ready overall, with no capability error and no stale-role flag", () => {
    expect(model.status).toBe(SettingsViewModelStatus.Ready);
    expect(model.actor).toEqual({
      status: SettingsActorRoleStatus.Resolved,
      role: SettingsActorRole.Member,
      staleSessionRole: false,
    });
  });
});

describe("projectSettingsViewModel — admin", () => {
  const model = projectSettingsViewModel({
    resolution: resolved(SettingsActorRole.Admin),
    staleSessionRole: false,
  });

  it("adds edit and admin where the route gates admit an admin", () => {
    expect(model.capabilities).toEqual({
      status: SettingsActorCapabilityStatus.Ready,
      grants: {
        [SettingsPanelId.Profile]: [READ, EDIT, ADMIN],
        [SettingsPanelId.ConnectedDevices]: [READ, EDIT, ADMIN],
        [SettingsPanelId.Plugins]: [READ, EDIT, ADMIN],
        [SettingsPanelId.OrganizationGeneral]: [READ, EDIT, ADMIN],
        [SettingsPanelId.Members]: [READ, EDIT, ADMIN],
        [SettingsPanelId.CustomFields]: [READ, EDIT, ADMIN],
        [SettingsPanelId.Tags]: [READ, EDIT, ADMIN],
        [SettingsPanelId.Compliance]: [READ, ADMIN],
        [SettingsPanelId.ApiKeys]: [READ, EDIT, ADMIN],
        [SettingsPanelId.DesktopApp]: [READ, EDIT, ADMIN],
        [SettingsPanelId.OtherLabs]: [READ, EDIT, ADMIN],
      },
    });
  });

  it("never grants edit on Compliance, which accepts no mutation from any role", () => {
    expect(model.domains[SettingsDomainId.Compliance]).toEqual({
      status: SettingsDomainStatus.Ready,
      grants: { read: true, edit: false, admin: true, owner: false },
    });
  });

  it("withholds the owner rung from an admin", () => {
    for (const held of Object.values(model.capabilities.grants ?? {})) {
      expect(held).not.toContain(OWNER);
    }
  });
});

describe("projectSettingsViewModel — owner", () => {
  const model = projectSettingsViewModel({
    resolution: resolved(SettingsActorRole.Owner),
    staleSessionRole: false,
  });

  it("adds the owner rung on top of everything an admin holds", () => {
    expect(model.capabilities).toEqual({
      status: SettingsActorCapabilityStatus.Ready,
      grants: {
        [SettingsPanelId.Profile]: [READ, EDIT, ADMIN, OWNER],
        [SettingsPanelId.ConnectedDevices]: [READ, EDIT, ADMIN, OWNER],
        [SettingsPanelId.Plugins]: [READ, EDIT, ADMIN, OWNER],
        [SettingsPanelId.OrganizationGeneral]: [READ, EDIT, ADMIN, OWNER],
        [SettingsPanelId.Members]: [READ, EDIT, ADMIN, OWNER],
        [SettingsPanelId.CustomFields]: [READ, EDIT, ADMIN, OWNER],
        [SettingsPanelId.Tags]: [READ, EDIT, ADMIN, OWNER],
        [SettingsPanelId.Compliance]: [READ, ADMIN, OWNER],
        [SettingsPanelId.ApiKeys]: [READ, EDIT, ADMIN, OWNER],
        [SettingsPanelId.DesktopApp]: [READ, EDIT, ADMIN, OWNER],
        [SettingsPanelId.OtherLabs]: [READ, EDIT, ADMIN, OWNER],
      },
    });
  });

  it("is a strict superset of the admin projection", () => {
    const admin = projectSettingsViewModel({
      resolution: resolved(SettingsActorRole.Admin),
      staleSessionRole: false,
    });
    for (const panelId of Object.keys(
      admin.capabilities.grants ?? {}
    ) as SettingsPanelId[]) {
      expect(model.capabilities.grants?.[panelId]).toEqual(
        expect.arrayContaining([
          ...(admin.capabilities.grants?.[panelId] ?? []),
        ])
      );
    }
  });
});

describe("projectSettingsViewModel — removed member and cross-org", () => {
  // Both reach this projection identically: the membership lookup SETTLED and
  // found nothing. The distinction between them is which organization was
  // asked about, which is the route's org-scoping, not this layer's.
  const model = projectSettingsViewModel({
    resolution: { status: SettingsActorRoleStatus.NotAMember },
    staleSessionRole: false,
  });

  it("denies every domain, as a settled answer rather than an error", () => {
    for (const domain of Object.values(SettingsDomainId)) {
      expect(model.domains[domain]).toEqual({
        status: SettingsDomainStatus.Forbidden,
        grants: { read: false, edit: false, admin: false, owner: false },
      });
    }
  });

  it("reports capabilities as READY with no grants, never as an error", () => {
    // The difference that matters: a removed member gets a definitive "no",
    // and ISS-8362's resolver renders that as `forbidden`. Reporting `error`
    // here would render a retry affordance for a state that will never change.
    expect(model.capabilities).toEqual({
      status: SettingsActorCapabilityStatus.Ready,
      grants: {},
    });
    expect(model.status).toBe(SettingsViewModelStatus.Ready);
  });

  it("is distinguishable from an unresolved role, which is NOT ready", () => {
    const unresolved = projectSettingsViewModel({
      resolution: {
        status: SettingsActorRoleStatus.Unresolved,
        reason: SettingsActorRoleUnresolvedReason.ProviderError,
      },
      staleSessionRole: false,
    });
    expect(unresolved.status).not.toBe(model.status);
    expect(unresolved.domains[SettingsDomainId.Members].status).not.toBe(
      model.domains[SettingsDomainId.Members].status
    );
  });
});

describe("projectSettingsViewModel — unresolved role (provider outage)", () => {
  const model = projectSettingsViewModel({
    resolution: {
      status: SettingsActorRoleStatus.Unresolved,
      reason: SettingsActorRoleUnresolvedReason.ProviderError,
    },
    staleSessionRole: false,
  });

  it("reports every domain as an ERROR carrying role_unresolved, not a denial", () => {
    for (const domain of Object.values(SettingsDomainId)) {
      expect(model.domains[domain]).toEqual({
        status: SettingsDomainStatus.Error,
        grants: { read: false, edit: false, admin: false, owner: false },
        reason: SettingsDomainFailureReason.RoleUnresolved,
      });
    }
  });

  it("reports capabilities as ERROR with no grants key at all", () => {
    expect(model.capabilities).toEqual({
      status: SettingsActorCapabilityStatus.Error,
    });
    expect(model.status).toBe(SettingsViewModelStatus.Error);
  });

  it("does not hand an admin-shaped grant to an unreadable actor", () => {
    // The collapse this whole module exists to prevent, asserted in both
    // directions: the outage must not authorize, and it must not deny either.
    expect(model.capabilities.grants).toBeUndefined();
    expect(model.domains[SettingsDomainId.Organization].status).not.toBe(
      SettingsDomainStatus.Forbidden
    );
    expect(model.domains[SettingsDomainId.Organization].status).not.toBe(
      SettingsDomainStatus.Ready
    );
  });
});

describe("projectSettingsViewModel — stale session role", () => {
  it("reports the disagreement without letting it change any capability", () => {
    const fresh = projectSettingsViewModel({
      resolution: resolved(SettingsActorRole.Member),
      staleSessionRole: false,
    });
    const stale = projectSettingsViewModel({
      resolution: resolved(SettingsActorRole.Member),
      staleSessionRole: true,
    });

    expect(stale.actor).toEqual({
      status: SettingsActorRoleStatus.Resolved,
      role: SettingsActorRole.Member,
      staleSessionRole: true,
    });
    // The live role is authoritative: a stale claim of "admin" must not widen
    // anything, so the two projections differ ONLY in the flag.
    expect(stale.capabilities).toEqual(fresh.capabilities);
    expect(stale.domains).toEqual(fresh.domains);
  });
});

describe("projectSettingsViewModel — partial upstream", () => {
  const model = projectSettingsViewModel({
    resolution: resolved(SettingsActorRole.Admin),
    staleSessionRole: false,
    unreadableDomains: [SettingsDomainId.Tags],
  });

  it("marks only the unreadable domain as an error and keeps the rest ready", () => {
    expect(model.domains[SettingsDomainId.Tags]).toEqual({
      status: SettingsDomainStatus.Error,
      grants: { read: false, edit: false, admin: false, owner: false },
      reason: SettingsDomainFailureReason.UpstreamUnavailable,
    });
    expect(model.domains[SettingsDomainId.Members].status).toBe(
      SettingsDomainStatus.Ready
    );
  });

  it("is PARTIAL — neither a working surface nor a broken one", () => {
    expect(model.status).toBe(SettingsViewModelStatus.Partial);
  });

  it("lists the panel as unreadable rather than dropping it from grants silently", () => {
    // Dropping it would be indistinguishable from a denial, and ISS-8362's
    // navigation model omits denied panels — so the row would vanish and a
    // failed read would read as "this does not exist for you".
    expect(model.capabilities.unreadable).toEqual([SettingsPanelId.Tags]);
    expect(model.capabilities.grants?.[SettingsPanelId.Tags]).toBeUndefined();
    expect(model.capabilities.status).toBe(SettingsActorCapabilityStatus.Ready);
  });

  it("does not report unreadable on a fully-readable projection", () => {
    const whole = projectSettingsViewModel({
      resolution: resolved(SettingsActorRole.Admin),
      staleSessionRole: false,
    });
    expect(whole.capabilities.unreadable).toBeUndefined();
    expect(whole.status).toBe(SettingsViewModelStatus.Ready);
  });
});

describe("projectSettingsViewModel — unavailable host", () => {
  it("keeps unavailable distinct from forbidden, preserving the actor's grants", () => {
    const model = projectSettingsViewModel({
      resolution: resolved(SettingsActorRole.Admin),
      staleSessionRole: false,
      unavailableDomains: [SettingsDomainId.Devices],
    });
    // Unavailable says "this build does not offer it" and must not claim the
    // actor lacks authority — the grants stay true so a host that DOES offer
    // the panel is not told the admin is denied.
    expect(model.domains[SettingsDomainId.Devices]).toEqual({
      status: SettingsDomainStatus.Unavailable,
      grants: { read: true, edit: true, admin: true, owner: false },
    });
    expect(model.status).toBe(SettingsViewModelStatus.Ready);
  });

  it("still publishes the panel's capabilities, and does NOT list it unreadable", () => {
    const model = projectSettingsViewModel({
      resolution: resolved(SettingsActorRole.Admin),
      staleSessionRole: false,
      unavailableDomains: [SettingsDomainId.Devices],
    });

    // Deliberate, and pinned because the two signals must not contradict:
    // ISS-8362's resolver decides `unavailable` from its OWN registry `hosts`
    // list, so this projection answers the capability question for a host that
    // DOES ship the panel. Blanking the grants here would make a build that has
    // the panel render it as denied.
    expect(
      model.capabilities.grants?.[SettingsPanelId.ConnectedDevices]
    ).toEqual([READ, EDIT, ADMIN]);
    expect(model.capabilities.unreadable).toBeUndefined();
  });
});

describe("projectSettingsViewModel — unavailable outranks unreadable", () => {
  it("reports Unavailable, keeping the actor's grants, when a domain is both", () => {
    // Order matters and is declared load-bearing in the projection. Reversed,
    // a panel this build does not contain would come back as a capability
    // error, which ISS-8362's navigation renders with a retry affordance — a
    // retry for something no retry can produce, and the actor's real grants
    // dropped on a host that DOES contain the panel.
    const model = projectSettingsViewModel({
      resolution: resolved(SettingsActorRole.Admin),
      staleSessionRole: false,
      unavailableDomains: [SettingsDomainId.Devices],
      unreadableDomains: [SettingsDomainId.Devices],
    });

    expect(model.domains[SettingsDomainId.Devices]).toEqual({
      status: SettingsDomainStatus.Unavailable,
      grants: { read: true, edit: true, admin: true, owner: false },
    });
    expect(model.status).toBe(SettingsViewModelStatus.Ready);
    expect(model.capabilities.unreadable).toBeUndefined();
  });

  it("still reports an unreadable domain that is NOT unavailable as an error", () => {
    const model = projectSettingsViewModel({
      resolution: resolved(SettingsActorRole.Admin),
      staleSessionRole: false,
      unavailableDomains: [SettingsDomainId.Devices],
      unreadableDomains: [SettingsDomainId.Tags],
    });

    expect(model.domains[SettingsDomainId.Tags].status).toBe(
      SettingsDomainStatus.Error
    );
    expect(model.domains[SettingsDomainId.Devices].status).toBe(
      SettingsDomainStatus.Unavailable
    );
    expect(model.status).toBe(SettingsViewModelStatus.Partial);
  });
});

describe("resolveSettingsActorRole — malformed and hostile input", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("treats %s as a settled not-a-member answer", (_label, value) => {
    expect(resolveSettingsActorRole(value)).toEqual({
      status: SettingsActorRoleStatus.NotAMember,
    });
  });

  it.each([
    ["empty string", ""],
    ["whitespace", "   "],
  ])(
    "treats a PRESENT but unusable %s as unresolved, not as removal",
    (_label, value) => {
      // The membership row exists; only its role is unreadable. Calling that
      // `NotAMember` publishes a confident removal decision built on corrupt
      // provider data — a 200 with every domain forbidden, where the retryable
      // 503 belongs. `null` is the ONLY value that means no membership.
      expect(resolveSettingsActorRole(value)).toEqual({
        status: SettingsActorRoleStatus.Unresolved,
        reason: SettingsActorRoleUnresolvedReason.MalformedRole,
      });
      expect(resolveSettingsActorRole(value)).not.toEqual({
        status: SettingsActorRoleStatus.NotAMember,
      });
    }
  );

  it("projects a blank role as a whole-surface error, never a denial", () => {
    // The projection half of the same distinction: a removed member gets
    // `Ready` with every domain `Forbidden`; corrupt data must not.
    const model = projectSettingsViewModel({
      resolution: resolveSettingsActorRole("   "),
      staleSessionRole: false,
    });
    expect(model.status).toBe(SettingsViewModelStatus.Error);
    expect(model.domains[SettingsDomainId.Tags]).toEqual({
      status: SettingsDomainStatus.Error,
      grants: { read: false, edit: false, admin: false, owner: false },
      reason: SettingsDomainFailureReason.RoleUnresolved,
    });
    expect(
      projectSettingsViewModel({
        resolution: resolveSettingsActorRole(null),
        staleSessionRole: false,
      }).status
    ).toBe(SettingsViewModelStatus.Ready);
  });

  it.each([
    ["__proto__", "__proto__"],
    ["constructor", "constructor"],
    ["prototype", "prototype"],
  ])("does not let %s reach a prototype member", (_label, value) => {
    // A plain-object lookup would return `Object.prototype.constructor` here,
    // which is truthy and is not a role.
    expect(resolveSettingsActorRole(value)).toEqual({
      status: SettingsActorRoleStatus.Resolved,
      role: SettingsActorRole.Member,
    });
  });

  it("degrades an unrecognized Clerk role to member, never to admin", () => {
    expect(resolveSettingsActorRole("org:billing_manager")).toEqual({
      status: SettingsActorRoleStatus.Resolved,
      role: SettingsActorRole.Member,
    });
  });

  it("still recognizes the two real admin roles", () => {
    expect(resolveSettingsActorRole("org:admin")).toEqual({
      status: SettingsActorRoleStatus.Resolved,
      role: SettingsActorRole.Admin,
    });
    expect(resolveSettingsActorRole("org:owner")).toEqual({
      status: SettingsActorRoleStatus.Resolved,
      role: SettingsActorRole.Owner,
    });
  });

  it("projects a malformed role as a member surface, not an admin one", () => {
    const model = projectSettingsViewModel({
      resolution: resolveSettingsActorRole("org:not-a-real-role"),
      staleSessionRole: false,
    });
    expect(
      model.capabilities.grants?.[SettingsPanelId.Compliance]
    ).toBeUndefined();
    expect(model.domains[SettingsDomainId.CustomFields]).toEqual({
      status: SettingsDomainStatus.Ready,
      grants: { read: true, edit: false, admin: false, owner: false },
    });
  });
});
