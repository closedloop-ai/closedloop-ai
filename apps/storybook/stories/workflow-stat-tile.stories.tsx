import { WorkflowStatTile } from "@repo/design-system/components/ui/primitives/workflow-stat-tile";
import type { Meta, StoryObj } from "@storybook/react";
import { RefreshCcw } from "lucide-react";

const WorkflowStatTileCanvas = () => (
  <div className="w-[320px]">
    <WorkflowStatTile
      description="Recovered during upstream workflow analysis"
      icon={RefreshCcw}
      label="Total compactions"
      meta={<span className="font-semibold text-primary text-xs">healthy</span>}
      value="74"
    />
  </div>
);

const meta = {
  title: "Design System/Data Display/Data Visualization/Workflow Stat Tile",
  component: WorkflowStatTileCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof WorkflowStatTileCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
