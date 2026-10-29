import {
  SettingsPanelHost,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { describe, expect, it } from "vitest";
import { createSettingsPanelRegistry } from "../../lib/settings-panel-registry";
import { DEVELOPER_SETTINGS_PANELS } from "../developer-settings-panels";

// The three ids this package owns, written out rather than derived from the
// module under test — deriving them would keep this green if a panel were
// dropped from the registration list.
const OWNED_PANEL_IDS = ["plugins", "api-keys", "other-labs"] as const;

/**
 * ISS-10244 retired `settings-developer-panels`. The cases that used to pin the
 * gate — closed by default, opened by exactly that PostHog key, closed with no
 * provider mounted — are gone with the contract they described. What survives is
 * the registration set itself and the host declarations, which are what the
 * shell actually resolves against.
 */
describe("DEVELOPER_SETTINGS_PANELS", () => {
  it("registers exactly the three panels this package owns, unconditionally", () => {
    const registry = createSettingsPanelRegistry(DEVELOPER_SETTINGS_PANELS);

    expect([...registry.ids]).toEqual([...OWNED_PANEL_IDS]);
  });
});

describe("developer settings panel descriptors", () => {
  const byId = new Map(
    DEVELOPER_SETTINGS_PANELS.map((panel) => [panel.id, panel])
  );

  it("offers API Keys and Other Labs on BOTH hosts", () => {
    for (const id of [SettingsPanelId.ApiKeys, SettingsPanelId.OtherLabs]) {
      const hosts = byId.get(id)?.hosts ?? [];
      expect(hosts.includes(SettingsPanelHost.Web)).toBe(true);
      expect(hosts.includes(SettingsPanelHost.Desktop)).toBe(true);
    }
  });

  it("offers Plugins on web only, because the connect flow is a browser redirect", () => {
    const hosts = byId.get(SettingsPanelId.Plugins)?.hosts ?? [];
    expect(hosts.includes(SettingsPanelHost.Web)).toBe(true);
    expect(hosts.includes(SettingsPanelHost.Desktop)).toBe(false);
  });
});
