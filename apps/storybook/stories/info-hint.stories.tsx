import { InfoHint } from "@repo/design-system/components/ui/primitives/info-hint";
import type { Meta, StoryObj } from "@storybook/react";

// `InfoHint` is the single interaction model behind every info-"ⓘ" affordance
// (FEA-3819): hovering anywhere over the widened icon target — or focusing it by
// keyboard — reveals the explainer, and moving away dismisses it. No click is
// required; a click or touch tap pins it open as a secondary affordance. Because
// it opens on hover/focus, hover (or Tab to) the icon in the canvas to see the
// popover — it is not open at rest.
/**
 * A small circled i icon revealing a short explainer on hover or focus, and
 * pinned open on tap, for labeling a metric or chart title in one line.
 */
const meta = {
  title: "Composites/Feedback & Status/Info Hint",
  component: InfoHint,
  tags: ["autodocs"],
  argTypes: {
    label: {
      control: "text",
      description:
        "Accessible name for the trigger button and the popover dialog.",
    },
    align: {
      control: { type: "radio" },
      options: ["start", "center", "end"],
      description: "Popover alignment against the trigger (default `start`).",
    },
    side: {
      control: { type: "radio" },
      options: ["top", "right", "bottom", "left"],
      description: "Popover side (default `bottom`).",
    },
    iconClassName: {
      control: "text",
      description: "Icon size class (default `size-3.5`).",
    },
    sideOffset: {
      control: { type: "number", min: 0, max: 24, step: 1 },
      description:
        "Gap in px between the trigger and the popover (default 0, flush).",
    },
    triggerClassName: {
      control: "text",
      description:
        "Per-call-site trigger size/alignment tuning. The base already carries a widened `px-1.5` hit area.",
    },
    contentClassName: {
      control: "text",
      description:
        "Classes for the popover content (width, spacing, text size).",
    },
    children: { control: false },
  },
  parameters: {
    layout: "centered",
  },
  args: {
    label: "About Active sessions",
    align: "start",
    side: "bottom",
    sideOffset: 0,
    iconClassName: "size-3.5",
    contentClassName: "w-60 space-y-1 p-3 text-xs",
    children: (
      <>
        <p className="font-medium text-xs">
          Agent sessions matching the current filters and time range.
        </p>
        <p className="text-muted-foreground text-xs">
          Count of session records in the active filter set.
        </p>
      </>
    ),
  },
} satisfies Meta<typeof InfoHint>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The metric-card usage: a short explainer beside an uppercase label. Hover the
 * ⓘ — anywhere over the icon, not just its strokes — to reveal it.
 */
export const Default: Story = {
  render: (args) => (
    <span className="inline-flex items-center gap-1.5 font-semibold text-[11px] uppercase tracking-[0.12em]">
      Active sessions
      <InfoHint {...args} />
    </span>
  ),
};

/**
 * A richer, wider popover with labelled sections — the insights tile usage. The
 * same hover/focus interaction; only the content and width differ.
 */
export const RichContent: Story = {
  args: {
    label: "Metric details",
    align: "end",
    contentClassName: "w-72 space-y-2 text-sm",
    triggerClassName: "size-6",
    children: (
      <>
        <div>
          <div className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            What
          </div>
          <p>Pull requests merged in the selected period.</p>
        </div>
        <div>
          <div className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            How
          </div>
          <p className="text-muted-foreground">
            Counts PRs whose merge date falls in the range.
          </p>
        </div>
      </>
    ),
  },
};
