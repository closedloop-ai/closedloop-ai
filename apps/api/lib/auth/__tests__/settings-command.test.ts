import {
  SETTINGS_ACTOR_ROLES,
  type SettingsActorRole,
  SettingsActorRoleStatus,
  SettingsActorRoleUnresolvedReason,
  SettingsActorRole as SettingsActorRoleValues,
} from "@repo/api/src/types/settings-actor-role";
import {
  SettingsCommandCapability,
  SettingsCommandDenialCode,
} from "@repo/api/src/types/settings-command";
import { SettingsDomainId } from "@repo/api/src/types/settings-domain";
import { describe, expect, it } from "vitest";
import { authorizeSettingsCommand } from "@/lib/auth/settings-command";

const resolved = (role: SettingsActorRole) =>
  ({ status: SettingsActorRoleStatus.Resolved, role }) as const;

const NOT_A_MEMBER = { status: SettingsActorRoleStatus.NotAMember } as const;

const UNRESOLVED = {
  status: SettingsActorRoleStatus.Unresolved,
  reason: SettingsActorRoleUnresolvedReason.ProviderError,
} as const;

describe("authorizeSettingsCommand — the role list the guard quantifies over", () => {
  it("enumerates every SettingsActorRole", () => {
    // `DomainReadOnly` is decided by asking whether ANY role may write the
    // domain, so a role missing from this list is a role the guard never
    // considers. It would narrow rather than widen the answer — but silently.
    expect([...SETTINGS_ACTOR_ROLES].sort()).toEqual(
      Object.values(SettingsActorRoleValues).sort()
    );
  });
});

describe("authorizeSettingsCommand — admin-only domains", () => {
  it("refuses a member the admin rung on Custom Fields", () => {
    expect(
      authorizeSettingsCommand({
        resolution: resolved(SettingsActorRoleValues.Member),
        domain: SettingsDomainId.CustomFields,
        capability: SettingsCommandCapability.Admin,
      })
    ).toEqual({
      allowed: false,
      code: SettingsCommandDenialCode.InsufficientRole,
    });
  });

  it("admits an admin and an owner on the SAME call the member was refused", () => {
    // The positive sibling that makes the refusal above meaningful: without it,
    // a broken policy that denied everyone would satisfy the denial assertion.
    expect(
      authorizeSettingsCommand({
        resolution: resolved(SettingsActorRoleValues.Admin),
        domain: SettingsDomainId.CustomFields,
        capability: SettingsCommandCapability.Admin,
      })
    ).toEqual({ allowed: true, role: SettingsActorRoleValues.Admin });
    expect(
      authorizeSettingsCommand({
        resolution: resolved(SettingsActorRoleValues.Owner),
        domain: SettingsDomainId.CustomFields,
        capability: SettingsCommandCapability.Admin,
      })
    ).toEqual({ allowed: true, role: SettingsActorRoleValues.Owner });
  });

  it("refuses a member EDIT on Custom Fields while admitting it on Tags", () => {
    expect(
      authorizeSettingsCommand({
        resolution: resolved(SettingsActorRoleValues.Member),
        domain: SettingsDomainId.CustomFields,
        capability: SettingsCommandCapability.Edit,
      })
    ).toEqual({
      allowed: false,
      code: SettingsCommandDenialCode.InsufficientRole,
    });
    expect(
      authorizeSettingsCommand({
        resolution: resolved(SettingsActorRoleValues.Member),
        domain: SettingsDomainId.Tags,
        capability: SettingsCommandCapability.Edit,
      })
    ).toEqual({ allowed: true, role: SettingsActorRoleValues.Member });
  });
});

describe("authorizeSettingsCommand — owner-only rung", () => {
  it("refuses an admin the owner rung and admits the owner", () => {
    expect(
      authorizeSettingsCommand({
        resolution: resolved(SettingsActorRoleValues.Admin),
        domain: SettingsDomainId.Organization,
        capability: SettingsCommandCapability.Owner,
      })
    ).toEqual({
      allowed: false,
      code: SettingsCommandDenialCode.InsufficientRole,
    });
    expect(
      authorizeSettingsCommand({
        resolution: resolved(SettingsActorRoleValues.Owner),
        domain: SettingsDomainId.Organization,
        capability: SettingsCommandCapability.Owner,
      })
    ).toEqual({ allowed: true, role: SettingsActorRoleValues.Owner });
  });
});

