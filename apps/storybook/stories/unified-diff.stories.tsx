import { UnifiedDiff } from "@repo/design-system/components/ui/primitives/unified-diff";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Primitives/Unified Diff",
  component: UnifiedDiff,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
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
