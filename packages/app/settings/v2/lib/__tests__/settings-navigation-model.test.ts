import {
  SETTINGS_PANEL_GROUP_MEMBERS,
  SETTINGS_PANEL_GROUP_ORDER,
  SETTINGS_PANEL_IDS,
  SettingsActorCapabilityStatus,
  SettingsPanelGroup,
  SettingsPanelHost,
  SettingsPanelId,
  SettingsPanelResolutionStatus,
} from "@repo/api/src/types/settings-panel";
import { describe, expect, it } from "vitest";
import {
  fixturePanel,
  grantRead,
} from "../../test-fixtures/settings-panel-fixtures";
import {
  buildSettingsNavigationModel,
  type SettingsNavigationEntry,
  type SettingsNavigationGroupModel,
} from "../settings-navigation-model";
import { createSettingsPanelRegistry } from "../settings-panel-registry";

function findEntry(
  model: readonly SettingsNavigationGroupModel[],
  id: SettingsPanelId
): SettingsNavigationEntry | undefined {
  for (const group of model) {
    const entry = group.entries.find((candidate) => candidate.id === id);
    if (entry) {
      return entry;
    }
  }
  return undefined;
}

const fullRegistry = createSettingsPanelRegistry(
  SETTINGS_PANEL_IDS.map((id) => fixturePanel(id))
);

describe("buildSettingsNavigationModel", () => {
  it("marks every panel navigable and groups them per the contract order when all reads succeed", () => {
    const model = buildSettingsNavigationModel({
      capabilities: grantRead(...SETTINGS_PANEL_IDS),
      host: SettingsPanelHost.Web,
      registry: fullRegistry,
    });

    expect(model).toEqual(
      SETTINGS_PANEL_GROUP_ORDER.map((group) => ({
        entries: SETTINGS_PANEL_GROUP_MEMBERS[group].map((id) => ({
          id,
          navigable: true,
          ownsCapabilityError: false,
          status: SettingsPanelResolutionStatus.Ready,
        })),
        group,
      }))
    );
  });

  it("includes a pending panel but keeps it non-navigable", () => {
    const model = buildSettingsNavigationModel({
      capabilities: { status: SettingsActorCapabilityStatus.Pending },
      host: SettingsPanelHost.Web,
      registry: fullRegistry,
    });

    expect(findEntry(model, SettingsPanelId.Profile)).toEqual({
      id: SettingsPanelId.Profile,
      navigable: false,
      ownsCapabilityError: false,
      status: SettingsPanelResolutionStatus.Pending,
    });
  });

  it("marks a capability-error panel as owning the error when the surface-wide read succeeded", () => {
    const registry = createSettingsPanelRegistry([
      fixturePanel(SettingsPanelId.Members),
    ]);
    const model = buildSettingsNavigationModel({
      capabilities: {
        status: SettingsActorCapabilityStatus.Ready,
        unreadable: [SettingsPanelId.Members],
      },
      host: SettingsPanelHost.Web,
      registry,
    });

    expect(findEntry(model, SettingsPanelId.Members)).toEqual({
      id: SettingsPanelId.Members,
      navigable: false,
      ownsCapabilityError: true,
      status: SettingsPanelResolutionStatus.CapabilityError,
    });
  });

  it("does not blame a single panel for a capability error when the whole read failed", () => {
    const registry = createSettingsPanelRegistry([
      fixturePanel(SettingsPanelId.Members),
    ]);
    const model = buildSettingsNavigationModel({
      capabilities: { status: SettingsActorCapabilityStatus.Error },
      host: SettingsPanelHost.Web,
      registry,
    });

    expect(findEntry(model, SettingsPanelId.Members)).toEqual({
      id: SettingsPanelId.Members,
      navigable: false,
      ownsCapabilityError: false,
      status: SettingsPanelResolutionStatus.CapabilityError,
    });
  });

  it("excludes a forbidden panel from the navigation model", () => {
    const grantedIds = SETTINGS_PANEL_IDS.filter(
      (id) => id !== SettingsPanelId.Members
    );
    const model = buildSettingsNavigationModel({
      capabilities: grantRead(...grantedIds),
      host: SettingsPanelHost.Web,
      registry: fullRegistry,
    });

    expect(findEntry(model, SettingsPanelId.Members)).toBeUndefined();
    const orgGroup = model.find(
      (group) => group.group === SettingsPanelGroup.Organization
    );
    expect(orgGroup?.entries.map((entry) => entry.id)).toEqual([
      SettingsPanelId.OrganizationGeneral,
    ]);
  });

  it("excludes a panel this host does not offer from the navigation model", () => {
    const registry = createSettingsPanelRegistry(
      SETTINGS_PANEL_IDS.map((id) =>
        id === SettingsPanelId.Members
          ? fixturePanel(id, { hosts: [SettingsPanelHost.Desktop] })
          : fixturePanel(id)
      )
    );
    const model = buildSettingsNavigationModel({
      capabilities: grantRead(...SETTINGS_PANEL_IDS),
      host: SettingsPanelHost.Web,
      registry,
    });

    expect(findEntry(model, SettingsPanelId.Members)).toBeUndefined();
    const orgGroup = model.find(
      (group) => group.group === SettingsPanelGroup.Organization
    );
    expect(orgGroup?.entries.map((entry) => entry.id)).toEqual([
      SettingsPanelId.OrganizationGeneral,
    ]);
  });

  it("excludes an unregistered panel id from the navigation model", () => {
    const registry = createSettingsPanelRegistry(
      SETTINGS_PANEL_IDS.filter((id) => id !== SettingsPanelId.Members).map(
        (id) => fixturePanel(id)
      )
    );
    const model = buildSettingsNavigationModel({
      capabilities: grantRead(...SETTINGS_PANEL_IDS),
      host: SettingsPanelHost.Web,
      registry,
    });

    expect(findEntry(model, SettingsPanelId.Members)).toBeUndefined();
    const orgGroup = model.find(
      (group) => group.group === SettingsPanelGroup.Organization
    );
    expect(orgGroup?.entries.map((entry) => entry.id)).toEqual([
      SettingsPanelId.OrganizationGeneral,
    ]);
  });

  it("drops a group entirely when every member panel is excluded", () => {
    const registry = createSettingsPanelRegistry(
      SETTINGS_PANEL_IDS.filter(
        (id) =>
          id !== SettingsPanelId.OrganizationGeneral &&
          id !== SettingsPanelId.Members
      ).map((id) => fixturePanel(id))
    );
    const model = buildSettingsNavigationModel({
      capabilities: grantRead(...SETTINGS_PANEL_IDS),
      host: SettingsPanelHost.Web,
      registry,
    });

    expect(model.map((group) => group.group)).toEqual([
      SettingsPanelGroup.User,
      SettingsPanelGroup.Labs,
    ]);
  });

  it("orders groups and their entries by the contract, independent of registration order", () => {
    const registry = createSettingsPanelRegistry(
      [...SETTINGS_PANEL_IDS].reverse().map((id) => fixturePanel(id))
    );
    const model = buildSettingsNavigationModel({
      capabilities: grantRead(...SETTINGS_PANEL_IDS),
      host: SettingsPanelHost.Web,
      registry,
    });

    expect(model.map((group) => group.group)).toEqual([
      ...SETTINGS_PANEL_GROUP_ORDER,
    ]);
    for (const group of model) {
      expect(group.entries.map((entry) => entry.id)).toEqual([
        ...SETTINGS_PANEL_GROUP_MEMBERS[group.group],
      ]);
    }
  });
});
