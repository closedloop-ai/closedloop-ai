import {
  StatusIcon,
  type StatusIconStatus,
} from "@repo/design-system/components/ui/status-icon";
import type { Meta, StoryObj } from "@storybook/react";

// Renders a circular SVG icon representing a phase-based status.
// In-progress and in-review show an inner filled circle matching the
// outer arc color. Supports a "thinking" spinner overlay for AI processing.
/**
 * A small circular icon showing a named phase of work, like backlog or in
 * review, as a ring that fills closer to done, used instead of a text badge
 * in a dense list or table.
 */
const meta = {
  title: "Primitives/Feedback & Status/Status Icon",
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
        // Also a real member of `StatusIconStatus`: the muted neutral marker
        // the component falls back to for a status it does not recognize.
        "decorative",
      ],
    },
    size: {
      options: [16, 20],
      control: { type: "radio" },
      description: "Rendered box size in pixels.",
    },
    thinking: {
      control: "boolean",
      description:
        "Spinning arc for AI processing. Ignored for the terminal statuses complete and wont-do.",
    },
  },
  args: {
    status: "in-progress",
    size: 16,
    thinking: false,
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof StatusIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { status: "in-progress" },
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
  // The muted neutral marker the component falls back to for a status it does
  // not recognise. It is a real member of `StatusIconStatus` and it is in the
  // Controls options, so a matrix that claims to show every status owes it a
  // swatch too.
  "decorative",
];

/**
 * Every status value at the default size (16px), each labelled. The
 * individual per-status stories were pure icon permutations of the same
 * component, so this one story keeps a single Chromatic snapshot covering
 * all of them instead of one snapshot per status. Drive a single status
 * through the Controls panel on the Default story above.
 */
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

/** Thinking spinner on arc-based statuses, inner fill stays visible. */
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
