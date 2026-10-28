import {
  SettingsActorRole,
  SettingsActorRoleStatus,
} from "@repo/api/src/types/settings-actor-role";
import {
  SettingsPanelCapability,
  SettingsPanelHost,
  SettingsPanelId,
  SettingsPanelResolutionStatus,
} from "@repo/api/src/types/settings-panel";
import { projectSettingsViewModel } from "@repo/api/src/types/settings-view-model";
import { describe, expect, it } from "vitest";
import { createSettingsPanelRegistry } from "../../lib/settings-panel-registry";
import { resolveSettingsPanel } from "../../lib/settings-panel-resolution";
import { DEVICE_SETTINGS_PANELS } from "../device-settings-panels";

function capabilitiesFor(role: SettingsActorRole) {
  return projectSettingsViewModel({
    resolution: { role, status: SettingsActorRoleStatus.Resolved },
    staleSessionRole: false,
  }).capabilities;
}

/**
 * ISS-10244 retired `settings-device-panels`. The gate cases are gone with the
 * contract; the descriptor and policy cases below are what the shell resolves
 * against and are unaffected by the retirement.
 */
describe("DEVICE_SETTINGS_PANELS", () => {
  it("registers Connected Devices unconditionally", () => {
    const registry = createSettingsPanelRegistry(DEVICE_SETTINGS_PANELS);

    expect([...registry.ids]).toEqual([SettingsPanelId.ConnectedDevices]);
  });
});

describe("the Connected Devices descriptor", () => {
  const [panel] = DEVICE_SETTINGS_PANELS;

  it("offers the panel on BOTH hosts (D1)", () => {
    // Every read here goes through the shared api client, and
    // `currentSessionKnown` was built for the Desktop transport specifically —
    // declaring this Web-only would strand a field designed for this consumer.
    expect(panel?.hosts).toContain(SettingsPanelHost.Web);
    expect(panel?.hosts).toContain(SettingsPanelHost.Desktop);
  });

  it("asks for Read, leaving the denial to the policy table", () => {
    expect(panel?.requiredCapability).toBe(SettingsPanelCapability.Read);
  });
});

describe("Connected Devices resolved against the real role policy", () => {
  const registry = createSettingsPanelRegistry(DEVICE_SETTINGS_PANELS);

  function resolve(role: SettingsActorRole, host: SettingsPanelHost) {
    return resolveSettingsPanel({
      capabilities: capabilitiesFor(role),
      host,
      registry,
      requestedPanel: SettingsPanelId.ConnectedDevices,
    }).status;
  }

  it("opens for Member, Admin and Owner on both hosts", () => {
    // `SETTINGS_DOMAIN_ACCESS_POLICY[Devices]` is open to every role, mirrored
    // off the real routes. The permissive rows are the claim, so a policy row
    // tightened later fails here rather than in production.
    for (const role of [
      SettingsActorRole.Member,
      SettingsActorRole.Admin,
      SettingsActorRole.Owner,
    ]) {
      expect(resolve(role, SettingsPanelHost.Web), role).toBe(
        SettingsPanelResolutionStatus.Ready
      );
      expect(resolve(role, SettingsPanelHost.Desktop), role).toBe(
        SettingsPanelResolutionStatus.Ready
      );
    }
  });
});
