import {
  SettingsPanelCapability,
  SettingsPanelHost,
  SettingsPanelResolutionStatus,
} from "@repo/api/src/types/settings-panel";
import { describe, expect, it } from "vitest";
import {
  fixturePanel,
  grantRead,
} from "../../test-fixtures/settings-panel-fixtures";
import {
  DESKTOP_ONLY_SETTINGS_PANEL_IDS,
  DESKTOP_ONLY_SETTINGS_PANEL_PLACEHOLDERS,
  WEB_ONLY_SETTINGS_PANEL_HOST,
  WEB_ONLY_SETTINGS_PANEL_IDS,
  WEB_ONLY_SETTINGS_PANEL_PLACEHOLDERS,
} from "../settings-panel-host-availability";
import {
  assertSettingsPanelRegistryComplete,
  assertSettingsPanelRegistryCompleteForHost,
  createSettingsPanelRegistry,
  SettingsPanelRegistryError,
} from "../settings-panel-registry";
import { evaluateSettingsPanelStatus } from "../settings-panel-resolution";
import { SHARED_SETTINGS_PANEL_DESCRIPTORS } from "../use-settings-panel-registry";

const UNKNOWN_ID_MESSAGE = /not a known panel id/;
const MISSING_PANELS_MESSAGE =
  /missing: connected-devices, plugins, organization, members, custom-fields, tags, compliance, api-keys, desktop-app, other-labs/;
const DESKTOP_MISSING_DEVICES_MESSAGE =
  /for desktop is missing: connected-devices\./;
const DESKTOP_MISSING_MEMBERS_MESSAGE = /for desktop is missing: members\./;

describe("settings panel registry", () => {
  it("lets a panel package be registered and exercised on its own", () => {
    const registry = createSettingsPanelRegistry([fixturePanel("members")]);

    expect(registry.has("members")).toBe(true);
    expect(registry.get("members")?.requiredCapability).toBe(
      SettingsPanelCapability.Read
    );
    expect(
      evaluateSettingsPanelStatus("members", {
        capabilities: grantRead("members"),
        host: SettingsPanelHost.Web,
        registry,
      })
    ).toBe(SettingsPanelResolutionStatus.Ready);
  });

  it("orders registered ids by the contract, not by registration order", () => {
    const registry = createSettingsPanelRegistry([
      fixturePanel("other-labs"),
      fixturePanel("members"),
      fixturePanel("profile"),
    ]);

    expect([...registry.ids]).toEqual(["profile", "members", "other-labs"]);
  });

  it("refuses a duplicate registration instead of letting one win silently", () => {
    expect(() =>
      createSettingsPanelRegistry([
        fixturePanel("members"),
        fixturePanel("members"),
      ])
    ).toThrow(SettingsPanelRegistryError);
  });

  it("refuses an id outside the published set", () => {
    const rogue = {
      ...fixturePanel("members"),
      id: "integrations",
    } as unknown as ReturnType<typeof fixturePanel>;

    expect(() => createSettingsPanelRegistry([rogue])).toThrow(
      UNKNOWN_ID_MESSAGE
    );
  });

  it("names every unregistered panel when the assembly asserts completeness", () => {
    const complete = createSettingsPanelRegistry([
      fixturePanel("profile"),
      fixturePanel("connected-devices"),
      fixturePanel("plugins"),
      fixturePanel("organization"),
      fixturePanel("members"),
      fixturePanel("custom-fields"),
      fixturePanel("tags"),
      fixturePanel("compliance"),
      fixturePanel("api-keys"),
      fixturePanel("desktop-app"),
      fixturePanel("other-labs"),
    ]);
    expect(() => assertSettingsPanelRegistryComplete(complete)).not.toThrow();

    const partial = createSettingsPanelRegistry([fixturePanel("profile")]);
    expect(() => assertSettingsPanelRegistryComplete(partial)).toThrow(
      MISSING_PANELS_MESSAGE
    );
  });
});

/**
 * ISS-8370 D4 — the desktop composition root's guard, driven with the REAL
 * shared descriptors and the real web-only list, so the assertion is about the
 * production composition and not about a fixture that agrees with itself.
 */
