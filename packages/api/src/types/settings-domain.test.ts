import { describe, expect, it } from "vitest";
import {
  SETTINGS_ACTOR_ROLES,
  SettingsActorRole,
} from "./settings-actor-role.ts";
import {
  resolveSettingsDomainGrants,
  SETTINGS_DOMAIN_ACCESS_POLICY,
  SETTINGS_PANEL_DOMAIN,
  SettingsDomainId,
} from "./settings-domain.ts";
import { SETTINGS_PANEL_IDS, SettingsPanelId } from "./settings-panel.ts";

/**
 * The pairing, written out independently of the map under test. The shape
 * assertions below (bijection, key coverage) are permutation-invariant — they
 * pass for ANY rearrangement — so without this literal, swapping Plugins and
 * Connected Devices would go unnoticed while quietly applying one panel's
 * policy to the other.
 */
const EXPECTED_PANEL_DOMAIN: Record<SettingsPanelId, SettingsDomainId> = {
  [SettingsPanelId.Profile]: SettingsDomainId.Profile,
  [SettingsPanelId.ConnectedDevices]: SettingsDomainId.Devices,
  [SettingsPanelId.Plugins]: SettingsDomainId.Connections,
  [SettingsPanelId.OrganizationGeneral]: SettingsDomainId.Organization,
  [SettingsPanelId.Members]: SettingsDomainId.Members,
  [SettingsPanelId.CustomFields]: SettingsDomainId.CustomFields,
  [SettingsPanelId.Tags]: SettingsDomainId.Tags,
  [SettingsPanelId.Compliance]: SettingsDomainId.Compliance,
  [SettingsPanelId.ApiKeys]: SettingsDomainId.ApiKeys,
  [SettingsPanelId.OtherLabs]: SettingsDomainId.Sync,
  [SettingsPanelId.DesktopApp]: SettingsDomainId.DesktopApp,
};

describe("SETTINGS_PANEL_DOMAIN", () => {
  it("gives every declared panel exactly one domain", () => {
    for (const panelId of SETTINGS_PANEL_IDS) {
      expect(SETTINGS_PANEL_DOMAIN[panelId]).toBeDefined();
    }
    expect(Object.keys(SETTINGS_PANEL_DOMAIN).sort()).toEqual(
      [...SETTINGS_PANEL_IDS].sort()
    );
  });

  it("pairs each panel with the RIGHT domain, not merely with some domain", () => {
    expect(SETTINGS_PANEL_DOMAIN).toEqual(EXPECTED_PANEL_DOMAIN);
  });

  it("is a bijection — no two panels share a domain, no domain is unreachable", () => {
    const mapped = SETTINGS_PANEL_IDS.map((id) => SETTINGS_PANEL_DOMAIN[id]);
    // A shared domain would give two panels one policy row and make a denial on
    // one silently deny the other; an unreachable domain would be a policy no
    // navigation can ever surface.
    expect(new Set(mapped).size).toBe(mapped.length);
    expect([...mapped].sort()).toEqual(Object.values(SettingsDomainId).sort());
  });
});

describe("SETTINGS_DOMAIN_ACCESS_POLICY", () => {
  it("covers every domain", () => {
    expect(Object.keys(SETTINGS_DOMAIN_ACCESS_POLICY).sort()).toEqual(
      Object.values(SettingsDomainId).sort()
    );
  });

  it("never lets a role edit a domain it cannot read", () => {
    for (const domain of Object.values(SettingsDomainId)) {
      const rule = SETTINGS_DOMAIN_ACCESS_POLICY[domain];
      for (const role of rule.edit) {
        expect(rule.read).toContain(role);
      }
    }
  });

  it("gates exactly one domain's READ — Compliance, matching its route", () => {
    // `GET /agent-components/compliance` is the only Settings read in apps/api
    // that calls isOrgAdmin and answers 403. Pinned as a literal so widening a
    // second domain's read gate, or dropping this one, fails here.
    const readGated = Object.values(SettingsDomainId).filter(
      (domain) =>
        !SETTINGS_DOMAIN_ACCESS_POLICY[domain].read.includes(
          SettingsActorRole.Member
        )
    );
    expect(readGated).toEqual([SettingsDomainId.Compliance]);
  });

  it("pins the domains a member may WRITE", () => {
    const memberWritable = Object.values(SettingsDomainId).filter((domain) =>
      SETTINGS_DOMAIN_ACCESS_POLICY[domain].edit.includes(
        SettingsActorRole.Member
      )
    );
    // Read off the ungated routes: /users/[id] (own profile), compute-targets
    // (owner-scoped, under Devices), the user Claude key and platform keys, and tags — plus
    // DesktopApp (ISS-10286), which has no route to read off at all: its writes
    // go to the Electron main process on the actor's own machine.
    // Every domain with at least one ungated write. Withholding any of these
    // would withdraw a control a member can reach today, which is a product
    // decision this table deliberately does not make.
    expect([...memberWritable].sort()).toEqual(
      [
        SettingsDomainId.ApiKeys,
        SettingsDomainId.Connections,
        SettingsDomainId.DesktopApp,
        SettingsDomainId.Devices,
        SettingsDomainId.Organization,
        SettingsDomainId.Profile,
        SettingsDomainId.Tags,
      ].sort()
    );
  });
});

describe("resolveSettingsDomainGrants", () => {
  it("never reports admin or owner authority over a domain the role cannot read", () => {
    for (const domain of Object.values(SettingsDomainId)) {
      for (const role of SETTINGS_ACTOR_ROLES) {
        const grants = resolveSettingsDomainGrants(domain, role);
        if (!grants.read) {
          expect(grants.admin).toBe(false);
          expect(grants.owner).toBe(false);
        }
      }
    }
  });

  it("gives a member no authority rung anywhere", () => {
    for (const domain of Object.values(SettingsDomainId)) {
      const grants = resolveSettingsDomainGrants(
        domain,
        SettingsActorRole.Member
      );
      expect(grants.admin).toBe(false);
      expect(grants.owner).toBe(false);
    }
  });

  it("gives an admin the admin rung but never the owner rung", () => {
    const readable = Object.values(SettingsDomainId).filter(
      (domain) =>
        resolveSettingsDomainGrants(domain, SettingsActorRole.Admin).read
    );
    expect(readable.length).toBeGreaterThan(0);
    for (const domain of readable) {
      const grants = resolveSettingsDomainGrants(
        domain,
        SettingsActorRole.Admin
      );
      expect(grants.admin).toBe(true);
      expect(grants.owner).toBe(false);
    }
  });

  it("gives an owner both rungs on every domain it can read", () => {
    for (const domain of Object.values(SettingsDomainId)) {
      const grants = resolveSettingsDomainGrants(
        domain,
        SettingsActorRole.Owner
      );
      expect(grants.owner).toBe(grants.read);
      expect(grants.admin).toBe(grants.read);
    }
  });

  it("keeps Compliance read-only for every role, including owner", () => {
    for (const role of SETTINGS_ACTOR_ROLES) {
      expect(
        resolveSettingsDomainGrants(SettingsDomainId.Compliance, role).edit
      ).toBe(false);
    }
    // Positive sibling: a domain that IS writable, so the assertion above is
    // not satisfied by `edit` being false everywhere.
    expect(
      resolveSettingsDomainGrants(
        SettingsDomainId.Tags,
        SettingsActorRole.Member
      ).edit
    ).toBe(true);
  });
});
