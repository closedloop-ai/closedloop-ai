import { FEATURE_FLAG_OVERRIDES_STORAGE_KEY } from "@repo/api/src/types/feature-flag-overrides";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  DevModeEligibility,
  DevModeProvider,
} from "../../../feature-flags/dev-mode/dev-mode-provider";
import { FeatureFlagAdapterProvider } from "../../../feature-flags/provider";
import {
  GOOGLE_DRIVE_FEATURE_FLAG_KEY,
  SESSIONS_PROJECT_FACET_FEATURE_FLAG_KEY,
} from "../../../lib/feature-flags";
import {
  readCheckedFeatureFlags,
  recordCheckedFeatureFlags,
  resetCheckedFeatureFlags,
} from "../../lib/checked-feature-flags-store";
import {
  DEV_TOOLS_ALL_FLAGS_LABEL,
  DEV_TOOLS_LABEL,
  DEV_TOOLS_ON_THIS_PAGE_LABEL,
  DEV_TOOLS_RESET_TO_PROD_LABEL,
  DEV_TOOLS_SETTING_LABELS,
  DEV_TOOLS_UNKNOWN_LABEL,
} from "../../lib/dev-tools-copy";
import { createDevToolsRegistry } from "../../lib/dev-tools-registry";
import { DevToolsSetting } from "../../lib/dev-tools-settings";
import { FEATURE_FLAGS_DEV_TOOLS_SECTION } from "../../lib/feature-flags-dev-tools-section";
import { DevToolsOverlay } from "../dev-tools-overlay";

const CHECKED_FLAG = "session-trace-tab";
const OTHER_CHECKED_FLAG = "artifact-tags";
const UNSET_FLAG = SESSIONS_PROJECT_FACET_FEATURE_FLAG_KEY;
const UNKNOWN_FLAG = GOOGLE_DRIVE_FEATURE_FLAG_KEY;
const RESTRICTION_FLAG = "compute-target-signing";
const REGISTRY = createDevToolsRegistry([FEATURE_FLAGS_DEV_TOOLS_SECTION]);
const ON = DEV_TOOLS_SETTING_LABELS[DevToolsSetting.On];
const OFF = DEV_TOOLS_SETTING_LABELS[DevToolsSetting.Off];

afterEach(() => {
  cleanup();
  resetCheckedFeatureFlags();
  localStorage.removeItem(FEATURE_FLAG_OVERRIDES_STORAGE_KEY);
});

/**
 * Mounts the real feature-flags section with an adapter whose production values
 * are known: the checked flag is ON in production, the other checked flag OFF,
 * the unset flag reported `false` as both shells' adapters report a flag unset
 * in production, and every other flag not answered yet (`undefined`).
 */
function renderFlagsOverlay() {
  const navigation = createMemoryNavigation({ initialPath: "/sessions" });
  render(
    <NavigationProvider adapter={navigation.adapter}>
      <FeatureFlagAdapterProvider
        adapter={{
          useFeatureFlagEnabled: () => false,
          useFeatureFlagProductionValue: (key) => PRODUCTION_VALUES.get(key),
        }}
      >
        <DevModeProvider eligibility={DevModeEligibility.Eligible} isRolledOut>
          <DevToolsOverlay registry={REGISTRY} />
        </DevModeProvider>
      </FeatureFlagAdapterProvider>
    </NavigationProvider>
  );
  return navigation;
}

async function openPanel() {
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: DEV_TOOLS_LABEL });
  await user.click(trigger);
  const panel = document.getElementById(
    trigger.getAttribute("aria-controls") ?? ""
  );
  if (!panel) {
    throw new Error("Dev Tools panel did not open");
  }
  return { user, panel };
}

function groupNames(panel: HTMLElement): (string | null)[] {
  return [...panel.querySelectorAll('[role="radiogroup"]')].map(
    (group) =>
      document.getElementById(group.getAttribute("aria-labelledby") ?? "")
        ?.textContent ?? null
  );
}

