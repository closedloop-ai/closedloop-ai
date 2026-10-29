import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_MODE_STORAGE_KEY } from "../../../feature-flags/dev-mode/dev-mode-contract";
import {
  type DevModeEligibility,
  DevModeProvider,
  DevModeEligibility as Eligibility,
} from "../../../feature-flags/dev-mode/dev-mode-provider";
import {
  DEV_TOOLS_ALL_FLAGS_LABEL,
  DEV_TOOLS_LABEL,
  DEV_TOOLS_OVERRIDDEN_SETTING_LABELS,
  DEV_TOOLS_RESET_TO_PROD_LABEL,
  DEV_TOOLS_SETTING_LABELS,
} from "../../lib/dev-tools-copy";
import {
  createDevToolsRegistry,
  type DevToolsSection,
} from "../../lib/dev-tools-registry";
import {
  DEV_TOOLS_SETTING_ORDER,
  DevToolsSetting,
} from "../../lib/dev-tools-settings";
import { FEATURE_FLAGS_DEV_TOOLS_SECTION } from "../../lib/feature-flags-dev-tools-section";
import { DevToolsOverlay } from "../dev-tools-overlay";

const FLAGS_SECTION: DevToolsSection = {
  id: "test-flags",
  title: "Test flags",
  storageKey: "test:dev-tools-flags",
  controls: [
    { id: "alpha-flag", label: "alpha-flag" },
    { id: "beta-flag", label: "beta-flag" },
  ],
};
const OTHER_SECTION: DevToolsSection = {
  id: "test-other",
  title: "Test other",
  storageKey: "test:dev-tools-other",
  controls: [{ id: "gamma-toggle", label: "gamma-toggle" }],
};
const REGISTRY = createDevToolsRegistry([FLAGS_SECTION, OTHER_SECTION]);

afterEach(() => {
  cleanup();
  for (const key of [
    DEV_MODE_STORAGE_KEY,
    FLAGS_SECTION.storageKey,
    OTHER_SECTION.storageKey,
  ]) {
    localStorage.removeItem(key);
  }
});

function WithNavigation({ children }: { children: ReactNode }) {
  const [navigation] = useState(() => createMemoryNavigation());
  return (
    <NavigationProvider adapter={navigation.adapter}>
      {children}
    </NavigationProvider>
  );
}

function renderOverlay({
  eligibility = Eligibility.Eligible,
  isRolledOut = true,
  withProvider = true,
}: {
  eligibility?: DevModeEligibility;
  isRolledOut?: boolean;
  withProvider?: boolean;
} = {}) {
  const overlay = <DevToolsOverlay registry={REGISTRY} />;
  return render(
    withProvider ? (
      <DevModeProvider eligibility={eligibility} isRolledOut={isRolledOut}>
        {overlay}
      </DevModeProvider>
    ) : (
      overlay
    ),
    { wrapper: WithNavigation }
  );
}

function queryTrigger() {
  return screen.queryByRole("button", { name: DEV_TOOLS_LABEL });
}

async function openPanel() {
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: DEV_TOOLS_LABEL });
  await user.click(trigger);
  return { user, trigger, panel: screen.getByRole("dialog") };
}

function radioFor(panel: HTMLElement, controlLabel: string, setting: string) {
  const group = within(panel).getByRole("radiogroup", { name: controlLabel });
  return within(group).getByRole("radio", { name: setting });
}

function readStored(storageKey: string): unknown {
  const raw = localStorage.getItem(storageKey);
  return raw === null ? null : JSON.parse(raw);
}

