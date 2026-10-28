import { AGENTS_NAV_FLAG_KEY } from "@repo/api/src/types/agents-nav-flag";
import { DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/diagnostics-complete-surface-flag";
import { HELP_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/help-complete-surface-flag";
import { INSIGHTS_FEATURE_FLAG_KEY } from "@repo/api/src/types/insights";
import { NAVIGATION_DESTINATION_LIMIT } from "@repo/api/src/types/navigation-view-model";
import { describe, expect, it } from "vitest";
import { ArtifactFlag } from "../artifact-flags";
import {
  JUDGES_FEATURE_FLAG_KEY,
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  LOST_WORK_NAV_FEATURE_FLAG_KEY,
  TOKENOPS_WASTE_NAV_FEATURE_FLAG_KEY,
} from "../feature-flags";
import {
  resolveShellExtensionProviders,
  SHELL_AGENTS_NAV_GATE_KEY,
  SHELL_CANONICAL_LANDING_ROUTE_ID,
  SHELL_DESKTOP_DOCS_HELP_NAV_GATE_KEY,
  SHELL_DESKTOP_LABS_NAV_GATE_KEY,
  SHELL_EXTENSION_SLOTS,
  SHELL_EXTENSION_TARGET_IDS,
  SHELL_INSIGHTS_NAV_GATE_KEY,
  SHELL_JUDGES_NAV_GATE_KEY,
  SHELL_NAVIGATION_GROUPS,
  SHELL_NAVIGATION_ITEMS,
  SHELL_NAVIGATION_ROUTE_IDS,
  SHELL_WEB_LABS_NAV_GATE_KEY,
  ShellExtensionSlot,
  ShellNavigationGateKind,
  ShellNavigationGroupId,
  ShellNavigationIconToken,
  ShellNavigationItemId,
  ShellNavigationItemKind,
  ShellNavigationRouteId,
  ShellNavigationSurface,
  shellNavigationGateKeys,
} from "../shell-navigation-contract";

describe("shell navigation contract", () => {
  it("keeps route, group, item, slot, and target ids unique", () => {
    expect(hasUniqueValues(SHELL_NAVIGATION_ROUTE_IDS)).toBe(true);
    expect(
      hasUniqueValues(SHELL_NAVIGATION_GROUPS.map((group) => group.id))
    ).toBe(true);
    expect(hasUniqueValues(SHELL_NAVIGATION_ITEMS.map((item) => item.id))).toBe(
      true
    );
    expect(hasUniqueValues(SHELL_EXTENSION_SLOTS)).toBe(true);
    expect(hasUniqueValues(SHELL_EXTENSION_TARGET_IDS)).toBe(true);
  });

  it("keeps nested groups one level deep", () => {
    const groupsById = new Map(
      SHELL_NAVIGATION_GROUPS.map((group) => [group.id, group])
    );

    for (const group of SHELL_NAVIGATION_GROUPS) {
      if (!group.parentId) {
        continue;
      }
      const parent = groupsById.get(group.parentId);
      expect(parent).toBeDefined();
      expect(parent?.parentId).toBeUndefined();
    }
  });

  it("declares the Web Master v2 shell groups and dynamic identities", () => {
    const itemById = itemDescriptorById();

    expect(SHELL_CANONICAL_LANDING_ROUTE_ID).toBe(
      ShellNavigationRouteId.Dashboard
    );
    expect(itemById.get(ShellNavigationItemId.Dashboard)).toMatchObject({
      groupId: ShellNavigationGroupId.Primary,
      iconToken: ShellNavigationIconToken.Dashboard,
      kind: ShellNavigationItemKind.Route,
      label: "Dashboard",
      routeId: ShellNavigationRouteId.Dashboard,
    });
    expect(itemById.get(ShellNavigationItemId.Sessions)).toMatchObject({
      groupId: ShellNavigationGroupId.Artifacts,
      iconToken: ShellNavigationIconToken.Sessions,
      label: "Sessions",
      routeId: ShellNavigationRouteId.Sessions,
    });
    expect(itemById.get(ShellNavigationItemId.Branches)).toMatchObject({
      groupId: ShellNavigationGroupId.Artifacts,
      iconToken: ShellNavigationIconToken.Branches,
      label: "Branches",
      routeId: ShellNavigationRouteId.Branches,
    });
    expect(itemById.get(ShellNavigationItemId.Search)).toMatchObject({
      groupId: ShellNavigationGroupId.Labs,
      kind: ShellNavigationItemKind.Control,
    });
    expect(itemById.get(ShellNavigationItemId.Inbox)).toMatchObject({
      groupId: ShellNavigationGroupId.Labs,
      routeId: ShellNavigationRouteId.Inbox,
    });
    expect(itemById.get(ShellNavigationItemId.MyIssues)).toMatchObject({
      groupId: ShellNavigationGroupId.Labs,
      routeId: ShellNavigationRouteId.MyIssues,
    });
    expect(itemById.get(ShellNavigationItemId.Insights)).toMatchObject({
      groupId: ShellNavigationGroupId.Labs,
      routeId: ShellNavigationRouteId.Insights,
    });
    expect(itemById.get(ShellNavigationItemId.Approvals)).toMatchObject({
      groupId: ShellNavigationGroupId.Labs,
      routeId: ShellNavigationRouteId.Approvals,
    });
    expect(itemById.get(ShellNavigationItemId.Requests)).toMatchObject({
      groupId: ShellNavigationGroupId.Labs,
      routeId: ShellNavigationRouteId.Requests,
    });
    expect(itemById.get(ShellNavigationItemId.Documents)).toMatchObject({
      groupId: ShellNavigationGroupId.Artifacts,
      routeId: ShellNavigationRouteId.Documents,
    });
    expect(itemById.get(ShellNavigationItemId.Issues)).toMatchObject({
      groupId: ShellNavigationGroupId.Artifacts,
      routeId: ShellNavigationRouteId.Issues,
    });
    expect(itemById.get(ShellNavigationItemId.Agents)).toMatchObject({
      groupId: ShellNavigationGroupId.LabsArtifacts,
      routeId: ShellNavigationRouteId.Agents,
    });
    expect(itemById.get(ShellNavigationItemId.Teams)).toMatchObject({
      groupId: ShellNavigationGroupId.LabsTeams,
      kind: ShellNavigationItemKind.DynamicSection,
    });
    expect(itemById.get(ShellNavigationItemId.TeamFavorites)).toMatchObject({
      groupId: ShellNavigationGroupId.LabsTeams,
      kind: ShellNavigationItemKind.DynamicSection,
    });
  });

  it("keeps My Issues distinct from the current My Tasks compatibility route", () => {
    const itemById = itemDescriptorById();

    expect(itemById.get(ShellNavigationItemId.MyIssues)).toMatchObject({
      label: "My Issues",
      routeId: ShellNavigationRouteId.MyIssues,
    });
    expect(itemById.get(ShellNavigationItemId.MyTasks)).toMatchObject({
      label: "My Tasks",
      routeId: ShellNavigationRouteId.MyTasks,
    });
  });

  it("aligns exported feature-flag gate keys with canonical keys", () => {
    expect(SHELL_WEB_LABS_NAV_GATE_KEY).toBe(LABS_NAV_SECTION_FEATURE_FLAG_KEY);
    expect(SHELL_INSIGHTS_NAV_GATE_KEY).toBe(INSIGHTS_FEATURE_FLAG_KEY);
    expect(SHELL_AGENTS_NAV_GATE_KEY).toBe(AGENTS_NAV_FLAG_KEY);
    expect(SHELL_JUDGES_NAV_GATE_KEY).toBe(JUDGES_FEATURE_FLAG_KEY);
  });

  it("declares the Web and Desktop Labs container gates separately", () => {
    const groupsById = new Map(
      SHELL_NAVIGATION_GROUPS.map((group) => [group.id, group])
    );

    expect(
      groupsById.get(ShellNavigationGroupId.Labs)?.gates?.[
        ShellNavigationSurface.Web
      ]
    ).toEqual(webFeatureFlagGates(LABS_NAV_SECTION_FEATURE_FLAG_KEY));
    expect(
      groupsById.get(ShellNavigationGroupId.Labs)?.gates?.[
        ShellNavigationSurface.Desktop
      ]
    ).toEqual([desktopLabsContainerGate()]);
  });

  it("declares surface-specific gate stacks for gated shell items", () => {
    const itemById = itemDescriptorById();

    expect(
      itemById.get(ShellNavigationItemId.Insights)?.gates?.[
        ShellNavigationSurface.Web
      ]
    ).toEqual(
      webFeatureFlagGates(
        LABS_NAV_SECTION_FEATURE_FLAG_KEY,
        INSIGHTS_FEATURE_FLAG_KEY
      )
    );
    expect(
      itemById.get(ShellNavigationItemId.Insights)?.gates?.[
        ShellNavigationSurface.Desktop
      ]
    ).toEqual([desktopLabsContainerGate()]);
    expect(
      itemById.get(ShellNavigationItemId.Judges)?.gates?.[
        ShellNavigationSurface.Web
      ]
    ).toEqual(
      webFeatureFlagGates(
        LABS_NAV_SECTION_FEATURE_FLAG_KEY,
        JUDGES_FEATURE_FLAG_KEY
      )
    );
    expect(
      itemById.get(ShellNavigationItemId.LostWork)?.gates?.[
        ShellNavigationSurface.Web
      ]
    ).toEqual(
      webFeatureFlagGates(
        LABS_NAV_SECTION_FEATURE_FLAG_KEY,
        LOST_WORK_NAV_FEATURE_FLAG_KEY
      )
    );
    expect(
      itemById.get(ShellNavigationItemId.TokenOpsWaste)?.gates?.[
        ShellNavigationSurface.Web
      ]
    ).toEqual(
      webFeatureFlagGates(
        LABS_NAV_SECTION_FEATURE_FLAG_KEY,
        TOKENOPS_WASTE_NAV_FEATURE_FLAG_KEY
      )
    );
    expect(
      itemById.get(ShellNavigationItemId.Packs)?.gates?.[
        ShellNavigationSurface.Web
      ]
    ).toEqual(webFeatureFlagGates(LABS_NAV_SECTION_FEATURE_FLAG_KEY));
    expect(
      itemById.get(ShellNavigationItemId.Packs)?.gates?.[
        ShellNavigationSurface.Desktop
      ]
    ).toEqual([desktopLabsContainerGate()]);
    expect(
      itemById.get(ShellNavigationItemId.Issues)?.gates?.[
        ShellNavigationSurface.Web
      ]
    ).toEqual(webFeatureFlagGates(ArtifactFlag.Issues));
    expect(
      itemById.get(ShellNavigationItemId.Issues)?.gates?.[
        ShellNavigationSurface.Desktop
      ]
    ).toEqual([desktopLabsItemGate(ArtifactFlag.Issues)]);
    expect(
      itemById.get(ShellNavigationItemId.Documents)?.gates?.[
        ShellNavigationSurface.Web
      ]
    ).toEqual(webFeatureFlagGates(ArtifactFlag.Documents));
    expect(
      itemById.get(ShellNavigationItemId.Documents)?.gates?.[
        ShellNavigationSurface.Desktop
      ]
    ).toEqual([desktopLabsItemGate(ArtifactFlag.Documents)]);
    expect(
      itemById.get(ShellNavigationItemId.Agents)?.gates?.[
        ShellNavigationSurface.Web
      ]
    ).toEqual(webFeatureFlagGates(AGENTS_NAV_FLAG_KEY));
    expect(
      itemById.get(ShellNavigationItemId.Agents)?.gates?.[
        ShellNavigationSurface.Desktop
      ]
    ).toEqual([
      desktopLabsContainerGate(),
      desktopLabsItemGate(AGENTS_NAV_FLAG_KEY),
    ]);
    expect(
      itemById.get(ShellNavigationItemId.Plans)?.gates?.[
        ShellNavigationSurface.Desktop
      ]
    ).toEqual([desktopLabsContainerGate()]);
    expect(
      itemById.get(ShellNavigationItemId.Help)?.gates?.[
        ShellNavigationSurface.Desktop
      ]
    ).toEqual([
      desktopLabsContainerGate(),
      desktopLabsItemGate(SHELL_DESKTOP_DOCS_HELP_NAV_GATE_KEY),
    ]);
  });

  it("leaves ungated shell items without a gate stack", () => {
    const itemById = itemDescriptorById();

    expect(
      itemById.get(ShellNavigationItemId.Dashboard)?.gates
    ).toBeUndefined();
    expect(itemById.get(ShellNavigationItemId.Sessions)?.gates).toBeUndefined();
    expect(itemById.get(ShellNavigationItemId.Branches)?.gates).toBeUndefined();
  });

  it("does not collapse Web and Desktop gates into one surface", () => {
    const itemById = itemDescriptorById();

    expect(
      itemById.get(ShellNavigationItemId.Insights)?.gates?.[
        ShellNavigationSurface.Web
      ]
    ).not.toEqual(
      itemById.get(ShellNavigationItemId.Insights)?.gates?.[
        ShellNavigationSurface.Desktop
      ]
    );
    expect(
      itemById.get(ShellNavigationItemId.Agents)?.gates?.[
        ShellNavigationSurface.Desktop
      ]
    ).not.toEqual(
      itemById.get(ShellNavigationItemId.Agents)?.gates?.[
        ShellNavigationSurface.Web
      ]
    );
  });

  it("declares a route item for every shell route id", () => {
    const routeItemRouteIds = new Set(
      SHELL_NAVIGATION_ITEMS.filter(
        (item) => item.kind === ShellNavigationItemKind.Route
      ).map((item) => item.routeId)
    );

    for (const routeId of SHELL_NAVIGATION_ROUTE_IDS) {
      expect(routeItemRouteIds.has(routeId)).toBe(true);
    }
  });

  it("places My Tasks and Packs under Labs", () => {
    const itemById = itemDescriptorById();

    expect(itemById.get(ShellNavigationItemId.MyTasks)?.groupId).toBe(
      ShellNavigationGroupId.Labs
    );
    expect(itemById.get(ShellNavigationItemId.Packs)?.groupId).toBe(
      ShellNavigationGroupId.Labs
    );
  });

  it("keeps every route item within what one view-model read may request", () => {
    const routeItems = SHELL_NAVIGATION_ITEMS.filter(
      (item) => item.kind === ShellNavigationItemKind.Route
    );

    expect(routeItems.length).toBeLessThanOrEqual(NAVIGATION_DESTINATION_LIMIT);
  });

  it("collects each surface's gate keys once each", () => {
    const webKeys = shellNavigationGateKeys(ShellNavigationSurface.Web);

    expect(new Set(webKeys)).toEqual(
      new Set([
        LABS_NAV_SECTION_FEATURE_FLAG_KEY,
        INSIGHTS_FEATURE_FLAG_KEY,
        ArtifactFlag.Documents,
        ArtifactFlag.Issues,
        AGENTS_NAV_FLAG_KEY,
        JUDGES_FEATURE_FLAG_KEY,
        LOST_WORK_NAV_FEATURE_FLAG_KEY,
        TOKENOPS_WASTE_NAV_FEATURE_FLAG_KEY,
        DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY,
        HELP_COMPLETE_SURFACE_FLAG_KEY,
      ])
    );
    expect(webKeys).toHaveLength(new Set(webKeys).size);
    expect(
      new Set(shellNavigationGateKeys(ShellNavigationSurface.Desktop))
    ).toEqual(
      new Set([
        SHELL_DESKTOP_LABS_NAV_GATE_KEY,
        ArtifactFlag.Documents,
        ArtifactFlag.Issues,
        AGENTS_NAV_FLAG_KEY,
        SHELL_DESKTOP_DOCS_HELP_NAV_GATE_KEY,
      ])
    );
  });

  it("drops absent, disabled, unknown-slot, and unknown-target extension providers", () => {
    expect(resolveShellExtensionProviders(null)).toEqual([]);
    expect(resolveShellExtensionProviders(undefined)).toEqual([]);

    const resolved = resolveShellExtensionProviders([
      {
        id: "unknown_slot",
        slot: "toolbar",
        targetId: ShellNavigationItemId.Search,
      },
      {
        id: "disabled",
        slot: ShellExtensionSlot.ContentBanner,
        targetId: ShellNavigationItemId.Dashboard,
        enabled: false,
      },
      {
        id: "unknown_target",
        slot: ShellExtensionSlot.ContentBanner,
        targetId: "unknown_target",
      },
      {
        id: "a_second",
        slot: ShellExtensionSlot.SidebarFooter,
        targetId: ShellNavigationItemId.DevMode,
        order: 20,
      },
      {
        id: "b_first",
        slot: ShellExtensionSlot.SidebarFooter,
        targetId: ShellNavigationItemId.Search,
        order: 10,
      },
      {
        id: "content_banner",
        slot: ShellExtensionSlot.ContentBanner,
      },
      {
        id: "slot_provider",
        slot: ShellExtensionSlot.Overlay,
      },
    ]);

    expect(resolved).toEqual([
      {
        id: "b_first",
        order: 10,
        slot: ShellExtensionSlot.SidebarFooter,
        targetId: ShellNavigationItemId.Search,
      },
      {
        id: "a_second",
        order: 20,
        slot: ShellExtensionSlot.SidebarFooter,
        targetId: ShellNavigationItemId.DevMode,
      },
      {
        id: "content_banner",
        slot: ShellExtensionSlot.ContentBanner,
      },
      {
        id: "slot_provider",
        slot: ShellExtensionSlot.Overlay,
      },
    ]);
  });
});

function hasUniqueValues(values: readonly string[]) {
  return new Set(values).size === values.length;
}

function itemDescriptorById() {
  return new Map(SHELL_NAVIGATION_ITEMS.map((item) => [item.id, item]));
}

function webFeatureFlagGates(...keys: string[]) {
  return keys.map((key) => ({
    kind: ShellNavigationGateKind.WebFeatureFlag,
    key,
  }));
}

function desktopLabsContainerGate() {
  return {
    kind: ShellNavigationGateKind.DesktopLabsContainer,
    key: SHELL_DESKTOP_LABS_NAV_GATE_KEY,
  };
}

function desktopLabsItemGate(key: string) {
  return {
    kind: ShellNavigationGateKind.DesktopLabsItem,
    key,
  };
}
