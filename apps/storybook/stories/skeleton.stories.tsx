import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A muted, pulsing rectangle that stands in for content while it loads,
 * sized with your own classes to match whatever it is replacing, such as an
 * avatar circle or a line of text. Use several together to sketch the
 * outline of a card or list before its real content arrives. Unlike Page
 * Loading Spinner, it previews the shape of what is coming rather than just
 * signalling that something, somewhere, is happening.
 */
const meta = {
  title: "Primitives/Feedback & Status/Skeleton",
  component: Skeleton,
  tags: ["autodocs"],
  argTypes: {},
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Skeleton>;

export default meta;

type Story = StoryObj<typeof Skeleton>;

/**
 * The default form of the skeleton.
 */
export const Default: Story = {
  render: (args) => (
    <div className="flex items-center space-x-4">
      <Skeleton {...args} className="h-12 w-12 rounded-full" />
      <div className="space-y-2">
        <Skeleton {...args} className="h-4 w-[250px]" />
        <Skeleton {...args} className="h-4 w-[200px]" />
      </div>
    </div>
  ),
};
