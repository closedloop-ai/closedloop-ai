import { UnifiedDiff } from "@repo/design-system/components/ui/primitives/unified-diff";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Primitives/Content/Unified Diff",
  component: UnifiedDiff,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    hunks: {
      control: "object",
      description:
        "Unified-diff hunks. Each line keeps its leading +, -, or space, and the counters start at oldStart / newStart. An empty array renders the no-diff state.",
    },
  },
  args: {
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        oldLines: 3,
        newLines: 4,
        lines: [
          " export function SessionTable() {",
          "-  return <Table />;",
          "+  return <Card><Table /></Card>;",
          "+  // reuse shared session surface",
          " }",
        ],
      },
    ],
  },
} satisfies Meta<typeof UnifiedDiff>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
