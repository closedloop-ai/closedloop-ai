import {
  SETTINGS_PANEL_IDS,
  SettingsPanelHost,
} from "@repo/api/src/types/settings-panel";
import { WEB_ONLY_SETTINGS_PANEL_IDS } from "@repo/app/settings/v2/lib/settings-panel-host-availability";
import {
  assertSettingsPanelRegistryComplete,
  createSettingsPanelRegistry,
} from "@repo/app/settings/v2/lib/settings-panel-registry";
import { describe, expect, it } from "vitest";
import { WEB_SETTINGS_PANEL_DESCRIPTORS } from "../settings-v2-panels";

/**
 * ISS-8370 D4 — the web ownership registry, asserted over the REAL descriptors.
 */
describe("the web ownership registry", () => {
  it("holds all twelve canonical panels and passes the completeness assert", () => {
    const registry = createSettingsPanelRegistry(
      WEB_SETTINGS_PANEL_DESCRIPTORS
    );

    expect([...registry.ids]).toEqual([...SETTINGS_PANEL_IDS]);
    expect(() => assertSettingsPanelRegistryComplete(registry)).not.toThrow();
  });

  /**
   * The desktop root cannot see three of these descriptors, so its web-only
   * list is a claim it makes blind. This is the side that can check it: every
   * listed id declares itself web-only, and every web-only descriptor is listed
   * — so the list can neither hide a panel desktop offers nor drift when a
   * descriptor gains or loses a host.
   */
  it("agrees with the descriptors about which panels are web-only", () => {
    const webOnlyByDescriptor = WEB_SETTINGS_PANEL_DESCRIPTORS.filter(
      (descriptor) =>
        descriptor.hosts.length === 1 &&
        descriptor.hosts[0] === SettingsPanelHost.Web
    ).map((descriptor) => descriptor.id);

    expect([...webOnlyByDescriptor].sort()).toEqual(
      [...WEB_ONLY_SETTINGS_PANEL_IDS].sort()
    );
  });
});