describe("DevToolsOverlay visibility", () => {
  it("renders nothing with no Dev Mode provider", () => {
    renderOverlay({ withProvider: false });
    expect(queryTrigger()).not.toBeInTheDocument();
  });

  it("renders nothing for an eligible viewer who turned Dev Mode off", () => {
    localStorage.setItem(DEV_MODE_STORAGE_KEY, "false");
    renderOverlay();
    expect(queryTrigger()).not.toBeInTheDocument();
  });

  it("renders nothing for an ineligible viewer, or while the rollout is off", () => {
    const { unmount } = renderOverlay({
      eligibility: Eligibility.Ineligible,
    });
    expect(queryTrigger()).not.toBeInTheDocument();
    unmount();

    renderOverlay({ isRolledOut: false });
    expect(queryTrigger()).not.toBeInTheDocument();
  });

  it("shows a collapsed, named corner button while Dev Mode is on", () => {
    renderOverlay();

    const trigger = queryTrigger();
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("DevToolsOverlay panel", () => {
  it("expands into a named panel listing every registered section", async () => {
    renderOverlay();
    const { trigger, panel } = await openPanel();

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(panel).toHaveAccessibleName(DEV_TOOLS_LABEL);
    for (const section of REGISTRY.values()) {
      expect(
        within(panel).getByRole("heading", { name: section.title })
      ).toBeInTheDocument();
      for (const control of section.controls) {
        expect(
          radioFor(
            panel,
            control.label,
            DEV_TOOLS_SETTING_LABELS[DevToolsSetting.Off]
          )
        ).toBeChecked();
      }
    }
  });

  it("writes an override for that control only, and clears it on choosing Off again", async () => {
    renderOverlay();
    const { user, panel } = await openPanel();

    await user.click(
      radioFor(
        panel,
        "alpha-flag",
        DEV_TOOLS_SETTING_LABELS[DevToolsSetting.On]
      )
    );

    expect(readStored(FLAGS_SECTION.storageKey)).toEqual({
      "alpha-flag": true,
    });
    expect(
      radioFor(
        panel,
        "alpha-flag",
        DEV_TOOLS_OVERRIDDEN_SETTING_LABELS[DevToolsSetting.On]
      )
    ).toBeChecked();
    expect(
      radioFor(
        panel,
        "beta-flag",
        DEV_TOOLS_SETTING_LABELS[DevToolsSetting.Off]
      )
    ).toBeChecked();

    await user.click(
      radioFor(
        panel,
        "alpha-flag",
        DEV_TOOLS_SETTING_LABELS[DevToolsSetting.Off]
      )
    );
    expect(readStored(FLAGS_SECTION.storageKey)).toEqual({});
  });

  it("resets every control in one section and leaves the others", async () => {
    localStorage.setItem(
      FLAGS_SECTION.storageKey,
      JSON.stringify({ "alpha-flag": true, "beta-flag": false })
    );
    localStorage.setItem(
      OTHER_SECTION.storageKey,
      JSON.stringify({ "gamma-toggle": true })
    );
    renderOverlay();
    const { user, panel } = await openPanel();

    const flagsSection = within(panel)
      .getByRole("heading", { name: FLAGS_SECTION.title })
      .closest("section");
    if (!flagsSection) {
      throw new Error("flags section not rendered");
    }
    await user.click(
      within(flagsSection).getByRole("button", {
        name: DEV_TOOLS_RESET_TO_PROD_LABEL,
      })
    );

    expect(readStored(FLAGS_SECTION.storageKey)).toEqual({});
    expect(readStored(OTHER_SECTION.storageKey)).toEqual({
      "gamma-toggle": true,
    });
    expect(
      radioFor(
        panel,
        "alpha-flag",
        DEV_TOOLS_SETTING_LABELS[DevToolsSetting.Off]
      )
    ).toBeChecked();
  });

  it("opens from the keyboard and returns focus to the button on Escape", async () => {
    renderOverlay();
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: DEV_TOOLS_LABEL });

    trigger.focus();
    await user.keyboard("{Enter}");
    const panel = screen.getByRole("dialog");
    expect(panel).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe("DevToolsOverlay default registry", () => {
  // Every flag key renders here, so this case stays off whole-document role
  // queries, which are slow in jsdom at this size.
  // ISS-12048 (Daveth, 2026-10-06): the section opens on the flags this page
  // checked; every flag is one "All flags" toggle away.
  it("renders the feature flags section with an On/Off control per key under All flags", async () => {
    render(
      <DevModeProvider eligibility={Eligibility.Eligible} isRolledOut>
        <DevToolsOverlay />
      </DevModeProvider>,
      { wrapper: WithNavigation }
    );
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: DEV_TOOLS_LABEL });
    await user.click(trigger);
    const panel = document.getElementById(
      trigger.getAttribute("aria-controls") ?? ""
    );
    if (!panel) {
      throw new Error("Dev Tools panel did not open");
    }
    expect(panel.querySelectorAll('[role="radiogroup"]')).toHaveLength(0);
    await user.click(within(panel).getByLabelText(DEV_TOOLS_ALL_FLAGS_LABEL));

    expect(
      within(panel).getByText(FEATURE_FLAGS_DEV_TOOLS_SECTION.title)
    ).toBeInTheDocument();
    const groups = panel.querySelectorAll<HTMLElement>('[role="radiogroup"]');
    const { controls } = FEATURE_FLAGS_DEV_TOOLS_SECTION;
    expect(groups).toHaveLength(controls.length);
    const firstGroup = groups.item(0);
    expect(firstGroup).toHaveAccessibleName(controls.at(0)?.label ?? "");
    expect(groups.item(groups.length - 1)).toHaveAccessibleName(
      controls.at(-1)?.label ?? ""
    );
    expect(within(firstGroup).getAllByRole("radio")).toHaveLength(
      DEV_TOOLS_SETTING_ORDER.length
    );
  });
});
