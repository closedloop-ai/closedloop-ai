import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { UploadQueueView } from "./upload-queue-view";
import { UPLOADS_STATE, UploadsPauseControl } from "./uploads-pause-control";

/**
 * ISS-12529 (PRD-806): what is queued, in flight and failed for upload. The
 * desktop host feeds the counts from the existing cloud sync progress hook
 * (`useUploadQueueCounts`), so the stories pass counts directly.
 *
 * Every string below is a neutral placeholder, one per copy slot, named after
 * the slot. None of it is product copy and none of it makes a product claim.
 * Placeholders here are allowed by operator ruling (Nerys, 2026-10-15),
 * ISS-12526 thread th_Dc0RuSiAdyCvLQpC_X2G4, until the owner supplies the
 * wording.
 */
const PLACEHOLDER = {
  heading: "Placeholder: upload queue heading",
  queuedLabel: "Placeholder: queued label",
  inFlightLabel: "Placeholder: in-flight label",
  failedLabel: "Placeholder: failed label",
  emptyText: "Placeholder: empty queue text",
  unmeasuredText: "Placeholder: unmeasured queue text",
  sectionHeading: "Placeholder: data settings section heading",
  pauseHeading: "Placeholder: pause control heading",
  uploadingSummary: "Placeholder: uploading summary",
  pauseLabel: "Placeholder: pause label",
} as const;

const COPY = {
  heading: PLACEHOLDER.heading,
  queuedLabel: PLACEHOLDER.queuedLabel,
  inFlightLabel: PLACEHOLDER.inFlightLabel,
  failedLabel: PLACEHOLDER.failedLabel,
  emptyText: PLACEHOLDER.emptyText,
  unmeasuredText: PLACEHOLDER.unmeasuredText,
};

const meta = {
  title: "Composites/Shared/Data Controls/Upload Queue View",
  tags: ["experimental"],
  component: UploadQueueView,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
  args: {
    counts: { queued: 42, inFlight: 3, failed: 1 },
    copy: COPY,
  },
  argTypes: {
    counts: {
      control: "object",
      description:
        "Queued, in flight and failed. Null while the lane has not measured its queues.",
    },
    copy: {
      control: "object",
      description: "Every visible string, one per slot, from the host.",
    },
    className: { control: false, description: "Layout only." },
  },
} satisfies Meta<typeof UploadQueueView>;

export default meta;

type Story = StoryObj<typeof meta>;

const DARK = { globals: { theme: "dark" } } as const;

/** Uploads under way: each state with its count. In flight pulses its dot. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByRole("list", { name: PLACEHOLDER.heading });
    await expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  },
};

/** Nothing queued, in flight or failed. */
export const Empty: Story = {
  args: { counts: { queued: 0, inFlight: 0, failed: 0 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(PLACEHOLDER.emptyText)).toBeVisible();
    await expect(canvas.queryByRole("list")).toBeNull();
  },
};

export const EmptyDark: Story = { ...Empty, ...DARK, play: undefined };

/**
 * Only failures left. The list stays: an empty state here would hide the
 * failure.
 */
export const FailedOnly: Story = {
  args: { counts: { queued: 0, inFlight: 0, failed: 2 } },
};

/**
 * The lane has not measured its queues yet (first poll, or a device switch).
 * Never shown as empty.
 */
export const Unmeasured: Story = {
  args: { counts: null },
};

/**
 * A first-connect backfill: counts in the thousands keep their row. The shape
 * the lane emits (PR #8877 review): in flight is the one batch on the wire,
 * capped at the per-request session limit (25), and the rest of the history
 * waits as queued. Between batches in flight reads 0.
 */
export const LargeBacklog: Story = {
  args: { counts: { queued: 12_455, inFlight: 25, failed: 0 } },
};

/**
 * In context: beside the uploads pause control (ISS-12528) in a Data settings
 * section. The surrounding text is placeholder too.
 */
export const InDataSettings: Story = {
  render: (args) => (
    <div className="space-y-4 rounded-lg border p-4">
      <p className="font-semibold text-base">{PLACEHOLDER.sectionHeading}</p>
      <UploadsPauseControl
        className="border-b pb-4"
        heading={PLACEHOLDER.pauseHeading}
        onPause={() => undefined}
        pauseLabel={PLACEHOLDER.pauseLabel}
        state={UPLOADS_STATE.UPLOADING}
        summary={PLACEHOLDER.uploadingSummary}
      />
      <UploadQueueView {...args} />
    </div>
  ),
};

export const DefaultDark: Story = { ...Default, ...DARK, play: undefined };

export const FailedOnlyDark: Story = { ...FailedOnly, ...DARK };
