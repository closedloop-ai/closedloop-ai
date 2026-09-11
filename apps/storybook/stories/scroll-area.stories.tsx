import { ScrollArea } from "@repo/design-system/components/ui/scroll-area";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A scrollable region with the browser's native scrollbar replaced by one
 * styled to match the design system, used instead of a plain scrolling div
 * with a mismatched scrollbar.
 */
const meta = {
  title: "Primitives/Layout/Scroll Area",
  component: ScrollArea,
  tags: ["autodocs"],
  argTypes: {
    children: {
      control: "text",
    },
    type: {
      options: ["auto", "always", "scroll", "hover"],
      control: { type: "radio" },
      description: "When the scrollbars are visible.",
    },
    scrollbars: {
      options: ["vertical", "horizontal", "both"],
      control: { type: "radio" },
      description: "Which axes get a scrollbar.",
    },
    scrollHideDelay: {
      control: { type: "number", min: 0, max: 2000, step: 50 },
      description:
        "Milliseconds before the scrollbars hide, for the scroll and hover types.",
    },
    dir: {
      options: ["ltr", "rtl"],
      control: { type: "radio" },
    },
    className: {
      control: "text",
    },
    asChild: {
      control: false,
    },
  },
  args: {
    className: "h-32 w-80 rounded-md border p-4",
    type: "auto",
    scrollbars: "vertical",
    scrollHideDelay: 600,
    children:
      "Jokester began sneaking into the castle in the middle of the night and leaving jokes all over the place: under the king's pillow, in his soup, even in the royal toilet. The king was furious, but he couldn't seem to stop Jokester. And then, one day, the people of the kingdom discovered that the jokes left by Jokester were so funny that they couldn't help but laugh. And once they started laughing, they couldn't stop. The king was so angry that he banished Jokester from the kingdom, but the people still laughed, and they laughed, and they laughed. And they all lived happily ever after.",
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof ScrollArea>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the scroll area.
 */
export const Default: Story = {};

/**
 * Renders every `type` value side by side, each labelled with its own name,
 * so one Chromatic snapshot keeps visual coverage for auto, always, scroll,
 * and hover instead of four separate story snapshots.
 */
export const AllVariants: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
      {(["auto", "always", "scroll", "hover"] as const).map((type) => (
        <div
          key={type}
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          <span style={{ fontSize: 11 }}>{type}</span>
          <ScrollArea
            className="h-32 w-64 rounded-md border p-4"
            scrollbars="vertical"
            scrollHideDelay={600}
            type={type}
          >
            Jokester began sneaking into the castle in the middle of the night
            and leaving jokes all over the place: under the king's pillow, in
            his soup, even in the royal toilet. The king was furious, but he
            couldn't seem to stop Jokester.
          </ScrollArea>
        </div>
      ))}
    </div>
  ),
};
