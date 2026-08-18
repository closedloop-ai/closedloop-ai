import { PackInstallState } from "@repo/app/packs/lib/install-state";
import type { Meta, StoryObj } from "@storybook/react";
import { InstallStateStatus } from "./install-state-status";

const meta = {
  title: "App Core/Packs/Install State Status",
  component: InstallStateStatus,
  tags: ["autodocs"],
  args: {
    state: PackInstallState.Installed,
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof InstallStateStatus>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Installed: Story = {};

export const NotInstalled: Story = {
  args: { state: PackInstallState.NotInstalled },
};

export const Updatable: Story = {
  args: { state: PackInstallState.Updatable },
};

export const Converting: Story = {
  args: { state: PackInstallState.Converting },
};

export const Unsupported: Story = {
  args: { state: PackInstallState.Unsupported },
};

export const Offline: Story = {
  args: { state: PackInstallState.Offline },
};

export const Failed: Story = {
  args: { state: PackInstallState.Failed },
};

/**
 * Every honest install state stacked, so the one canonical treatment per state
 * (glyph + label, said once, tone as a secondary cue) reads together. The
 * meaning never rides on color alone.
 */
export const AllStates: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-2">
      <InstallStateStatus state={PackInstallState.Installed} />
      <InstallStateStatus state={PackInstallState.NotInstalled} />
      <InstallStateStatus state={PackInstallState.Updatable} />
      <InstallStateStatus state={PackInstallState.Converting} />
      <InstallStateStatus state={PackInstallState.Unsupported} />
      <InstallStateStatus state={PackInstallState.Offline} />
      <InstallStateStatus state={PackInstallState.Failed} />
    </div>
  ),
};
