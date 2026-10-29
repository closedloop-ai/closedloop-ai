import { FEATURE_FLAG_OVERRIDES_STORAGE_KEY } from "@repo/api/src/types/feature-flag-overrides";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../feature-flags/provider";
import {
  ARTIFACT_TAGS_FEATURE_FLAG_KEY,
  SESSION_TRACE_TAB_FEATURE_FLAG_KEY,
} from "../../../lib/feature-flags";
import {
  DEV_TOOLS_OVERRIDDEN_SETTING_LABELS,
  DEV_TOOLS_SETTING_LABELS,
  DEV_TOOLS_UNKNOWN_LABEL,
} from "../../lib/dev-tools-copy";
import { DevToolsSetting } from "../../lib/dev-tools-settings";
import { FEATURE_FLAGS_DEV_TOOLS_SECTION } from "../../lib/feature-flags-dev-tools-section";
import { DevToolsSectionPanel } from "../dev-tools-section-panel";

const FIRST_FLAG = SESSION_TRACE_TAB_FEATURE_FLAG_KEY;
const SECOND_FLAG = ARTIFACT_TAGS_FEATURE_FLAG_KEY;
const section = {
  ...FEATURE_FLAGS_DEV_TOOLS_SECTION,
  highlight: undefined,
  controls: [FIRST_FLAG, SECOND_FLAG].map((id) => ({ id, label: id })),
};

afterEach(() => {
  cleanup();
  localStorage.removeItem(FEATURE_FLAG_OVERRIDES_STORAGE_KEY);
});

function panel(values: Readonly<Record<string, boolean | undefined>>) {
  return (
    <FeatureFlagAdapterProvider
      adapter={{
        useFeatureFlagEnabled: () => false,
        useFeatureFlagProductionValue: (key) => values[key],
      }}
    >
      <DevToolsSectionPanel section={section} />
    </FeatureFlagAdapterProvider>
  );
}

function group(flag: string) {
  return screen.getByRole("radiogroup", { name: flag });
}

function selectedRadio(flag: string) {
  return within(group(flag)).getByRole("radio", { checked: true });
}

describe("production flag loading in the shared control", () => {
  it("shows Unknown without a third choice, transitions to loaded absent Off, and clears stale selection on reload", () => {
    const { rerender } = render(panel({}));
    for (const flag of [FIRST_FLAG, SECOND_FLAG]) {
      expect(group(flag)).toHaveAccessibleDescription(DEV_TOOLS_UNKNOWN_LABEL);
      const radios = within(group(flag)).getAllByRole("radio");
      expect(radios.map((radio) => radio.textContent)).toEqual([
        DEV_TOOLS_SETTING_LABELS[DevToolsSetting.On],
        DEV_TOOLS_SETTING_LABELS[DevToolsSetting.Off],
      ]);
      for (const radio of radios) {
        expect(radio).not.toBeChecked();
        expect(radio).toBeEnabled();
      }
    }

    rerender(panel({ [FIRST_FLAG]: true, [SECOND_FLAG]: false }));
    expect(selectedRadio(FIRST_FLAG)).toHaveAccessibleName(
      DEV_TOOLS_SETTING_LABELS[DevToolsSetting.On]
    );
    expect(selectedRadio(SECOND_FLAG)).toHaveAccessibleName(
      DEV_TOOLS_SETTING_LABELS[DevToolsSetting.Off]
    );
    expect(screen.queryByText(DEV_TOOLS_UNKNOWN_LABEL)).toBeNull();

    rerender(panel({}));
    for (const flag of [FIRST_FLAG, SECOND_FLAG]) {
      expect(
        within(group(flag)).queryByRole("radio", { checked: true })
      ).toBeNull();
      expect(group(flag)).toHaveAccessibleDescription(DEV_TOOLS_UNKNOWN_LABEL);
    }
    expect(localStorage.getItem(FEATURE_FLAG_OVERRIDES_STORAGE_KEY)).toBeNull();
  });

  it("keeps explicit On and Off overrides during loading and announces their local origin", async () => {
    const user = userEvent.setup();
    const { rerender } = render(panel({}));
    await user.click(
      within(group(FIRST_FLAG)).getByRole("radio", {
        name: DEV_TOOLS_SETTING_LABELS[DevToolsSetting.On],
      })
    );
    await user.click(
      within(group(SECOND_FLAG)).getByRole("radio", {
        name: DEV_TOOLS_SETTING_LABELS[DevToolsSetting.Off],
      })
    );
    expect(
      JSON.parse(
        localStorage.getItem(FEATURE_FLAG_OVERRIDES_STORAGE_KEY) ?? "null"
      )
    ).toEqual({
      [FIRST_FLAG]: true,
      [SECOND_FLAG]: false,
    });
    expect(screen.queryByText(DEV_TOOLS_UNKNOWN_LABEL)).toBeNull();
    expect(selectedRadio(FIRST_FLAG)).toHaveAccessibleName(
      DEV_TOOLS_OVERRIDDEN_SETTING_LABELS[DevToolsSetting.On]
    );
    expect(selectedRadio(SECOND_FLAG)).toHaveAccessibleName(
      DEV_TOOLS_OVERRIDDEN_SETTING_LABELS[DevToolsSetting.Off]
    );

    rerender(panel({ [FIRST_FLAG]: true, [SECOND_FLAG]: false }));
    expect(selectedRadio(FIRST_FLAG)).toHaveAccessibleName(
      DEV_TOOLS_OVERRIDDEN_SETTING_LABELS[DevToolsSetting.On]
    );
    expect(selectedRadio(SECOND_FLAG)).toHaveAccessibleName(
      DEV_TOOLS_OVERRIDDEN_SETTING_LABELS[DevToolsSetting.Off]
    );
    await user.click(
      within(group(FIRST_FLAG)).getByRole("radio", { checked: true })
    );
    expect(selectedRadio(FIRST_FLAG)).toHaveAccessibleName(
      DEV_TOOLS_SETTING_LABELS[DevToolsSetting.On]
    );
    expect(selectedRadio(SECOND_FLAG)).toHaveAccessibleName(
      DEV_TOOLS_OVERRIDDEN_SETTING_LABELS[DevToolsSetting.Off]
    );
    expect(
      JSON.parse(
        localStorage.getItem(FEATURE_FLAG_OVERRIDES_STORAGE_KEY) ?? "null"
      )
    ).toEqual({ [SECOND_FLAG]: false });
  });
});
