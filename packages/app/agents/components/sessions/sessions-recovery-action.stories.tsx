import type { Meta, StoryObj } from "@storybook/react";
import { SessionsRecoveryAction } from "./sessions-recovery-action";

/**
 * ISS-5451: the Sessions-list recovery affordance, isolated.
 *
 * ISS-4534 reduced this to one honest action after three separate problems with
 * the previous "Go to Sessions" button: the label offered to take the user
 * somewhere they already stood, it was a strict superset of the Retry sitting
 * beside it, and a Cmd/Ctrl-click that opened the clean URL in a new tab ALSO
 * wiped the current tab's filters.
 *
 * The label now states what it does — clear the filters and re-run the read —
 * and the filter-clearing side effect is gated behind `isModifiedClick`, so a
 * modified or non-primary click only lets the browser open `href` and leaves the
 * current tab's scope alone. That gate is behavioural rather than visual, so it
 * is covered by a unit test rather than a story; what the story is for is the
 * label, which is the part that lied.
 */
const meta = {
  title: "App Core/Agents/Sessions Recovery Action",
  component: SessionsRecoveryAction,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: {
    href: "/sessions",
    onClearFilters: () => undefined,
  },
} satisfies Meta<typeof SessionsRecoveryAction>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The single primary action of the errored Sessions empty state. */
export const Default: Story = {};

/**
 * The desktop shell's list root. The href is host-supplied so a middle or
 * modified click still opens a working list in a new tab.
 */
export const DesktopHref: Story = {
  args: { href: "/sessions?reset=1" },
};
