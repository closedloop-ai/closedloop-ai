import {
  Progress,
  ProgressTone,
} from "@repo/design-system/components/ui/progress";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A horizontal bar that fills from left to right to show how much of a task
 * is done. Pass a numeric value for a measurable amount, or leave it unset
 * for an indeterminate task: it renders as a diagonal hatch with a moving
 * sheen rather than a filled edge, so it never implies a percentage you do
 * not actually have. Use the tone prop to recolour the whole bar for a
 * status meaning like warning or success, instead of overriding the fill
 * colour by hand at the call site. Freeze an indeterminate bar that has
 * stalled with the paused prop, which keeps the hatch but stops the sheen,
 * so it reads as held rather than reset to zero.
 */
const meta = {
  title: "Primitives/Feedback & Status/Progress",
  component: Progress,
  tags: ["autodocs"],
  argTypes: {
    value: {
      control: { type: "number", min: 0, max: 100, step: 1 },
      description:
        "Amount completed. `null` (or a value above `max`) is Radix's indeterminate contract: no `aria-valuenow`, and the track renders the diagonal hatch instead of a fill.",
    },
    max: {
      control: { type: "number", min: 1, max: 1000, step: 1 },
      description:
        "Upper bound the value is read against. A zero or non-finite max falls back to 100.",
    },
    tone: {
      control: { type: "select" },
      options: [
        ProgressTone.Default,
        ProgressTone.Neutral,
        ProgressTone.Success,
        ProgressTone.Warning,
        ProgressTone.Destructive,
      ],
      description:
        "Semantic colour of the track, fill, hatch and sheen together. Prefer this over recolouring the indicator from the call site.",
    },
    paused: {
      control: "boolean",
      description:
        "Freezes the indeterminate sweep for work known to have stopped advancing. The hatch stays, so the bar reads as held rather than reset. Ignored when `value` is a number.",
    },
    sweep: {
      control: "boolean",
      description:
        "Sweeps the liveness sheen over a DETERMINATE fill, for a known value whose updating thread can block.",
    },
    className: {
      control: "text",
      description: "Extra classes merged onto the track.",
    },
  },
  args: {
    value: 30,
    max: 100,
    tone: ProgressTone.Default,
    paused: false,
    sweep: false,
  },
} satisfies Meta<typeof Progress>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the progress.
 */
export const Default: Story = {};

/**
 * When the amount of progress cannot be known. No `aria-valuenow` is emitted,
 * and the track carries a diagonal hatch with a sheen passing over it rather
 * than a partial fill — a fill edge would read as a percentage the caller never
 * claimed, and a solid full-width treatment would read as 100%. Under
 * `prefers-reduced-motion` the hatch alone remains, which still says "unknown".
 */
export const Indeterminate: Story = {
  args: {
    // `null`, not `undefined`: Storybook treats an undefined arg as "inherit
    // from meta", which would silently render the meta-level value of 30.
    value: null,
  },
};

/**
 * Indeterminate work that has stopped advancing (stalled, paused, needs
 * attention). Only the sheen goes; the hatch stays, so the bar reads as held at
 * an unknown amount. Emptying the track instead would read as 0% — a reset the
 * caller never reported.
 */
export const Paused: Story = {
  args: {
    value: null,
    paused: true,
  },
};

/**
 * Semantic tone. Pass `tone` rather than recolouring the indicator with a
 * `[&>[data-slot=progress-indicator]]:bg-*` selector at the call site: the prop
 * moves the track, the determinate fill and the indeterminate hatch and sheen
 * together, where the selector only ever reached the fill.
 */
export const SuccessTone: Story = {
  args: {
    value: 100,
    tone: ProgressTone.Success,
  },
};

/**
 * The resting band of a severity scale, and the honest tone for an amount that
 * could not be measured. `Default` spends the brand accent, so a scale built on
 * it alone is loudest where it matters least; starting neutral gives the step up
 * to warning something to mean.
 */
export const NeutralTone: Story = {
  args: {
    value: 30,
    tone: ProgressTone.Neutral,
  },
};

/** A warning-toned bar that is held rather than advancing. */
export const WarningTonePaused: Story = {
  args: {
    value: null,
    paused: true,
    tone: ProgressTone.Warning,
  },
};

/**
 * When the progress is completed.
 */
export const Completed: Story = {
  args: {
    value: 100,
  },
};
