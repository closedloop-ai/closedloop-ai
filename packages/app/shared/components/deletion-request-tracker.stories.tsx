import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  DELETION_REQUEST_STATUS,
  type DeletionRequest,
  DeletionRequestTracker,
  type DeletionRequestTrackerCopy,
} from "./deletion-request-tracker";

/**
 * ISS-12538 (PRD-808): the deletion request tracker, one story per state.
 *
 * Every string below is a "Placeholder: <slot>" string, one per copy slot.
 * Placeholders here are allowed by operator ruling (Nerys, 2026-10-15),
 * ISS-12538 thread th_QiuGm4jTwQfUFesBJ3wOo, until the owner supplies the
 * wording. Proposed wording for owner review: ISS-12538 thread
 * th_2ZdhSq-xU_ZQ70s3b12lm.
 */
const PLACEHOLDER_COPY: DeletionRequestTrackerCopy = {
  pendingLabel: "Placeholder: pending label",
  completedLabel: "Placeholder: completed label",
  failedLabel: "Placeholder: failed label",
  unavailableLabel: "Placeholder: unavailable label",
  unavailableExplanation: "Placeholder: unavailable explanation",
  retryLabel: "Placeholder: retry label",
};

const PENDING: DeletionRequest = {
  status: DELETION_REQUEST_STATUS.PENDING,
  detail: "Placeholder: pending evidence",
};

const COMPLETED_VERIFIED: DeletionRequest = {
  status: DELETION_REQUEST_STATUS.COMPLETED,
  verified: true,
  evidence: "Placeholder: verified completion evidence",
};

const FAILED: DeletionRequest = {
  status: DELETION_REQUEST_STATUS.FAILED,
  detail: "Placeholder: failure evidence",
};

const UNAVAILABLE: DeletionRequest = {
  status: DELETION_REQUEST_STATUS.UNAVAILABLE,
};

/**
 * A payload that claims completion without the verified flag, as one could
 * arrive over an untyped boundary. The cast is the point: the type forbids it.
 */
const COMPLETED_UNVERIFIED = {
  status: DELETION_REQUEST_STATUS.COMPLETED,
  evidence: "Placeholder: unverified completion evidence",
} as unknown as DeletionRequest;

/**
 * The `request` dropdown: one option per fixture above, so every state can be
 * picked in the canvas (apps/storybook/AGENTS.md, "Controls on every story").
 * Storybook's `mapping` swaps the option key for its fixture before render.
 */
const REQUEST_FIXTURES = {
  pending: PENDING,
  completedVerified: COMPLETED_VERIFIED,
  failed: FAILED,
  unavailable: UNAVAILABLE,
  completedUnverified: COMPLETED_UNVERIFIED,
} satisfies Record<string, DeletionRequest>;

type RequestFixture = keyof typeof REQUEST_FIXTURES;

/**
 * A story's `request` arg as its dropdown key, so the control shows which
 * fixture is selected. The cast is only for the arg's type: `mapping` turns
 * the key into the fixture before the component sees it.
 */
const requestArg = (key: RequestFixture) => key as unknown as DeletionRequest;

const meta = {
  title: "Composites/Shared/Data Controls/Deletion Request Tracker",
  tags: ["experimental"],
  component: DeletionRequestTracker,
  args: {
    request: requestArg("pending"),
    copy: PLACEHOLDER_COPY,
    onRetry: fn(),
    isRetrying: false,
  },
  argTypes: {
    request: {
      control: "select",
      options: [
        "pending",
        "completedVerified",
        "failed",
        "unavailable",
        "completedUnverified",
      ],
      mapping: REQUEST_FIXTURES,
      description:
        "The request as the backend reports it. Completed needs `verified: true`.",
    },
    copy: {
      control: false,
      description: "Every visible string, from the host.",
    },
    isRetrying: {
      control: "boolean",
      description: "A retry is in flight; the retry control is disabled.",
    },
    onRetry: { control: false },
  },
} satisfies Meta<typeof DeletionRequestTracker>;

export default meta;

type Story = StoryObj<typeof meta>;

const DARK = { globals: { theme: "dark" } } as const;

/** Submitted, waiting on the backend. The dot pulses; no retry. */
export const Pending: Story = {};

/** Unavailable, explaining that nothing was removed (AC-002). */
export const Unavailable: Story = {
  args: { request: requestArg("unavailable") },
};

export const UnavailableDark: Story = {
  ...DARK,
  args: { request: requestArg("unavailable") },
};

/** Completed, from a verified backend signal, with its evidence (AC-003). */
export const CompletedVerified: Story = {
  args: { request: requestArg("completedVerified") },
};

/** Failed, with a retry control (AC-002). */
export const Failed: Story = {
  args: { request: requestArg("failed") },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: PLACEHOLDER_COPY.retryLabel })
    );
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

/** A retry in flight: the control is disabled. */
export const FailedRetrying: Story = {
  args: { request: requestArg("failed"), isRetrying: true },
};

/**
 * A completion without the verified flag renders as pending, never as
 * completed, and its unverified evidence is not shown (AC-003).
 */
export const UnverifiedCompletionStaysPending: Story = {
  args: { request: requestArg("completedUnverified") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("status", { name: PLACEHOLDER_COPY.pendingLabel })
    ).toBeInTheDocument();
    await expect(
      canvas.queryByText(PLACEHOLDER_COPY.completedLabel)
    ).not.toBeInTheDocument();
  },
};

export const PendingDark: Story = { ...DARK };

export const CompletedVerifiedDark: Story = {
  ...DARK,
  args: { request: requestArg("completedVerified") },
};

export const FailedDark: Story = {
  ...DARK,
  args: { request: requestArg("failed") },
};
