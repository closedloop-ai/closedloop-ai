import {
  DataSyncLevel,
  RECOMMENDED_DATA_SYNC_LEVEL,
} from "@repo/api/src/types/data-sync-level";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import {
  SYNC_CONSENT_LEVELS,
  SYNC_LEVEL_GROUP_LABEL,
  type SyncConsentLevel,
} from "../../onboarding/components/sync-consent";
import { DataSyncLevelPicker } from "./data-sync-level-picker";

/**
 * The one data-sync level picker, rendered by the desktop Settings "Data & Sync"
 * tab, the onboarding consent step and the ISS-5489 post-auth takeover.
 *
 * ISS-6147 collapsed two components into this one. The only thing the hosts
 * still differ on is the SUBSET of levels they pass; the order, the chip, the
 * copy and the recommended pre-selection all come from the picker, so no story
 * can show one surface leading with a different level or endorsing a different
 * one. The states below are therefore picker states, not host states — a story
 * per host would be the same screenshot three times.
 */
const meta: Meta<typeof DataSyncLevelPicker> = {
  component: DataSyncLevelPicker,
  tags: ["deprecated", "autodocs"],
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-md py-8">
        <Story />
      </div>
    ),
  ],
  title: "Composites v1.0/App Shell/Data Sync Level Picker",
};

export default meta;

type Story = StoryObj<typeof DataSyncLevelPicker>;

/**
 * Interactive, because the thing most worth checking here is that picking a
 * level actually moves the selection — the radios are controlled, and a host
 * that forgets to thread `onSelect` renders a group that looks fine and cannot
 * be used.
 */
function InteractivePicker({
  initial,
  levels = SYNC_CONSENT_LEVELS,
}: {
  initial: SyncConsentLevel;
  levels?: readonly SyncConsentLevel[];
}) {
  const [selected, setSelected] = useState<SyncConsentLevel>(initial);
  return (
    <DataSyncLevelPicker
      label={SYNC_LEVEL_GROUP_LABEL}
      levels={levels}
      onSelect={setSelected}
      selected={selected}
    />
  );
}

/**
 * The consent subset as onboarding and the ISS-5489 takeover both render it:
 * pre-selected on the recommended level, which is also the badged one.
 */
export const RecommendedSelection: Story = {
  render: () => <InteractivePicker initial={RECOMMENDED_DATA_SYNC_LEVEL} />,
};

/**
 * Off selected. Its per-line breakdown is entirely "stays on this device", which
 * is the one state where every row flips — worth seeing that the rows really do
 * change rather than the card just dimming.
 */
export const OffSelected: Story = {
  render: () => <InteractivePicker initial={DataSyncLevel.Off} />,
};

/**
 * The Settings subset: the same picker with `redacted` included, which is the
 * only shape difference between the surfaces now. It slots in by exposure
 * ranking rather than at an end, because the picker sorts what it is given.
 */
export const SettingsSubsetWithRedacted: Story = {
  render: () => (
    <DataSyncLevelPicker
      label="Data & Sync level"
      levels={[
        DataSyncLevel.Off,
        DataSyncLevel.Metadata,
        DataSyncLevel.Redacted,
        DataSyncLevel.Full,
      ]}
      onSelect={() => {
        // Presentational story: the selection is pinned so the Redacted card
        // stays visible next to its neighbours.
      }}
      selected={DataSyncLevel.Redacted}
    />
  ),
};
