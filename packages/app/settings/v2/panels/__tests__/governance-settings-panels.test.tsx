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
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../../shared/feature-flags/provider";
import { ARTIFACT_TAGS_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import { createSettingsPanelRegistry } from "../../lib/settings-panel-registry";
import { resolveSettingsPanel } from "../../lib/settings-panel-resolution";
import { useGovernanceSettingsPanels } from "../governance-settings-panels";

// Pinned as a raw literal rather than against the constant, which would assert
// nothing. This is the PostHog key an operator types into the dashboard;
// renaming the constant without renaming the flag silently withdraws Tags.
//
// ISS-10244 retired `settings-governance-panels`, the PACKAGE gate that used to
// sit above this one. `artifact-tags` is not a rollout flag and stays.
const EXPECTED_TAGS_FLAG_KEY = "artifact-tags";

// The three ids this issue owns, written out rather than derived from the
// module under test — deriving them would keep this green if a panel were
// dropped from the registration list.
const OWNED_PANEL_IDS = ["custom-fields", "tags", "compliance"] as const;

function wrapperWithFlags(enabled: readonly string[]) {
  return ({ children }: { children: ReactNode }) => (
    <FeatureFlagAdapterProvider
      adapter={{
        useFeatureFlagEnabled: (key: string) => enabled.includes(key),
      }}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}

function panelsWithFlags(enabled: readonly string[]) {
  return renderHook(() => useGovernanceSettingsPanels(), {
    wrapper: wrapperWithFlags(enabled),
  }).result.current;
}

function capabilitiesFor(role: SettingsActorRole) {
  return projectSettingsViewModel({
    resolution: { role, status: SettingsActorRoleStatus.Resolved },
    staleSessionRole: false,
  }).capabilities;
}

describe("useGovernanceSettingsPanels", () => {
  it("registers all three in contract navigation order when the tags capability is on", () => {
    const registry = createSettingsPanelRegistry(
      panelsWithFlags([EXPECTED_TAGS_FLAG_KEY])
    );

    expect([...registry.ids]).toEqual([...OWNED_PANEL_IDS]);
  });

  it("withholds ONLY Tags when the artifact-tags capability is off", () => {
    // The case a future edit is most likely to break by registering Tags
    // unconditionally. `artifact-tags` is not a rollout flag for this work: it
    // decides whether tags exist in the product at all, and legacy Settings
    // hides its Tags tab behind it. Registering the v2 panel without consulting
    // it would resurrect a capability an operator switched off.
    const registry = createSettingsPanelRegistry(panelsWithFlags([]));

    expect([...registry.ids]).toEqual([
      SettingsPanelId.CustomFields,
      SettingsPanelId.Compliance,
    ]);
    expect(registry.has(SettingsPanelId.Tags)).toBe(false);
  });

  it("withholds Tags when no feature-flag provider is mounted", () => {
    // A bare tree (Storybook, a mini test host) must resolve the capability
    // CLOSED rather than throw or, worse, fall open — the other two panels are
    // unconditional and must still be there.
    const { result } = renderHook(() => useGovernanceSettingsPanels());

    expect(result.current.map((panel) => panel.id)).toEqual([
      SettingsPanelId.CustomFields,
      SettingsPanelId.Compliance,
    ]);
  });

  it("reads the PostHog key an operator actually sets, and only that key", () => {
    expect(ARTIFACT_TAGS_FEATURE_FLAG_KEY).toBe(EXPECTED_TAGS_FLAG_KEY);

    // A neighbouring flag must not stand in for the tags capability.
    expect(
      panelsWithFlags(["some-other-flag"]).map((panel) => panel.id)
    ).toEqual([SettingsPanelId.CustomFields, SettingsPanelId.Compliance]);
  });
});

describe("governance settings panel descriptors", () => {
  const panels = panelsWithFlags([EXPECTED_TAGS_FLAG_KEY]);
  const byId = new Map(panels.map((panel) => [panel.id, panel]));

  it("offers all three panels on BOTH hosts", () => {
    // Every one reads a cloud API through the shared client; none carries a
    // web-only concept the way Plugins (browser OAuth redirect) or Organization
    // General (workspace URL) do.
    for (const id of OWNED_PANEL_IDS) {
      const hosts = byId.get(id)?.hosts ?? [];
      expect(hosts.includes(SettingsPanelHost.Web), id).toBe(true);
      expect(hosts.includes(SettingsPanelHost.Desktop), id).toBe(true);
    }
  });

  it("asks for Read on every panel, leaving the denial to the policy table", () => {
    // Compliance is admin-and-owner-only, but that rule lives in
    // SETTINGS_DOMAIN_ACCESS_POLICY. A descriptor restating `Admin` would be
    // the same rule written twice, and the copy that goes stale first.
    for (const id of OWNED_PANEL_IDS) {
      expect(byId.get(id)?.requiredCapability, id).toBe(
        SettingsPanelCapability.Read
      );
    }
  });
});

describe("governance panels resolved against the real role policy", () => {
  const registry = createSettingsPanelRegistry(
    panelsWithFlags([EXPECTED_TAGS_FLAG_KEY])
  );

  function resolve(panel: SettingsPanelId, role: SettingsActorRole) {
    return resolveSettingsPanel({
      capabilities: capabilitiesFor(role),
      host: SettingsPanelHost.Web,
      registry,
      requestedPanel: panel,
    }).status;
  }

  it("refuses Compliance to a member and admits an admin", () => {
    // The one gated READ in the policy table: GET /agent-components/compliance
    // calls isOrgAdmin and answers 403, so the panel must not open for a member
    // even though its descriptor only asks for Read.
    expect(resolve(SettingsPanelId.Compliance, SettingsActorRole.Member)).toBe(
      SettingsPanelResolutionStatus.Forbidden
    );
    expect(resolve(SettingsPanelId.Compliance, SettingsActorRole.Admin)).toBe(
      SettingsPanelResolutionStatus.Ready
    );
  });

  it("admits a member to Custom Fields and Tags, which the routes already allow", () => {
    // GET /custom-fields and every /tags route are open to any member. The
    // legacy tab hides Custom Fields behind one browser-side isAdmin, which
    // withholds a read the server has always permitted; v2 mirrors the routes.
    expect(
      resolve(SettingsPanelId.CustomFields, SettingsActorRole.Member)
    ).toBe(SettingsPanelResolutionStatus.Ready);
    expect(resolve(SettingsPanelId.Tags, SettingsActorRole.Member)).toBe(
      SettingsPanelResolutionStatus.Ready
    );
  });
});