describe("the feature flags section's page-checked view (ISS-12048)", () => {
  it("lists only the flags this page checked, sorted, without restriction flags", async () => {
    renderFlagsOverlay();
    act(() => {
      recordCheckedFeatureFlags([
        CHECKED_FLAG,
        OTHER_CHECKED_FLAG,
        RESTRICTION_FLAG,
      ]);
    });
    const { panel } = await openPanel();

    expect(groupNames(panel)).toEqual([OTHER_CHECKED_FLAG, CHECKED_FLAG]);
    expect(
      within(panel).queryByText(DEV_TOOLS_ON_THIS_PAGE_LABEL)
    ).not.toBeInTheDocument();
  });

  it("shows every flag under All flags, the checked ones first under their heading", async () => {
    renderFlagsOverlay();
    act(() => {
      recordCheckedFeatureFlags([CHECKED_FLAG]);
    });
    const { user, panel } = await openPanel();

    await user.click(within(panel).getByLabelText(DEV_TOOLS_ALL_FLAGS_LABEL));

    const names = groupNames(panel);
    expect(within(panel).getByText(DEV_TOOLS_ON_THIS_PAGE_LABEL)).toBeVisible();
    expect(names[0]).toBe(CHECKED_FLAG);
    expect(names.filter((name) => name === CHECKED_FLAG)).toHaveLength(1);
    expect(names).toHaveLength(FEATURE_FLAGS_DEV_TOOLS_SECTION.controls.length);
    expect(names).not.toContain(RESTRICTION_FLAG);
  });

  it("shows each flag at its production value, with only On and Off", async () => {
    renderFlagsOverlay();
    act(() => {
      recordCheckedFeatureFlags([CHECKED_FLAG, OTHER_CHECKED_FLAG]);
    });
    const { panel } = await openPanel();

    expect(checkedSetting(panel, CHECKED_FLAG)).toBe(ON);
    expect(checkedSetting(panel, OTHER_CHECKED_FLAG)).toBe(OFF);
    expect(
      within(radioGroup(panel, CHECKED_FLAG))
        .getAllByRole("radio")
        .map((radio) => radio.textContent)
    ).toEqual([ON, OFF]);
    expect(localStorage.getItem(FEATURE_FLAG_OVERRIDES_STORAGE_KEY)).toBeNull();
  });

  it("stores an override away from production and clears it on choosing the production value again", async () => {
    renderFlagsOverlay();
    act(() => {
      recordCheckedFeatureFlags([CHECKED_FLAG]);
    });
    const { user, panel } = await openPanel();

    await user.click(radio(panel, CHECKED_FLAG, OFF));
    expect(readStoredOverrides()).toEqual({ [CHECKED_FLAG]: false });
    expect(checkedSetting(panel, CHECKED_FLAG)).toBe(OFF);

    await user.click(radio(panel, CHECKED_FLAG, ON));
    expect(readStoredOverrides()).toEqual({});
    expect(checkedSetting(panel, CHECKED_FLAG)).toBe(ON);
  });

  it("starts a flag unset in production at Off, stores On, and clears on Off", async () => {
    renderFlagsOverlay();
    act(() => {
      recordCheckedFeatureFlags([UNSET_FLAG]);
    });
    const { user, panel } = await openPanel();

    expect(checkedSetting(panel, UNSET_FLAG)).toBe(OFF);

    await user.click(radio(panel, UNSET_FLAG, ON));
    expect(readStoredOverrides()).toEqual({ [UNSET_FLAG]: true });

    await user.click(radio(panel, UNSET_FLAG, OFF));
    expect(readStoredOverrides()).toEqual({});
    expect(checkedSetting(panel, UNSET_FLAG)).toBe(OFF);
  });

  it("clears an override that equals production when its value is chosen again", async () => {
    localStorage.setItem(
      FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
      JSON.stringify({ [CHECKED_FLAG]: true, [OTHER_CHECKED_FLAG]: true })
    );
    renderFlagsOverlay();
    act(() => {
      recordCheckedFeatureFlags([CHECKED_FLAG, OTHER_CHECKED_FLAG]);
    });
    const { user, panel } = await openPanel();

    await user.click(radio(panel, CHECKED_FLAG, ON));
    expect(readStoredOverrides()).toEqual({ [OTHER_CHECKED_FLAG]: true });

    await user.click(radio(panel, OTHER_CHECKED_FLAG, ON));
    expect(readStoredOverrides()).toEqual({ [OTHER_CHECKED_FLAG]: true });
  });

  it("stores a choice while the production value is not known yet", async () => {
    renderFlagsOverlay();
    act(() => {
      recordCheckedFeatureFlags([UNKNOWN_FLAG]);
    });
    const { user, panel } = await openPanel();
    const group = radioGroup(panel, UNKNOWN_FLAG);
    expect(group).toHaveAccessibleDescription(DEV_TOOLS_UNKNOWN_LABEL);
    expect(within(group).queryByRole("radio", { checked: true })).toBeNull();

    await user.click(radio(panel, UNKNOWN_FLAG, ON));
    await user.click(radio(panel, UNKNOWN_FLAG, OFF));

    expect(readStoredOverrides()).toEqual({ [UNKNOWN_FLAG]: false });
  });

  it("returns every flag to production on Reset to prod", async () => {
    localStorage.setItem(
      FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
      JSON.stringify({ [CHECKED_FLAG]: false, [UNSET_FLAG]: true })
    );
    renderFlagsOverlay();
    act(() => {
      recordCheckedFeatureFlags([CHECKED_FLAG, UNSET_FLAG]);
    });
    const { user, panel } = await openPanel();
    expect(checkedSetting(panel, CHECKED_FLAG)).toBe(OFF);
    expect(checkedSetting(panel, UNSET_FLAG)).toBe(ON);

    await user.click(
      within(panel).getByRole("button", { name: DEV_TOOLS_RESET_TO_PROD_LABEL })
    );

    expect(readStoredOverrides()).toEqual({});
    expect(checkedSetting(panel, CHECKED_FLAG)).toBe(ON);
    expect(checkedSetting(panel, UNSET_FLAG)).toBe(OFF);
  });

  it("loads a value stored by an older build, such as a stored default, as no override", async () => {
    localStorage.setItem(
      FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
      JSON.stringify({ [CHECKED_FLAG]: "default", [OTHER_CHECKED_FLAG]: true })
    );
    renderFlagsOverlay();
    act(() => {
      recordCheckedFeatureFlags([CHECKED_FLAG, OTHER_CHECKED_FLAG]);
    });
    const { panel } = await openPanel();

    expect(checkedSetting(panel, CHECKED_FLAG)).toBe(ON);
    expect(checkedSetting(panel, OTHER_CHECKED_FLAG)).toBe(OFF);
  });

  it("clears the page's checked flags on navigation", () => {
    const navigation = renderFlagsOverlay();
    act(() => {
      recordCheckedFeatureFlags([CHECKED_FLAG]);
    });

    act(() => {
      navigation.navigate("/branches");
    });

    expect(readCheckedFeatureFlags().size).toBe(0);
  });
});

function radioGroup(panel: HTMLElement, flag: string): HTMLElement {
  return within(panel).getByRole("radiogroup", { name: flag });
}

function radio(panel: HTMLElement, flag: string, label: string): HTMLElement {
  return within(radioGroup(panel, flag)).getByText(label, {
    selector: '[role="radio"]',
  });
}

function checkedSetting(panel: HTMLElement, flag: string): string | null {
  return within(radioGroup(panel, flag)).getByRole("radio", { checked: true })
    .textContent;
}

function readStoredOverrides(): unknown {
  const raw = localStorage.getItem(FEATURE_FLAG_OVERRIDES_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

const PRODUCTION_VALUES: ReadonlyMap<string, boolean> = new Map([
  [CHECKED_FLAG, true],
  [OTHER_CHECKED_FLAG, false],
  [UNSET_FLAG, false],
]);
