import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  DEFAULT_DESKTOP_DOWNLOAD_HREFS,
  DesktopOs,
} from "../lib/desktop-platform-availability";
import { FIXTURE_ACCOUNT } from "../lib/guided-onboarding-fixtures";
import {
  type DesktopAvailabilityNotifyCopy,
  DesktopAvailabilityNotifyForm,
} from "./desktop-availability-notify-form";
import { OnboardingDesktopSkipEligibility } from "./guided-onboarding-data";
import { GuidedOnboardingDialog } from "./guided-onboarding-dialog";

/**
 * ISS-12364: the email capture a reader gets on the download step when their
 * platform has no published installer (today: Windows). Design-only: no
 * waitlist endpoint exists, so the host's `onSubmit` promise is the whole
 * backend here, and each story settles it the way the state needs.
 *
 * The call to action is the ticket's own suggested message (ISS-12364
 * description, "Design scope"), written by its product author. Every other
 * string is a neutral placeholder, one per copy slot, named after the slot.
 * Placeholders here are allowed by operator ruling (Nerys, 2026-10-15),
 * ISS-12526 thread th_Dc0RuSiAdyCvLQpC_X2G4, until the owner supplies the
 * wording.
 */
const COPY = {
  emailLabel: "Placeholder: email field label",
  explanation: "Placeholder: what submitting does (no release date)",
  failure: "Placeholder: request failed, try again",
  invalidEmail: "Placeholder: not a valid email address",
  retryLabel: "Placeholder: retry button",
  submitLabel: "Notify me when the Windows app is available",
  submittingLabel: "Placeholder: submitting button",
  successDetail: "Placeholder: what happens next",
  successTitle: "Placeholder: request received",
} as const satisfies DesktopAvailabilityNotifyCopy;

/** The shared fixture reader's address: Web reaches this step signed in. */
const READER_EMAIL =
  FIXTURE_ACCOUNT.status === "signed-in" ? FIXTURE_ACCOUNT.email : "";

const meta = {
  title: "Composites/Onboarding/Desktop Availability Notify Form",
  tags: ["experimental"],
  component: DesktopAvailabilityNotifyForm,
  parameters: { layout: "padded" },
  args: {
    copy: COPY,
    onSubmit: fn(() => Promise.resolve()),
  },
  argTypes: {
    copy: { control: false },
    defaultEmail: { control: "text" },
    onSubmit: { control: false },
  },
  // The download step clamps its body to `max-w-sm`, so the form is drawn at
  // the width it actually gets.
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-sm">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DesktopAvailabilityNotifyForm>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Before anything is typed: the purpose, the field and the call to action. */
export const Initial: Story = {};

/** The signed-in reader's address offered pre-filled, still editable. */
export const Prefilled: Story = {
  args: { defaultEmail: READER_EMAIL },
};

/** Submitted with an address that cannot be an email: nothing is sent. */
export const InvalidEmail: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByLabelText(COPY.emailLabel),
      "reader@example"
    );
    await userEvent.click(
      canvas.getByRole("button", { name: COPY.submitLabel })
    );
    await expect(await canvas.findByText(COPY.invalidEmail)).toBeVisible();
    await expect(args.onSubmit).not.toHaveBeenCalled();
  },
};

/** The host's request in flight: the button is busy and disabled. */
export const Submitting: Story = {
  args: {
    defaultEmail: READER_EMAIL,
    // Never settles, so the story stays in flight.
    onSubmit: fn(() => new Promise<void>(() => undefined)),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: COPY.submitLabel })
    );
    await expect(
      await canvas.findByRole("button", { name: COPY.submittingLabel })
    ).toBeDisabled();
  },
};

/** The request was received: the form gives way to a confirmation. */
export const Success: Story = {
  args: { defaultEmail: READER_EMAIL },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: COPY.submitLabel })
    );
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      COPY.successTitle
    );
  },
};

/** The request failed: the address is kept and the button becomes the retry. */
export const SubmissionError: Story = {
  args: {
    defaultEmail: READER_EMAIL,
    onSubmit: fn(() => Promise.reject(new Error("Storybook: request failed"))),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: COPY.submitLabel })
    );
    await expect(await canvas.findByText(COPY.failure)).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: COPY.retryLabel })
    ).toBeEnabled();
  },
};

/**
 * Where it lives: the Web download step for a Windows reader, between the
 * approved "Not available for Windows yet" alert and `Continue without
 * installing`, which stays the way on in every state.
 */
export const InDownloadStep: Story = {
  parameters: { layout: "fullscreen" },
  render: (args) => (
    <GuidedOnboardingDialog
      brand={<span className="font-semibold">Closedloop.ai</span>}
      desktopMode={false}
      desktopSkipEligibility={OnboardingDesktopSkipEligibility.Required}
      downloadHrefs={DEFAULT_DESKTOP_DOWNLOAD_HREFS}
      installerGapFollowUp={() => (
        <DesktopAvailabilityNotifyForm
          copy={args.copy}
          defaultEmail={READER_EMAIL}
          onSubmit={args.onSubmit}
        />
      )}
      onComplete={() => undefined}
      open
      phase={OnboardingPhase.DownloadDesktop}
      platformOverride={DesktopOs.Windows}
    />
  ),
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(
      await body.findByRole("button", { name: COPY.submitLabel })
    ).toBeVisible();
    await expect(
      body.getByRole("button", { name: "Continue without installing" })
    ).toBeVisible();
  },
};
