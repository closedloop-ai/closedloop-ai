import { KeyValueGrid } from "@repo/design-system/components/ui/primitives/key-value-grid";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * Lays out an object as a two column table, with the key sitting in a muted
 * left column and the value on the right, whether that value is a plain
 * string, a formatted number, a true or false tag, or a nested object
 * printed as indented JSON. Reach for it when you need to inspect a raw
 * record, like a session payload, rather than a fixed set of named fields
 * like Overview Metric. You can pin specific keys to the top in whatever
 * order matters, and an empty object shows a plain "Empty" message instead
 * of a blank table.
 */
const meta = {
  title: "Primitives/Data Display/Key Value Grid",
  component: KeyValueGrid,
  tags: ["autodocs"],
  argTypes: {
    data: {
      control: "object",
      description:
        "Key/value pairs to render. Object and array values render as formatted JSON.",
    },
    priority: {
      control: "object",
      description: "Keys pinned to the top, in this order, ahead of the rest.",
    },
  },
  parameters: { layout: "padded" },
  args: {
    data: {
      sessionId: "sess-42",
      status: "active",
      retries: 2,
      approved: true,
      metadata: { source: "desktop", featureFlag: "agent-session-sync" },
    },
    priority: ["sessionId", "status"],
  },
} satisfies Meta<typeof KeyValueGrid>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
