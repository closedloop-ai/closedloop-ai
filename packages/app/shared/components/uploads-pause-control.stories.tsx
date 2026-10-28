import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import { UPLOADS_STATE } from "./uploads-pause-control";
import { UploadsPauseControlFixtureHost } from "./uploads-pause-control-fixtures";

/**
 * ISS-12528 (PRD-806): pause and resume uploads. Paused shows its own badge;
 * it is not a policy status (PR #8870 review). The stories drive the control
 * through the shared fixture host, which shows paused on the click, the way a
 * host must (Marisol Ashgrove, ISS-12528 thread
 * 01a144ff-4c9b-7518-8955-9ffe0c736f63).
 *
 * Every string below is a neutral placeholder, one per copy slot, named after
 * the slot. None of it is product copy and none of it makes a product claim.
 * The proposed wording is on the ticket for owner review. Placeholders here
 * are allowed by operator ruling (Nerys, 2026-10-15), ISS-12526 thread
 * th_Dc0RuSiAdyCvLQpC_X2G4, until the owner supplies the wording.
 */
const PLACEHOLDER = {
  heading: "Placeholder: pause control heading",
  uploadingSummary: "Placeholder: uploading summary",
  pausedSummary: "Placeholder: paused summary",
  pauseLabel: "Placeholder: pause label",
  resumeLabel: "Placeholder: resume label",
  pausedLabel: "Placeholder: paused label",
  finishingUploadDetail: "Placeholder: finishing upload detail",
  sectionHeading: "Placeholder: data settings section heading",
  levelHeading: "Placeholder: sync level heading",
  levelValue: "Placeholder: selected level",
} as const;

const meta = {
  title: "Composites/Shared/Data Controls/Uploads Pause Control",
  tags: ["experimental"],
  component: UploadsPauseControlFixtureHost,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
  args: {
    state: UPLOADS_STATE.UPLOADING,
    heading: PLACEHOLDER.heading,
    uploadingSummary: PLACEHOLDER.uploadingSummary,
    pausedSummary: PLACEHOLDER.pausedSummary,
    pauseLabel: PLACEHOLDER.pauseLabel,
    resumeLabel: PLACEHOLDER.resumeLabel,
    pausedLabel: PLACEHOLDER.pausedLabel,
    onPause: fn(),
    onResume: fn(),
  },
  argTypes: {
    state: {
      control: "inline-radio",
      options: Object.values(UPLOADS_STATE),
      description: "Uploading or paused. There is no pausing state.",
    },
    heading: { control: "text", description: "The control's heading." },
    uploadingSummary: {
      control: "text",
      description: "Uploading only: the summary line.",
    },
    pausedSummary: {
      control: "text",
      description: "Paused only: the summary line.",
    },
    pauseLabel: {
      control: "text",
      description: "Uploading only: the pause button's text.",
    },
    resumeLabel: {
      control: "text",
      description: "Paused only: the resume button's text.",
    },
    pausedLabel: {
      control: "text",
      description: "Paused only: the paused badge's text.",
    },
    finishingUploadDetail: {
      control: "text",
      description:
        "Paused only: set while the host reports an upload started before the pause is still finishing.",
    },
    onPause: { control: false, description: "See the Actions panel." },
    onResume: { control: false, description: "See the Actions panel." },
  },
} satisfies Meta<typeof UploadsPauseControlFixtureHost>;

export default meta;

type Story = StoryObj<typeof meta>;

const DARK = { globals: { theme: "dark" } } as const;

/**
 * Uploading, with pause offered. Clicking pause shows paused at once: the
 * paused badge appears and the same button becomes resume.
 */
export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: PLACEHOLDER.pauseLabel })
    );
    await expect(args.onPause).toHaveBeenCalledTimes(1);
    await expect(
      canvas.getByRole("status", { name: PLACEHOLDER.pausedLabel })
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: PLACEHOLDER.resumeLabel })
    );
    await expect(args.onResume).toHaveBeenCalledTimes(1);
  },
};

/** Paused: the summary and the paused badge both say so. */
export const Paused: Story = {
  args: { state: UPLOADS_STATE.PAUSED },
};

/**
 * Paused while an upload that started before the pause finishes. Pausing stops
 * new uploads; it does not cut one off mid-way (Marisol Ashgrove, ISS-12528
 * thread 01a144fe-9031-74cf-b91f-da83819ab224). Shown only when the host
 * reports it.
 */
export const PausedFinishingUpload: Story = {
  args: {
    state: UPLOADS_STATE.PAUSED,
    finishingUploadDetail: PLACEHOLDER.finishingUploadDetail,
  },
};

/**
 * In context: below the sync level row of a Data settings section. Pausing
 * leaves the level row untouched. The surrounding text is placeholder too.
 */
export const InDataSettings: Story = {
  args: { state: UPLOADS_STATE.PAUSED },
  render: (args) => (
    <div className="space-y-4 rounded-lg border p-4">
      <p className="font-semibold text-base">{PLACEHOLDER.sectionHeading}</p>
      <div className="space-y-1 border-b pb-4">
        <p className="font-medium text-sm">{PLACEHOLDER.levelHeading}</p>
        <p className="text-muted-foreground text-sm">
          {PLACEHOLDER.levelValue}
        </p>
      </div>
      <UploadsPauseControlFixtureHost {...args} />
    </div>
  ),
};

export const DefaultDark: Story = { ...Default, ...DARK, play: undefined };

export const PausedDark: Story = { ...Paused, ...DARK };

export const PausedFinishingUploadDark: Story = {
  ...PausedFinishingUpload,
  ...DARK,
};