describe("assertSettingsPanelRegistryCompleteForHost", () => {
  const desktop = WEB_ONLY_SETTINGS_PANEL_HOST;

  /**
   * ISS-10286 added an id the desktop offers and `packages/app` cannot
   * see: Desktop App's body reaches `window.desktopApi`, so its real descriptor
   * lives in `apps/desktop` and only that root can register it. The placeholder
   * stands in for it here for the same reason the desktop root's web-only
   * placeholders stand in over there — this suite is about the guard's
   * arithmetic, and the real registration is driven in
   * `apps/desktop/src/renderer/settings-v2/__tests__/desktop-settings-v2-root.test.tsx`.
   */
  const DESKTOP_REGISTERED = [
    ...SHARED_SETTINGS_PANEL_DESCRIPTORS,
    ...DESKTOP_ONLY_SETTINGS_PANEL_PLACEHOLDERS,
  ];

  it("passes over the eight shared descriptors, the desktop-owned panel, and the web-only list", () => {
    expect(SHARED_SETTINGS_PANEL_DESCRIPTORS).toHaveLength(8);
    expect(DESKTOP_ONLY_SETTINGS_PANEL_IDS).toHaveLength(1);
    expect(() =>
      assertSettingsPanelRegistryCompleteForHost(
        createSettingsPanelRegistry(DESKTOP_REGISTERED),
        desktop,
        WEB_ONLY_SETTINGS_PANEL_IDS
      )
    ).not.toThrow();
  });

  // The desktop-owned id is neither shared nor web-only, so it is the one a
  // host-completeness guard can silently lose: without its own registration it
  // falls through both lists.
  it("throws when the desktop-owned panel is the one that failed to register", () => {
    expect(() =>
      assertSettingsPanelRegistryCompleteForHost(
        createSettingsPanelRegistry(SHARED_SETTINGS_PANEL_DESCRIPTORS),
        desktop,
        WEB_ONLY_SETTINGS_PANEL_IDS
      )
    ).toThrow("desktop-app");
  });

  it("throws naming a desktop-offered descriptor that failed to register", () => {
    const withoutDevices = DESKTOP_REGISTERED.filter(
      (descriptor) => descriptor.id !== "connected-devices"
    );

    expect(() =>
      assertSettingsPanelRegistryCompleteForHost(
        createSettingsPanelRegistry(withoutDevices),
        desktop,
        WEB_ONLY_SETTINGS_PANEL_IDS
      )
    ).toThrow(DESKTOP_MISSING_DEVICES_MESSAGE);
  });

  it("throws when an unregistered id is not on the host's unavailable list either", () => {
    // The list is the host's explicit availability decision. Dropping an entry
    // from it is a claim the panel IS offered here, which the registry then
    // cannot back up.
    const shorterList = WEB_ONLY_SETTINGS_PANEL_IDS.filter(
      (id) => id !== "members"
    );

    expect(() =>
      assertSettingsPanelRegistryCompleteForHost(
        createSettingsPanelRegistry(DESKTOP_REGISTERED),
        desktop,
        shorterList
      )
    ).toThrow(DESKTOP_MISSING_MEMBERS_MESSAGE);
  });

  it("has a placeholder for exactly the web-only ids no shared descriptor covers", () => {
    // The placeholders and the shared set together are the desktop's rendered
    // registry, so between them they must cover the list and nothing twice.
    const sharedIds = new Set(
      SHARED_SETTINGS_PANEL_DESCRIPTORS.map((descriptor) => descriptor.id)
    );
    const placeholderIds = WEB_ONLY_SETTINGS_PANEL_PLACEHOLDERS.map(
      (descriptor) => descriptor.id
    );

    expect(placeholderIds).toEqual(
      WEB_ONLY_SETTINGS_PANEL_IDS.filter((id) => !sharedIds.has(id))
    );
    for (const placeholder of WEB_ONLY_SETTINGS_PANEL_PLACEHOLDERS) {
      expect(placeholder.hosts).toEqual([SettingsPanelHost.Web]);
    }
    expect(() =>
      assertSettingsPanelRegistryComplete(
        createSettingsPanelRegistry([
          ...SHARED_SETTINGS_PANEL_DESCRIPTORS,
          ...WEB_ONLY_SETTINGS_PANEL_PLACEHOLDERS,
          ...DESKTOP_ONLY_SETTINGS_PANEL_PLACEHOLDERS,
        ])
      )
    ).not.toThrow();
  });

  // The mirror of the case above, for the direction ISS-10286 opened: what the
  // WEB registry stands in for. A placeholder that claimed `hosts: [Web]` would
  // make a browser link naming Desktop App resolve `ready` and then mount a
  // body that throws.
  it("has a desktop-only placeholder for exactly the desktop-owned ids", () => {
    expect(
      DESKTOP_ONLY_SETTINGS_PANEL_PLACEHOLDERS.map(
        (descriptor) => descriptor.id
      )
    ).toEqual([...DESKTOP_ONLY_SETTINGS_PANEL_IDS]);
    for (const placeholder of DESKTOP_ONLY_SETTINGS_PANEL_PLACEHOLDERS) {
      expect(placeholder.hosts).toEqual([SettingsPanelHost.Desktop]);
    }
  });
});
