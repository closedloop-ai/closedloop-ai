import {
  type DataSyncLevel,
  DataSyncLevel as Level,
} from "@repo/api/src/types/data-sync-level";
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import type { Meta, StoryObj } from "@storybook/react";
import { DATA_SYNC_LEVEL_COPY } from "../lib/data-sync-copy";
import { DataSyncLevelCard } from "./data-sync-level-card";
import { DataSyncLevelVisual } from "./data-sync-level-visual";

/**
 * ISS-12522: one data-sync level card with its visual of what stays on this
 * device and what is uploaded, for each level the consent surfaces offer,
 * selected and unselected, light and dark.
 *
 * The visual is opt-in. Every shipped host renders the card through
 * `DataSyncLevelPicker`, which passes no visual, so production is unchanged
 * until a host adopts it. Each story mounts the card in the same Radix radio
 * the picker uses, so the control is the one that ships.
 */
function CardWithVisual({
  level,
  selected,
}: {
  level: DataSyncLevel;
  selected: boolean;
}) {
  const id = `data-sync-level-card-${level}`;
  return (
    <RadioGroup
      aria-label={DATA_SYNC_LEVEL_COPY[level].title}
      value={selected ? level : ""}
    >
      <DataSyncLevelCard
        control={
          <RadioGroupItem
            aria-label={DATA_SYNC_LEVEL_COPY[level].title}
            className="mt-0.5"
            id={id}
            value={level}
          />
        }
        htmlFor={id}
        level={level}
        selected={selected}
        visual={<DataSyncLevelVisual level={level} />}
      />
    </RadioGroup>
  );
}

const meta = {
  title: "Composites/Shared/Data Sync/Data Sync Level Card",
  tags: ["experimental"],
  component: CardWithVisual,
  parameters: { layout: "padded" },
  argTypes: {
    level: {
      control: "select",
      options: [Level.Off, Level.Metadata, Level.Full],
    },
    selected: { control: "boolean" },
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CardWithVisual>;

export default meta;

type Story = StoryObj<typeof meta>;

const DARK = { globals: { theme: "dark" } } as const;

/** Metadata only, selected: aggregates and tool names go up, content stays. */
export const Default: Story = {
  args: { level: Level.Metadata, selected: true },
};

/** Off: every category is collected locally and nothing is uploaded. */
export const Off: Story = { args: { level: Level.Off, selected: false } };

export const OffSelected: Story = {
  args: { level: Level.Off, selected: true },
};

export const MetadataOnly: Story = {
  args: { level: Level.Metadata, selected: false },
};

/** Full transcripts: every category is uploaded. */
export const FullTranscripts: Story = {
  args: { level: Level.Full, selected: false },
};

export const FullTranscriptsSelected: Story = {
  args: { level: Level.Full, selected: true },
};

export const OffDark: Story = { ...Off, ...DARK };

export const OffSelectedDark: Story = { ...OffSelected, ...DARK };

export const MetadataOnlyDark: Story = { ...MetadataOnly, ...DARK };

export const MetadataOnlySelectedDark: Story = { ...Default, ...DARK };

export const FullTranscriptsDark: Story = { ...FullTranscripts, ...DARK };

export const FullTranscriptsSelectedDark: Story = {
  ...FullTranscriptsSelected,
  ...DARK,
};
