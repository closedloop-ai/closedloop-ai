import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import type { Meta, StoryObj } from "@storybook/react";
import { SearchXIcon } from "lucide-react";
import { fn } from "storybook/test";

/**
 * A centered placeholder for a screen or panel that has nothing to show: an
 * icon, a title, an optional description, and an optional button underneath
 * for what to do next. Use the compact size when it sits inside a card or
 * panel next to other content, and the default size when the empty state
 * fills the whole page on its own. Promote the title to a real heading only
 * when the empty state is the entire page, since otherwise it's invisible to
 * anyone navigating by headings.
 */
const meta = {
  title: "Composites/Feedback & Status/Empty State",
  component: EmptyState,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    icon: {
      control: false,
      description: "Lucide icon component rendered above the title.",
    },
    title: { control: "text" },
    titleAs: {
      options: ["h1", "h2", "h3"],
      control: { type: "radio" },
      description:
        "Promotes the title to a real heading for full-page empty states.",
    },
    description: { control: "text" },
    size: {
      options: ["default", "compact"],
      control: { type: "radio" },
    },
    action: {
      control: false,
      description: "Optional call-to-action node rendered under the copy.",
    },
    className: { control: "text" },
  },
  args: {
    description:
      "No matching sessions were found. Adjust filters or refresh the source.",
    icon: SearchXIcon,
    size: "default",
    title: "No sessions found",
  },
  decorators: [
    (Story) => (
      <div className="w-[460px] rounded-lg border bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithAction: Story = {
  args: {
    action: (
      <Button onClick={fn()} size="sm" variant="outline">
        Clear filters
      </Button>
    ),
  },
};

// The compact size caps vertical padding at the DS `py-6` step across all
// breakpoints, for a zero-state that sits inside a panel/card alongside other
// content rather than owning the whole screen.
export const Compact: Story = {
  args: {
    size: "compact",
  },
};

// `titleAs` promotes the title from the default styled `div` to a real heading,
// for the case where the empty state IS the page (a full-page 404 or
// unavailable screen) rather than a zero-state inside a panel that already has
// its own heading. Purely semantic: Tailwind preflight resets `h1`-`h6` to
// inherit font-size and weight, so this renders identically to `Default` while
// giving screen-reader users a heading to navigate to (ISS-5011).
export const AsPageHeading: Story = {
  args: {
    titleAs: "h1",
  },
};
