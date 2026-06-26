import {
  StatusIcon,
  type StatusIconStatus,
} from "@repo/design-system/components/ui/status-icon";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * Renders a circular SVG icon representing a phase-based status.
 * In-progress and in-review show an inner filled circle matching the
 * outer arc color. Supports a "thinking" spinner overlay for AI processing.
 */
const meta = {
  title: "Design System/Data Display/Status Icon",
  component: StatusIcon,
  tags: ["autodocs"],
  argTypes: {
    status: {
      control: "select",
      options: [
        "backlog",
        "todo",
        "started",
        "in-progress",
        "in-review",
        "executed",
        "complete",
        "wont-do",
      ],
    },
    size: { control: "select", options: [16, 20] },
    thinking: { control: "boolean" },
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof StatusIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { status: "in-progress" },
};

export const Backlog: Story = {
  args: { status: "backlog" },
};

export const Todo: Story = {
  args: { status: "todo" },
};

export const Started: Story = {
  args: { status: "started" },
};

export const InProgress: Story = {
  args: { status: "in-progress" },
};

export const InReview: Story = {
  args: { status: "in-review" },
};

export const Executed: Story = {
  args: { status: "executed" },
};

export const Complete: Story = {
  args: { status: "complete" },
};

export const WontDo: Story = {
  args: { status: "wont-do" },
};

const ALL_STATUSES: StatusIconStatus[] = [
  "backlog",
  "todo",
  "started",
  "in-progress",
  "in-review",
  "executed",
  "complete",
  "wont-do",
];

/** All statuses at default size (16px). */
export const AllStatuses: Story = {
  args: { status: "backlog" },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {ALL_STATUSES.map((s) => (
        <div
          key={s}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <StatusIcon status={s} />
          <span style={{ fontSize: 11 }}>{s}</span>
        </div>
      ))}
    </div>
  ),
};

/** All statuses at 20px. */
export const Size20: Story = {
  args: { status: "in-progress", size: 20 },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {ALL_STATUSES.map((s) => (
        <div
          key={s}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <StatusIcon size={20} status={s} />
          <span style={{ fontSize: 11 }}>{s}</span>
        </div>
      ))}
    </div>
  ),
};

/** Thinking spinner on arc-based statuses — inner fill stays visible. */
export const Thinking: Story = {
  args: { status: "in-progress", thinking: true },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {(
        [
          "backlog",
          "todo",
          "started",
          "in-progress",
          "in-review",
          "executed",
        ] as const
      ).map((s) => (
        <div
          key={s}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <StatusIcon status={s} thinking />
          <span style={{ fontSize: 11 }}>{s}</span>
        </div>
      ))}
    </div>
  ),
};

/** Side-by-side: normal vs thinking. */
export const NormalVsThinking: Story = {
  args: { status: "in-progress" },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {(["started", "in-progress", "in-review", "executed"] as const).map(
        (s) => (
          <div
            key={s}
            style={{ display: "flex", alignItems: "center", gap: 24 }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
              }}
            >
              <StatusIcon size={20} status={s} />
              <span style={{ fontSize: 11 }}>{s}</span>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
              }}
            >
              <StatusIcon size={20} status={s} thinking />
              <span style={{ fontSize: 11 }}>{s} thinking</span>
            </div>
          </div>
        )
      )}
    </div>
  ),
};
