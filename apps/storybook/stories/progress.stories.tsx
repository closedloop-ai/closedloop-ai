import {
  Progress,
  ProgressTone,
} from "@repo/design-system/components/ui/progress";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * Displays an indicator showing the completion progress of a task, typically
 * displayed as a progress bar.
 */
const meta = {
  title: "Design System/Primitives/Progress",
  component: Progress,
  tags: ["autodocs"],
  argTypes: {},
  args: {
    value: 30,
    max: 100,
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
