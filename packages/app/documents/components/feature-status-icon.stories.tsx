import {
  FEATURE_STATUS_OPTIONS,
  type FeatureStatus,
} from "@repo/api/src/types/document";
import { FEATURE_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import type { Meta, StoryObj } from "@storybook/react";
import { FeatureStatusIcon } from "./feature-status-icon";

/**
 * One glyph per Feature delivery-lifecycle status. Features follow a delivery
 * lifecycle (triage → backlog → todo → in progress → in review → done) distinct
 * from the Document authoring lifecycle. Documents use `DocumentStatusIcon`.
 */
const meta = {
  title: "App Core/Documents/Feature Status Icon",
  component: FeatureStatusIcon,
  tags: ["autodocs"],
  argTypes: {
    status: { control: "select", options: FEATURE_STATUS_OPTIONS },
    size: { control: "select", options: [16, 20] },
    thinking: { control: "boolean" },
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof FeatureStatusIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { status: FEATURE_STATUS_OPTIONS[0] },
};

/** Every Feature status at the default size. */
export const AllStatuses: Story = {
  args: { status: FEATURE_STATUS_OPTIONS[0] },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {FEATURE_STATUS_OPTIONS.map((status) => (
        <div
          key={status}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <FeatureStatusIcon status={status as FeatureStatus} />
          <span style={{ fontSize: 11 }}>
            {FEATURE_STATUS_LABELS[status as FeatureStatus]}
          </span>
        </div>
      ))}
    </div>
  ),
};
