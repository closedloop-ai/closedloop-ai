import type { Meta, StoryObj } from "@storybook/react";
import {
  DesktopRecheckPhase,
  DesktopUndetectedNotice,
} from "./desktop-undetected-notice";

/**
 * The ISS-5247 not-detected surface, in every state the onboarding desktop step
 * can put it in.
 *
 * These are worth seeing side by side because the distinction between them is
 * the whole point of the component and is invisible in any single screenshot:
 * two of these states are still *looking*, and two are an *answer*. Driving
 * them by hand needs a real desktop-absent machine plus a full twelve-sweep
 * poll budget to run out, so the matrix is easy to regress without noticing.
 *
 * The pairing that matters is Watching versus GaveUp. They are both "we have
 * not found it", but only GaveUp is entitled to say so — a probe that is still
 * running must never render as a proven negative it has not established yet.
 */
const meta: Meta<typeof DesktopUndetectedNotice> = {
  args: {
    onRecheck: () => {
      // Storybook has no detection store; the control is here to be looked at.
    },
    runningVersion: null,
  },
  component: DesktopUndetectedNotice,
  // Matches the onboarding step body, which clamps its content to max-w-2xl.
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-2xl py-8">
        <Story />
      </div>
    ),
  ],
  title: "App Core/Onboarding/Desktop Undetected Notice",
};

export default meta;

type Story = StoryObj<typeof DesktopUndetectedNotice>;

/**
 * Sweep one of twelve. Detection has not given up, so there is no answer yet
 * and deliberately no control: offering "Check again" mid-run would contradict
 * the spinner and reset the poll budget out from under it.
 */
export const Watching: Story = {
  args: {
    detectionExhausted: false,
    latestVersion: null,
    phase: DesktopRecheckPhase.Idle,
  },
};

/**
 * The poll loop has exhausted its budget with a release lookup available. This
 * is the first state entitled to the terminal sentence, and the detection
 * result leads it — the installer version is the follow-on clause, not the
 * headline.
 */
export const GaveUpWithVersion: Story = {
  args: {
    detectionExhausted: true,
    latestVersion: "1.4.2",
    phase: DesktopRecheckPhase.Idle,
  },
};

/** The same terminal state when the release lookup returned nothing. */
export const GaveUpWithoutVersion: Story = {
  args: {
    detectionExhausted: true,
    latestVersion: null,
    phase: DesktopRecheckPhase.Idle,
  },
};

/**
 * Mid re-check, held for at least 600ms so the click is perceivable. The button
 * is disabled and the copy drops every claim about the result while the probe
 * is in flight. Note this renders the alert even though detection had not
 * exhausted — an explicit user re-check is its own reason to show the control.
 */
export const Checking: Story = {
  args: {
    detectionExhausted: false,
    latestVersion: "1.4.2",
    phase: DesktopRecheckPhase.Checking,
  },
};

/**
 * The user pressed "Check again" and it still is not there. Distinct copy from
 * GaveUp on purpose: repeating the original sentence verbatim reads as if the
 * click did nothing.
 */
export const StillAbsentAfterRecheck: Story = {
  args: {
    detectionExhausted: true,
    latestVersion: "1.4.2",
    phase: DesktopRecheckPhase.StillAbsent,
  },
};

/**
 * The re-check landed while the poll loop had already re-armed. The notice
 * falls back to the passive watching strip rather than the terminal alert,
 * because detection is genuinely still running.
 */
export const StillAbsentWhileStillWatching: Story = {
  args: {
    detectionExhausted: false,
    latestVersion: null,
    phase: DesktopRecheckPhase.StillAbsent,
  },
};
