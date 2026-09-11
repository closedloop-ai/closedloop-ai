import { InstallSource } from "@repo/api/src/types/install-source";
import type { Meta, StoryObj } from "@storybook/react";
import { InstallSourceLabel } from "./install-source-label";

/**
 * A small plain text label that explains how a pack ended up installed:
 * pushed by your organization, something you opted into, something you
 * installed yourself, or a required install you can't remove. It always
 * renders in the same muted tone no matter which source it names, because
 * provenance is background information, not a status that needs action. Use
 * it instead of a colored badge or icon whenever you want to show where
 * something came from without implying it needs attention. Hovering or
 * focusing it reveals the fuller explanation as a tooltip.
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
