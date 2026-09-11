import { InstallSource } from "@repo/api/src/types/install-source";
import type { Meta, StoryObj } from "@storybook/react";
import { InstallSourceLabel } from "./install-source-label";

/**
 * A plain text label naming how a pack got installed, org pushed, opted in,
 * self installed, or required, kept muted since provenance isn't a status
 * that needs action.
 */
const meta = {
  title: "Composites/Packs/Install Source Label",
  component: InstallSourceLabel,
  tags: ["autodocs"],
  args: {
    source: InstallSource.Pushed,
  },
  argTypes: {
    source: { control: "select", options: Object.values(InstallSource) },
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof InstallSourceLabel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Pushed: Story = {};

export const OptedIn: Story = {
  args: { source: InstallSource.OptedIn },
};

export const Self: Story = {
  args: { source: InstallSource.Self },
};

export const Required: Story = {
  args: { source: InstallSource.Required },
};

export const Unknown: Story = {
  args: { source: InstallSource.Unknown },
};

/**
 * All sources stacked so the uniform (muted) tone and label widths read
 * together — provenance is metadata, not four competing status colors.
 */
export const AllSources: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-2">
      <InstallSourceLabel source={InstallSource.Pushed} />
      <InstallSourceLabel source={InstallSource.OptedIn} />
      <InstallSourceLabel source={InstallSource.Self} />
      <InstallSourceLabel source={InstallSource.Required} />
      <InstallSourceLabel source={InstallSource.Unknown} />
    </div>
  ),
};
