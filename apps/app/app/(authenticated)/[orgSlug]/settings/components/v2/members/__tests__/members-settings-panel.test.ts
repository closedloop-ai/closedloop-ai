import {
  SettingsActorCapabilityStatus,
  SettingsPanelCapability,
  SettingsPanelHost,
  SettingsPanelId,
  SettingsPanelResolutionStatus,
} from "@repo/api/src/types/settings-panel";
import {
  DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu";
import {
  assertSettingsPanelRegistryComplete,
  createSettingsPanelRegistry,
} from "@repo/app/settings/v2/lib/settings-panel-registry";
import { resolveSettingsPanel } from "@repo/app/settings/v2/lib/settings-panel-resolution";
import { describe, expect, it } from "vitest";
import { MEMBERS_SETTINGS_PANEL } from "../members-settings-panel";

const READ_GRANT = {
  grants: {
    [SettingsPanelId.Members]: [SettingsPanelCapability.Read],
  },
  status: SettingsActorCapabilityStatus.Ready,
};

const REGISTRY_INCOMPLETE = /Settings panel registry is missing/;

function resolveOn(host: SettingsPanelHost) {
  return resolveSettingsPanel({
    capabilities: READ_GRANT,
    host,
    registry: createSettingsPanelRegistry([MEMBERS_SETTINGS_PANEL]),
    requestedPanel: SettingsPanelId.Members,
  });
}

describe("MEMBERS_SETTINGS_PANEL", () => {
  it("offers itself on web only", () => {
    expect(MEMBERS_SETTINGS_PANEL.hosts).toEqual([SettingsPanelHost.Web]);
  });

  it("resolves ready on web for an actor holding read", () => {
    const resolution = resolveOn(SettingsPanelHost.Web);

    expect(resolution.status).toBe(SettingsPanelResolutionStatus.Ready);
    expect(resolution.panelId).toBe(SettingsPanelId.Members);
  });

  it("resolves UNAVAILABLE on desktop, never unknown", () => {
    // The desktop renderer mounts no Clerk provider, so the embed behind this
    // panel cannot mount there. `unknown` would render "that settings link
    // doesn't point anywhere", accusing the user of following a stale link;
    // "not part of the desktop app" is a different fact with a different
    // remedy, and the workspace menu omits the entry to match.
    const resolution = resolveOn(SettingsPanelHost.Desktop);

    expect(resolution.status).toBe(SettingsPanelResolutionStatus.Unavailable);
    expect(resolution.status).not.toBe(SettingsPanelResolutionStatus.Unknown);
    expect(resolution.panelId).toBeNull();
  });

  it("keeps the desktop workspace-menu omission in step with its own host list", () => {
    // One fact encoded in two places with no import edge between them: `hosts`
    // decides whether Settings can resolve Members on a host, and
    // `DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES` decides whether the workspace menu
    // offers the link that leads here. Giving desktop the panel without taking
    // Members off that list ships a reachable panel nothing points at; dropping
    // it from the list alone points the menu at an `unavailable` screen.
    const panelOffersDesktop = MEMBERS_SETTINGS_PANEL.hosts.includes(
      SettingsPanelHost.Desktop
    );
    const menuOffersMembersOnDesktop =
      !DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES.includes(
        WorkspaceMenuEntryId.Members
      );

    expect(menuOffersMembersOnDesktop).toBe(panelOffersDesktop);
  });

  it("resolves capability-error, not forbidden, when the capability read failed", () => {
    const resolution = resolveSettingsPanel({
      capabilities: { status: SettingsActorCapabilityStatus.Error },
      host: SettingsPanelHost.Web,
      registry: createSettingsPanelRegistry([MEMBERS_SETTINGS_PANEL]),
      requestedPanel: SettingsPanelId.Members,
    });

    expect(resolution.status).toBe(
      SettingsPanelResolutionStatus.CapabilityError
    );
  });

  it("resolves forbidden for an actor holding no Members grant", () => {
    const resolution = resolveSettingsPanel({
      capabilities: { grants: {}, status: SettingsActorCapabilityStatus.Ready },
      host: SettingsPanelHost.Web,
      registry: createSettingsPanelRegistry([MEMBERS_SETTINGS_PANEL]),
      requestedPanel: SettingsPanelId.Members,
    });

    expect(resolution.status).toBe(SettingsPanelResolutionStatus.Forbidden);
    expect(resolution.status).not.toBe(
      SettingsPanelResolutionStatus.Unavailable
    );
  });

  it("satisfies the composition root's completeness assertion for its own id", () => {
    // ISS-8370 owns the whole-registry assertion; this pins only that `members`
    // is not among the ids it reports missing — which is what this issue
    // unblocks.
    const registry = createSettingsPanelRegistry([MEMBERS_SETTINGS_PANEL]);

    expect(() => assertSettingsPanelRegistryComplete(registry)).toThrow(
      REGISTRY_INCOMPLETE
    );
    try {
      assertSettingsPanelRegistryComplete(registry);
    } catch (error) {
      expect((error as Error).message).not.toContain(SettingsPanelId.Members);
    }
  });
});
