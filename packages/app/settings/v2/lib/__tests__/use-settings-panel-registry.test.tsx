import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../../shared/feature-flags/provider";
import { ARTIFACT_TAGS_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import { fixturePanel } from "../../test-fixtures/settings-panel-fixtures";
import {
  SHARED_SETTINGS_PANEL_DESCRIPTORS,
  useSharedSettingsPanelRegistry,
} from "../use-settings-panel-registry";

// ISS-10244 retired the three panel-package rollout gates. `artifact-tags` is
// the one leaf key left, and it gates a product capability rather than a ramp.
const EVERY_LEAF_FLAG = [ARTIFACT_TAGS_FEATURE_FLAG_KEY];

// Every shared id except Tags — what the registry holds with the tags
// capability switched off. Written in CONTRACT navigation order, which is what
// `registry.ids` reports (`SETTINGS_PANEL_IDS`), never registration order.
const SHARED_IDS_WITHOUT_TAGS = [
  SettingsPanelId.ConnectedDevices,
  SettingsPanelId.Plugins,
  SettingsPanelId.OrganizationGeneral,
  SettingsPanelId.CustomFields,
  SettingsPanelId.Compliance,
  SettingsPanelId.ApiKeys,
  SettingsPanelId.OtherLabs,
];

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

const WEB_EXTRA = Object.freeze([fixturePanel("profile")]);

/**
 * ISS-8370 D4/D5 — the RENDERED registry. The hook adds no read site of its own;
 * the one surviving leaf key is read by `useGovernanceSettingsPanels`.
 */
describe("useSharedSettingsPanelRegistry", () => {
  it("registers every shared descriptor but Tags when the tags capability is closed", () => {
    const { result } = renderHook(() => useSharedSettingsPanelRegistry(), {
      wrapper: wrapperWithFlags([]),
    });

    expect([...result.current.ids]).toEqual(SHARED_IDS_WITHOUT_TAGS);
  });

  it("registers all eight shared descriptors when every leaf flag is open", () => {
    const { result } = renderHook(() => useSharedSettingsPanelRegistry(), {
      wrapper: wrapperWithFlags(EVERY_LEAF_FLAG),
    });

    expect(result.current.ids).toHaveLength(
      SHARED_SETTINGS_PANEL_DESCRIPTORS.length
    );
    for (const descriptor of SHARED_SETTINGS_PANEL_DESCRIPTORS) {
      expect(result.current.get(descriptor.id)).toBe(descriptor);
    }
  });

  it("spreads the host's own descriptors into the same registry", () => {
    const { result } = renderHook(
      () => useSharedSettingsPanelRegistry(WEB_EXTRA),
      { wrapper: wrapperWithFlags([]) }
    );

    expect([...result.current.ids]).toEqual([
      SettingsPanelId.Profile,
      ...SHARED_IDS_WITHOUT_TAGS,
    ]);
  });

  it("withholds Tags with no feature-flag provider mounted at all", () => {
    const { result } = renderHook(() => useSharedSettingsPanelRegistry());

    expect([...result.current.ids]).toEqual(SHARED_IDS_WITHOUT_TAGS);
  });
});
