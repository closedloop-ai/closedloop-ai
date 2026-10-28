import type { Meta, StoryObj } from "@storybook/react";
import { MultiEmailInviteField } from "./multi-email-invite-field";

/**
 * The reusable invite composer, shared by guided onboarding and Settings
 * (ISS-8348). Its states are what a host drives while a send is in flight or
 * comes back rejected, so they are the ones worth seeing side by side.
 */
const meta: Meta<typeof MultiEmailInviteField> = {
  component: MultiEmailInviteField,
  parameters: { layout: "centered" },
  tags: ["deprecated", "autodocs"],
  title: "Composites v1.0/Organizations/Multi Email Invite Field",
};

export default meta;

type Story = StoryObj<typeof MultiEmailInviteField>;

export const Empty: Story = {
  args: { onSubmit: () => undefined },
};

/** A send is in flight: the field and both controls are inert. */
export const Pending: Story = {
  args: { onSubmit: () => undefined, pending: true },
};

/**
 * The server rejected the send. The message sits in its OWN live region — the
 * addresses are still valid, so the parser's error and `aria-invalid` stay
 * untouched.
 */
export const SubmissionFailed: Story = {
  args: {
    onSubmit: () => undefined,
    submissionError: "We couldn't reach the invitation service. Try again.",
  },
};

/**
 * Two composers on one page, which is what Settings plus an open onboarding
 * modal produces. Their ids must not collide, or both labels focus the first
 * input.
 */
export const TwoOnOnePage: Story = {
  render: () => (
    <div className="flex w-[32rem] flex-col gap-8">
      <MultiEmailInviteField onSubmit={() => undefined} />
      <MultiEmailInviteField onSubmit={() => undefined} />
    </div>
  ),
};
