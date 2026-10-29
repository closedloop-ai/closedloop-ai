import {
  SettingsActorCapabilityStatus,
  SettingsPanelCapability,
  SettingsPanelHost,
  SettingsPanelId,
  SettingsPanelResolutionStatus,
} from "@repo/api/src/types/settings-panel";
import {
  assertSettingsPanelRegistryComplete,
  createSettingsPanelRegistry,
} from "@repo/app/settings/v2/lib/settings-panel-registry";
import { resolveSettingsPanel } from "@repo/app/settings/v2/lib/settings-panel-resolution";
import { describe, expect, it } from "vitest";
import { PROFILE_SETTINGS_PANEL } from "../profile-settings-panel";
import { ProfileSettingsPanelBody } from "../profile-settings-panel-body";

const READ_GRANT = {
  grants: {
    [SettingsPanelId.Profile]: [SettingsPanelCapability.Read],
  },
  status: SettingsActorCapabilityStatus.Ready,
};

const REGISTRY_INCOMPLETE = /Settings panel registry is missing/;

function resolveOn(host: SettingsPanelHost) {
  return resolveSettingsPanel({
    capabilities: READ_GRANT,
    host,
    registry: createSettingsPanelRegistry([PROFILE_SETTINGS_PANEL]),
    requestedPanel: SettingsPanelId.Profile,
  });
}

describe("PROFILE_SETTINGS_PANEL", () => {
  it("claims the contract's reserved Profile id rather than minting one", () => {
    expect(PROFILE_SETTINGS_PANEL.id).toBe(SettingsPanelId.Profile);
  });

  it("requires only read, which is what every role holds for Profile", () => {
    expect(PROFILE_SETTINGS_PANEL.requiredCapability).toBe(
      SettingsPanelCapability.Read
    );
  });

  it("offers itself on web only", () => {
    expect(PROFILE_SETTINGS_PANEL.hosts).toEqual([SettingsPanelHost.Web]);
  });

  it("resolves ready on web for an actor holding read", () => {
    const resolution = resolveOn(SettingsPanelHost.Web);

    expect(resolution.status).toBe(SettingsPanelResolutionStatus.Ready);
    expect(resolution.panelId).toBe(SettingsPanelId.Profile);
    const registry = createSettingsPanelRegistry([PROFILE_SETTINGS_PANEL]);
    expect(registry.get(SettingsPanelId.Profile)?.Panel).toBe(
      ProfileSettingsPanelBody
    );
  });

  it("resolves UNAVAILABLE on desktop, never unknown", () => {
    // The distinction is the whole point of ISS-8362's six states: `unknown`
    // renders "that settings link doesn't point anywhere", accusing the user of
    // following a stale link. "Not part of the desktop app" is a different
    // fact with a different remedy.
    const resolution = resolveOn(SettingsPanelHost.Desktop);

    expect(resolution.status).toBe(SettingsPanelResolutionStatus.Unavailable);
    expect(resolution.status).not.toBe(SettingsPanelResolutionStatus.Unknown);
    expect(resolution.panelId).toBeNull();
  });

  it("resolves capability-error, not forbidden, when the capability read failed", () => {
    const resolution = resolveSettingsPanel({
      capabilities: { status: SettingsActorCapabilityStatus.Error },
      host: SettingsPanelHost.Web,
      registry: createSettingsPanelRegistry([PROFILE_SETTINGS_PANEL]),
      requestedPanel: SettingsPanelId.Profile,
    });

    expect(resolution.status).toBe(
      SettingsPanelResolutionStatus.CapabilityError
    );
  });

  it("satisfies the composition root's completeness assertion for its own id", () => {
    // ISS-8370 owns the whole-registry assertion; this pins only that `profile`
    // is not among the ids it reports missing.
    const registry = createSettingsPanelRegistry([PROFILE_SETTINGS_PANEL]);

    expect(() => assertSettingsPanelRegistryComplete(registry)).toThrow(
      REGISTRY_INCOMPLETE
    );
    try {
      assertSettingsPanelRegistryComplete(registry);
    } catch (error) {
      expect((error as Error).message).not.toContain(SettingsPanelId.Profile);
    }
  });

  it("exposes its hosts list as a frozen array a consumer cannot mutate", () => {
    // `defineSettingsPanel` freezes every descriptor it returns, so freezing
    // is the registry's guarantee rather than something this panel earns. What
    // is worth pinning is that the panel passes a real array through it: a
    // consumer that pushed `desktop` onto this list would silently widen the
    // panel onto a host it was never built for.
    expect(Object.isFrozen(PROFILE_SETTINGS_PANEL.hosts)).toBe(true);
    expect(() => {
      (PROFILE_SETTINGS_PANEL.hosts as SettingsPanelHost[]).push(
        SettingsPanelHost.Desktop
      );
    }).toThrow();
  });
});