describe("authorizeSettingsCommand — a domain no role may mutate", () => {
  it("refuses EVERY role on Compliance with DomainReadOnly, not InsufficientRole", () => {
    // The distinction is actionable: InsufficientRole tells a caller that some
    // other actor could have done this, so escalating is a route forward.
    // DomainReadOnly says nobody can, and escalating is wasted effort.
    for (const role of SETTINGS_ACTOR_ROLES) {
      expect(
        authorizeSettingsCommand({
          resolution: resolved(role),
          domain: SettingsDomainId.Compliance,
          capability: SettingsCommandCapability.Edit,
        })
      ).toEqual({
        allowed: false,
        code: SettingsCommandDenialCode.DomainReadOnly,
      });
    }
  });

  it("refuses the PRIVILEGED rungs on Compliance, not only Edit", () => {
    // The fail-open this ordering exists to close. `admin` and `owner` are role
    // facts ANDed only with `read`, so an admin reading Compliance holds
    // `admin: true` on a domain whose `edit` list is empty; a guard that asked
    // the grant before the domain's writability answered `allowed: true` for
    // the natural privileged capability of a read-only domain.
    for (const capability of [
      SettingsCommandCapability.Admin,
      SettingsCommandCapability.Owner,
    ]) {
      for (const role of SETTINGS_ACTOR_ROLES) {
        expect(
          authorizeSettingsCommand({
            resolution: resolved(role),
            domain: SettingsDomainId.Compliance,
            capability,
          })
        ).toEqual({
          allowed: false,
          code: SettingsCommandDenialCode.DomainReadOnly,
        });
      }
    }
  });

  it("admits the same privileged rungs on a domain that IS writable", () => {
    // The positive sibling: without it, a guard that refused every privileged
    // command everywhere would satisfy the assertion above.
    expect(
      authorizeSettingsCommand({
        resolution: resolved(SettingsActorRoleValues.Owner),
        domain: SettingsDomainId.Members,
        capability: SettingsCommandCapability.Owner,
      })
    ).toEqual({ allowed: true, role: SettingsActorRoleValues.Owner });
  });

  it("still reports InsufficientRole where a higher role WOULD succeed", () => {
    // Members: the domain's only write is the admin-gated invite, so a member
    // is refused and an admin is not — which is what separates this code from
    // DomainReadOnly above.
    expect(
      authorizeSettingsCommand({
        resolution: resolved(SettingsActorRoleValues.Member),
        domain: SettingsDomainId.Members,
        capability: SettingsCommandCapability.Edit,
      })
    ).toEqual({
      allowed: false,
      code: SettingsCommandDenialCode.InsufficientRole,
    });
    expect(
      authorizeSettingsCommand({
        resolution: resolved(SettingsActorRoleValues.Admin),
        domain: SettingsDomainId.Members,
        capability: SettingsCommandCapability.Edit,
      })
    ).toEqual({ allowed: true, role: SettingsActorRoleValues.Admin });
  });
});

describe("authorizeSettingsCommand — removed member and cross-org", () => {
  it("refuses with NotAMember, distinct from a role that merely lacks authority", () => {
    const removed = authorizeSettingsCommand({
      resolution: NOT_A_MEMBER,
      domain: SettingsDomainId.Tags,
      capability: SettingsCommandCapability.Edit,
    });
    expect(removed).toEqual({
      allowed: false,
      code: SettingsCommandDenialCode.NotAMember,
    });
    // A member IS admitted on the same call, so the refusal is about membership
    // rather than about the domain being closed.
    expect(
      authorizeSettingsCommand({
        resolution: resolved(SettingsActorRoleValues.Member),
        domain: SettingsDomainId.Tags,
        capability: SettingsCommandCapability.Edit,
      }).allowed
    ).toBe(true);
  });

  it("refuses a removed member on EVERY domain and capability", () => {
    for (const domain of Object.values(SettingsDomainId)) {
      for (const capability of Object.values(SettingsCommandCapability)) {
        expect(
          authorizeSettingsCommand({
            resolution: NOT_A_MEMBER,
            domain,
            capability,
          }).allowed
        ).toBe(false);
      }
    }
  });
});

describe("authorizeSettingsCommand — unresolved role", () => {
  it("refuses with RoleUnresolved, never with an authorization verdict", () => {
    // The collapse this code exists to prevent: a Clerk outage must not be
    // reported as "you are not allowed", because the two carry different HTTP
    // statuses and different advice — one is retryable, the other is final.
    const decision = authorizeSettingsCommand({
      resolution: UNRESOLVED,
      domain: SettingsDomainId.Tags,
      capability: SettingsCommandCapability.Edit,
    });
    expect(decision).toEqual({
      allowed: false,
      code: SettingsCommandDenialCode.RoleUnresolved,
    });
    expect(decision).not.toEqual({
      allowed: false,
      code: SettingsCommandDenialCode.InsufficientRole,
    });
    expect(decision).not.toEqual({
      allowed: false,
      code: SettingsCommandDenialCode.NotAMember,
    });
  });

  it("refuses even a capability every role holds, rather than assuming a role", () => {
    // Tags/edit is granted to member, admin and owner alike. An implementation
    // that consulted the policy before checking resolution could "safely" admit
    // it; that would be authorizing a caller whose role was never read.
    expect(
      authorizeSettingsCommand({
        resolution: UNRESOLVED,
        domain: SettingsDomainId.Tags,
        capability: SettingsCommandCapability.Edit,
      }).allowed
    ).toBe(false);
  });

  it("never admits any role/domain/capability combination while unresolved", () => {
    for (const domain of Object.values(SettingsDomainId)) {
      for (const capability of Object.values(SettingsCommandCapability)) {
        expect(
          authorizeSettingsCommand({
            resolution: UNRESOLVED,
            domain,
            capability,
          }).allowed
        ).toBe(false);
      }
    }
  });
});

describe("authorizeSettingsCommand — read is not a command capability", () => {
  it("admits at least one mutation somewhere, so the suite is not vacuously denying", () => {
    const admitted = Object.values(SettingsDomainId).filter(
      (domain) =>
        authorizeSettingsCommand({
          resolution: resolved(SettingsActorRoleValues.Owner),
          domain,
          capability: SettingsCommandCapability.Edit,
        }).allowed
    );
    expect(admitted.length).toBeGreaterThan(0);
    expect(admitted).not.toContain(SettingsDomainId.Compliance);
  });
});
