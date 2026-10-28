import { FEATURE_FLAG_OVERRIDES_STORAGE_KEY } from "@repo/api/src/types/feature-flag-overrides";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import { DEV_MODE_STORAGE_KEY } from "../../feature-flags/dev-mode/dev-mode-contract";
import {
  DevModeEligibility,
  DevModeProvider,
} from "../../feature-flags/dev-mode/dev-mode-provider";
import type { FeatureFlagAdapter } from "../../feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "../../feature-flags/provider";
import {
  recordCheckedFeatureFlags,
  resetCheckedFeatureFlags,
} from "../lib/checked-feature-flags-store";
import {
  DEV_TOOLS_ALL_FLAGS_LABEL,
  DEV_TOOLS_LABEL,
  DEV_TOOLS_ON_THIS_PAGE_LABEL,
  DEV_TOOLS_OVERRIDDEN_SETTING_LABELS,
  DEV_TOOLS_SETTING_LABELS,
  DEV_TOOLS_UNKNOWN_LABEL,
} from "../lib/dev-tools-copy";
import {
  createDevToolsRegistry,
  type DevToolsSection,
} from "../lib/dev-tools-registry";
import { DevToolsSetting } from "../lib/dev-tools-settings";
import { FEATURE_FLAGS_DEV_TOOLS_SECTION } from "../lib/feature-flags-dev-tools-section";
import { DevToolsOverlay } from "./dev-tools-overlay";

/**
 * ISS-12048: the Dev Tools overlay as an internal viewer with Dev Mode on sees
 * it. The second section is a story fixture standing in for a future
 * registered capability, to show how several sections stack.
 */
const FIXTURE_SECTION: DevToolsSection = {
  id: "story-fixture-section",
  title: "Fixture section",
  storageKey: "storybook:dev-tools-fixture-section",
  controls: [
    { id: "fixture-toggle-a", label: "fixture-toggle-a" },
    { id: "fixture-toggle-b", label: "fixture-toggle-b" },
  ],
};

const FLAG_KEYS = FEATURE_FLAGS_DEV_TOOLS_SECTION.controls.map(
  (control) => control.id
);

const STORY_CHECKED_FLAGS = FLAG_KEYS.slice(0, 3);

/**
 * A production value for every flag, alternating by key so the panel shows
 * flags at both On and Off before any override, as the shells' adapters report
 * them.
 */
const PRODUCTION_ON_FLAGS = new Set(
  FLAG_KEYS.filter((_, index) => index % 2 === 0)
);

const STORY_FEATURE_FLAG_ADAPTER: FeatureFlagAdapter = {
  useFeatureFlagEnabled: () => false,
  useFeatureFlagProductionValue: (key) => PRODUCTION_ON_FLAGS.has(key),
};

/**
 * The second flag (Off in production) overridden On and the third (On in
 * production) overridden Off; every other flag shows its production value.
 */
const STORY_OVERRIDES = {
  [FLAG_KEYS[1] ?? ""]: true,
  [FLAG_KEYS[2] ?? ""]: false,
};

const SEVERAL_SECTIONS = createDevToolsRegistry([
  FEATURE_FLAGS_DEV_TOOLS_SECTION,
  FIXTURE_SECTION,
]);

// No controls: `registry` is the only prop, a Map of section modules rather
// than a value a control can edit; each story's registry is the point.
const meta = {
  title: "Composites v1.0/App Shell/Dev Tools Overlay",
  component: DevToolsOverlay,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  // Every story starts in Dev Mode with nothing overridden, whatever an
  // earlier story or a reviewer's clicks left in this browser.
  beforeEach: () => {
    for (const key of [
      DEV_MODE_STORAGE_KEY,
      FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
      FIXTURE_SECTION.storageKey,
    ]) {
      localStorage.removeItem(key);
    }
    // Two flags this page "checked", so the section's default view (the page's
    // own flags, ISS-12048) has something to show.
    resetCheckedFeatureFlags();
    recordCheckedFeatureFlags(STORY_CHECKED_FLAGS);
  },
  decorators: [
    (Story) => (
      <FeatureFlagAdapterProvider adapter={STORY_FEATURE_FLAG_ADAPTER}>
        <DevModeProvider eligibility={DevModeEligibility.Eligible} isRolledOut>
          <div className="min-h-screen bg-background">
            <Story />
          </div>
        </DevModeProvider>
      </FeatureFlagAdapterProvider>
    ),
  ],
} satisfies Meta<typeof DevToolsOverlay>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The collapsed corner button. */
export const Closed: Story = {
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole("button", {
      name: DEV_TOOLS_LABEL,
    });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  },
};

