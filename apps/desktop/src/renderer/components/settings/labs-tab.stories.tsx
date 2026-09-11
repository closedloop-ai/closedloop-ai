import { useEffect, useRef, useState } from "react";
import {
  DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY,
  DESKTOP_AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY,
  DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY,
} from "../../../shared/feature-flags";
import { LabsTab } from "./labs-tab";

// ISS-5310 (wongk story review on PR #4484): `LabsTab` became its own exported
// module in this change — matching the one-tab-per-file shape of
// `data-sync-tab` and `desktop-account-tab` — so it is reachable from a canvas
// for the first time. It was previously private inside `SettingsPanel.tsx`.
// Everything the same change added here is visual and prop-driven, which is
// exactly what a render test cannot pin: the per-`category` `Section` grouping
// that replaced forty-one identical bordered rows in one card, the dependent row
// NESTED under its parent with its switch DISABLED and a "Turn on X first."
// note, and the "Requires restart" hint. `settings-panel-labs-gateway-health`
// proves which outcome is chosen; it runs in jsdom with no Tailwind loaded and
// so is structurally blind to how any of this actually lays out.
// The flag LIST is not a prop — `LabsTab` renders the real `FEATURE_FLAGS`
// registry (minus `hiddenFromLabs` entries), so these stories vary the one input
// it does take, `settings`, and the categories on screen are whatever the
// registry currently holds. Flag keys come from the exported registry constants
// so a rename cannot silently leave a story asserting a dead key.
/**
 * The Settings tab listing every experimental feature as a toggle, grouped
 * by category, for turning on an early feature before it ships broadly.
 */
const meta = {
  title: "Composites/Settings/Labs Tab",
  component: LabsTab,
  tags: ["autodocs"],
  argTypes: {
    settings: {
      control: "object",
      description:
        "The desktop settings record, keyed by flag key. The flag LIST is not a prop: the tab renders the real FEATURE_FLAGS registry.",
    },
    onSettingsChange: {
      control: false,
      table: { category: "Events" },
    },
  },
  args: {
    onSettingsChange: () => undefined,
    settings: { [DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY]: true },
  },
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

/**
 * The settled tab with a mixed spread of switch positions across several
 * categories, and no row blocked. This is the grouping claim itself: each
 * `category` gets its own `Section` with a description that does the job the
 * per-row "Labs" badge used to do, rather than one flat stack.
 */
export const Default = {
  render: () => (
    <LabsTabStage
      initialSettings={{
        [DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY]: true,
        [DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY]: true,
      }}
    />
  ),
};

/**
 * The parent (`agentsNav`) is OFF, so its dependents are indented one tier,
 * their switches are disabled, and each carries "Turn on Agents workspace
 * first." in place of its restart note. The point of the change was that the
 * dependency is enforced by the UI rather than asserted in prose the switch
 * ignored — this is the state where that has to be legible.
 */
export const DependentBlocked = {
  render: () => (
    <LabsTabStage
      initialSettings={{
        [DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY]: false,
      }}
    />
  ),
};

/**
 * The same rows once the parent is ON: still nested under it, but live and
 * toggled on. Worth seeing beside the blocked variant — the indent and row
 * geometry must not move between the two, only the enabled state and the note.
 */
export const DependentUnblocked = {
  render: () => (
    <LabsTabStage
      initialSettings={{
        [DESKTOP_AGENTS_DEFAULT_SORT_USAGE_FEATURE_FLAG_KEY]: true,
        [DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY]: true,
      }}
    />
  ),
};

/**
 * The in-flight save. `saving` is internal state set only by `handleToggle`, so
 * it cannot be driven from props: this story installs an `updateSettings` that
 * never settles, so clicking any switch parks that one row in its disabled
 * saving state while every sibling row stays interactive.
 */
export const SavingInFlight = {
  render: () => (
    <LabsTabStage
      initialSettings={{
        [DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY]: true,
      }}
      updateSettings={neverSettlingUpdate}
    />
  ),
};

/** An `updateSettings` that never settles, so the saving state stays on screen. */
function neverSettlingUpdate(): Promise<unknown> {
  return new Promise(() => {
    // Intentionally never resolves — see SavingInFlight.
  });
}

/**
 * A stage that actually owns the settings record, so the switches on the canvas
 * move when you click them instead of snapping back. `LabsTab` reads nothing
 * from `window.desktopApi` to render, but `useFlagToggle` writes through
 * `updateSettings` and re-reads `getSettings` on every toggle, so the fixture
 * has to round-trip the value the same way the real preload bridge does.
 */
function LabsTabStage({
  initialSettings,
  updateSettings,
}: {
  initialSettings: Record<string, unknown>;
  updateSettings?: (patch: Record<string, unknown>) => Promise<unknown>;
}) {
  const [settings, setSettings] =
    useState<Record<string, unknown>>(initialSettings);
  // The fixture's own copy of the record, so `getSettings` reads back what
  // `updateSettings` just wrote rather than a stale render closure.
  const storeRef = useRef<Record<string, unknown>>(initialSettings);

  useEffect(() => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getSettings: () => Promise.resolve(storeRef.current),
        updateSettings:
          updateSettings ??
          ((patch: Record<string, unknown>) => {
            storeRef.current = { ...storeRef.current, ...patch };
            return Promise.resolve(storeRef.current);
          }),
      },
    });
  }, [updateSettings]);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <LabsTab onSettingsChange={setSettings} settings={settings} />
    </div>
  );
}
