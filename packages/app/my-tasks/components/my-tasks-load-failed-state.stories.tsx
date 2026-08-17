import type { Meta, StoryObj } from "@storybook/react";
import { MyTasksLoadFailedState } from "./my-tasks-load-failed-state";

/**
 * ISS-4683 — the My Tasks degraded read state, on a canvas.
 *
 * A failure state is only reachable in the product by breaking the network, so
 * it is the one nobody eyeballs again after it ships. That is exactly why it
 * earns a story: the icon tone, the retry affordance, and the two lines of copy
 * are checkable here in both themes without anyone unplugging anything.
 *
 * It renders before either My Tasks view's empty branches, so a failed read can
 * never masquerade as "your queue is clear" (the FEA-3938 rule).
 */
const meta = {
  title: "App Core/My Tasks/Load Failed State",
  component: MyTasksLoadFailedState,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="flex min-h-80 w-full flex-col border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MyTasksLoadFailedState>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The only state this component has: a named failure with a way out. */
export const Default: Story = {
  args: { onRetry: () => undefined },
};