/**
 * Expanded, with the feature flags section the shells register, listing the
 * flags this page checked, none overridden.
 */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const panel = await openPanel(canvasElement);
    await expect(
      within(panel).getByText(FEATURE_FLAGS_DEV_TOOLS_SECTION.title)
    ).toBeVisible();
    for (const flag of STORY_CHECKED_FLAGS) {
      await expect(within(panel).getByText(flag)).toBeVisible();
    }
  },
};

/**
 * The page's flags with one overridden On and one overridden Off, beside one at
 * its production value.
 */
export const SomeOverrides: Story = {
  beforeEach: () => {
    localStorage.setItem(
      FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
      JSON.stringify(STORY_OVERRIDES)
    );
  },
  play: async ({ canvasElement }) => {
    const panel = await openPanel(canvasElement);
    const expected = [
      [FLAG_KEYS[0], DevToolsSetting.On],
      [FLAG_KEYS[1], DevToolsSetting.On],
      [FLAG_KEYS[2], DevToolsSetting.Off],
    ] as const;
    for (const [index, [flag, setting]] of expected.entries()) {
      const group = within(panel).getByRole("radiogroup", { name: flag });
      await expect(
        within(group).getByRole("radio", { checked: true })
      ).toHaveAccessibleName(
        index === 0
          ? DEV_TOOLS_SETTING_LABELS[setting]
          : DEV_TOOLS_OVERRIDDEN_SETTING_LABELS[setting]
      );
    }
  },
};

/**
 * Every flag, under All flags: the page's flags first under On this page, then
 * the rest of the long list, with the section header pinned while it scrolls.
 */
export const AllFlags: Story = {
  beforeEach: () => {
    localStorage.setItem(
      FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
      JSON.stringify(STORY_OVERRIDES)
    );
  },
  play: async ({ canvasElement }) => {
    const panel = await openPanel(canvasElement);
    await userEvent.click(
      within(panel).getByLabelText(DEV_TOOLS_ALL_FLAGS_LABEL)
    );
    await expect(
      within(panel).getByText(DEV_TOOLS_ON_THIS_PAGE_LABEL)
    ).toBeVisible();
    await expect(
      within(panel).getByText(FLAG_KEYS.at(-1) ?? "")
    ).toBeInTheDocument();
  },
};

/** Expanded with two sections, each with its own reset. */
export const SeveralSections: Story = {
  args: { registry: SEVERAL_SECTIONS },
  play: async ({ canvasElement }) => {
    const panel = await openPanel(canvasElement);
    for (const section of SEVERAL_SECTIONS.values()) {
      await expect(within(panel).getByText(section.title)).toBeVisible();
    }
  },
};

/** Unresolved production values display Unknown while both choices stay enabled. */
export const LoadingProduction: Story = {
  decorators: [
    (Story) => (
      <FeatureFlagAdapterProvider
        adapter={{
          useFeatureFlagEnabled: () => false,
          useFeatureFlagProductionValue: () => undefined,
        }}
      >
        <Story />
      </FeatureFlagAdapterProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    const panel = await openPanel(canvasElement);
    const group = within(panel).getByRole("radiogroup", {
      name: STORY_CHECKED_FLAGS[0],
    });
    await expect(group).toHaveAccessibleDescription(DEV_TOOLS_UNKNOWN_LABEL);
    await expect(
      within(group).queryByRole("radio", { checked: true })
    ).toBeNull();
    await expect(within(group).getAllByRole("radio")).toHaveLength(2);
    await userEvent.click(
      within(group).getByRole("radio", {
        name: DEV_TOOLS_SETTING_LABELS[DevToolsSetting.Off],
      })
    );
    await expect(
      within(group).getByRole("radio", { checked: true })
    ).toHaveAccessibleName(
      DEV_TOOLS_OVERRIDDEN_SETTING_LABELS[DevToolsSetting.Off]
    );
  },
};

/**
 * Opens the panel and finds it through the trigger's `aria-controls`, which
 * also pins that relationship. Role queries over a panel holding every flag
 * key are slow in jsdom, so these plays stay on text and ids.
 */
async function openPanel(canvasElement: HTMLElement): Promise<HTMLElement> {
  const trigger = within(canvasElement).getByRole("button", {
    name: DEV_TOOLS_LABEL,
  });
  await userEvent.click(trigger);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const panelId = trigger.getAttribute("aria-controls");
  const panel = panelId ? document.getElementById(panelId) : null;
  if (!panel) {
    throw new Error("Dev Tools panel did not open");
  }
  await expect(panel).toHaveAccessibleName(DEV_TOOLS_LABEL);
  return panel;
}
