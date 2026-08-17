import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import type { Meta, StoryObj } from "@storybook/react";
import { SearchXIcon } from "lucide-react";
import { fn } from "storybook/test";

const meta = {
  title: "Design System/Primitives/Empty State",
  component: EmptyState,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: {
    description:
      "No matching sessions were found. Adjust filters or refresh the source.",
    icon: SearchXIcon,
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
