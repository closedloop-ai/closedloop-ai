import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";
import { DataSyncLevelValue } from "../../shared/lib/data-sync-copy";
import {
  DEFAULT_SYNC_LEVEL,
  DEFAULT_TAKEOVER_SYNC_LEVEL,
  type SyncConsentLevel,
  SyncLevelOptions,
} from "./sync-consent";

/**
 * The three levels onboarding surfaces, in the presentation order
 * `SYNC_CONSENT_LEVELS` uses. Built from the canonical
 * {@link DataSyncLevelValue} members rather than `Object.values`, because
 * `SyncConsentLevel` deliberately excludes the forward-compat `redacted` level.
 */
const SYNC_LEVEL_OPTIONS: readonly SyncConsentLevel[] = [
  DataSyncLevelValue.Off,
  DataSyncLevelValue.Metadata,
  DataSyncLevelValue.Full,
];

/**
 * The three-level consent radio group, on its own.
 *
 * Extracted from `SyncConsent` (ISS-5489) so the post-auth takeover could put
 * the SAME per-level breakdown inside its own modal chrome. Promotion to an
 * exported module is what earns it a story: its states stop being covered by the
 * parent's single fixture the moment a second host renders it with different
 * arguments — which is exactly what the takeover does.
 *
 * The axis worth seeing side by side is the PRE-SELECTION: onboarding starts on
 * the safe floor, the takeover starts on the widest level. The chip is no longer
 * part of that axis — ISS-5318 moved it into the shared card, so "Recommended"
 * sits on the most-permissive level in both stories no matter which one is
 * selected. Two hosts once passed two different words pointing at two different
 * levels; the prop that allowed it is gone.
 */
const meta: Meta<typeof SyncLevelOptions> = {
  args: {
    onSelect: fn(),
    selected: DEFAULT_SYNC_LEVEL,
  },
  argTypes: {
    onSelect: { control: false, table: { category: "Events" } },
    selected: { control: { type: "radio" }, options: SYNC_LEVEL_OPTIONS },
  },
  component: SyncLevelOptions,
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-md py-8">
        <Story />
      </div>
    ),
  ],
  tags: ["autodocs"],
  title: "Composites/Onboarding/Sync Level Options",
};

export default meta;

type Story = StoryObj<typeof SyncLevelOptions>;

/**
 * Interactive, because the thing most worth checking here is that picking a
 * level actually moves the selection — the radios are controlled, and a host
 * that forgets to thread `onSelect` renders a group that looks fine and cannot
 * be used.
 */
function InteractiveOptions({ initial }: { initial: SyncConsentLevel }) {
  const [selected, setSelected] = useState<SyncConsentLevel>(initial);
  return <SyncLevelOptions onSelect={setSelected} selected={selected} />;
}

/** Onboarding: pre-selected on the safe floor, endorsement on the widest level. */
export const OnboardingSelection: Story = {
  render: () => <InteractiveOptions initial={DEFAULT_SYNC_LEVEL} />,
};

/** The ISS-5489 post-auth takeover: pre-selected on the widest level instead. */
export const TakeoverSelection: Story = {
  render: () => <InteractiveOptions initial={DEFAULT_TAKEOVER_SYNC_LEVEL} />,
};

/**
 * Off selected. Its per-line breakdown is entirely "stays on this device", which
 * is the one state where every row flips — worth seeing that the rows really do
 * change rather than the card just dimming.
 */
export const OffSelected: Story = {
  render: () => <InteractiveOptions initial={DataSyncLevelValue.Off} />,
};
