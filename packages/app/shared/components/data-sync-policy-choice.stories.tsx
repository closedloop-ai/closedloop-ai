import {
  DATA_SYNC_LEVELS,
  DataSyncLevel,
} from "@repo/api/src/types/data-sync-level";
import type { Meta, StoryObj } from "@storybook/react";
import { type ComponentProps, useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { offeredDataSyncLevelsWithoutRedaction } from "../lib/data-sync-level-options";
import { DataSyncPolicyChoice } from "./data-sync-policy-choice";

const UNSET_MESSAGE = /This device has not saved a sync choice yet/;

const meta = {
  component: DataSyncPolicyChoice,
  tags: ["stable", "autodocs"],
  title: "Composites/Shared/Data Sync/Data Sync Policy Choice",
  args: {
    currentLevel: null,
    selectedLevel: null,
    isWriting: false,
    levels: offeredDataSyncLevelsWithoutRedaction(null),
    onSave: () => undefined,
    onSelect: () => undefined,
  },
  argTypes: {
    currentLevel: { control: "select", options: [null, ...DATA_SYNC_LEVELS] },
    selectedLevel: { control: "select", options: [null, ...DATA_SYNC_LEVELS] },
    isWriting: { control: "boolean" },
    levels: { control: "check", options: DATA_SYNC_LEVELS },
    onSave: { control: false },
    onSelect: { control: false },
  },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-xl p-4">
        <Story />
      </div>
    ),
  ],
  render: (args) => (
    <InteractiveChoice
      key={`${args.currentLevel}-${args.selectedLevel}`}
      {...args}
    />
  ),
} satisfies Meta<typeof DataSyncPolicyChoice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Unset: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const save = canvas.getByRole("button", { name: "Save sync choice" });
    await expect(save).toBeDisabled();
    for (const radio of canvas.getAllByRole("radio")) {
      await expect(radio).not.toBeChecked();
    }
    await userEvent.click(canvas.getByRole("radio", { name: "Off" }));
    await expect(canvas.getByText(UNSET_MESSAGE)).toBeVisible();
    await userEvent.click(save);
    await expect(canvas.queryByText(UNSET_MESSAGE)).not.toBeInTheDocument();
    await expect(
      canvas.getByText("Current level").parentElement
    ).toHaveTextContent("Off");
    await expect(save).toBeDisabled();
  },
};
export const ExplicitOff: Story = {
  args: { currentLevel: DataSyncLevel.Off, selectedLevel: DataSyncLevel.Off },
};
export const UnsavedOff: Story = { args: { selectedLevel: DataSyncLevel.Off } };
export const Saving: Story = {
  args: { selectedLevel: DataSyncLevel.Off, isWriting: true },
};

function InteractiveChoice(args: ComponentProps<typeof DataSyncPolicyChoice>) {
  const [currentLevel, setCurrentLevel] = useState(args.currentLevel);
  const [selectedLevel, setSelectedLevel] = useState(args.selectedLevel);
  return (
    <DataSyncPolicyChoice
      {...args}
      currentLevel={currentLevel}
      onSave={setCurrentLevel}
      onSelect={setSelectedLevel}
      selectedLevel={selectedLevel}
    />
  );
}
