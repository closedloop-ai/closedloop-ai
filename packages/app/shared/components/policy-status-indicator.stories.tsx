import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  POLICY_STATUS,
  type PolicyStatus,
  PolicyStatusIndicator,
} from "./policy-status-indicator";

/**
 * ISS-12526 (PRD-806): the data-sync policy status indicator, one story per
 * state, on the shared status badge.
 *
 * Every string below is a neutral placeholder, one per copy slot, so a
 * designer can see which slot is which. None of it is product copy and none
 * of it makes a product claim. The proposed wording lives on the ticket for
 * owner review, in ISS-12526 thread th_T-PPkWx9JgsQznjbNL-S5. The component
 * takes all its text as props and authors none.
 *
 * Placeholders here are allowed by operator ruling (Nerys, 2026-10-15),
 * ISS-12526 thread th_Dc0RuSiAdyCvLQpC_X2G4, until the owner supplies the
 * wording.
 */
const PLACEHOLDER_LABEL: Record<PolicyStatus, string> = {
  [POLICY_STATUS.ACTIVE]: "Placeholder: active label",
  [POLICY_STATUS.PENDING]: "Placeholder: pending label",
  [POLICY_STATUS.FAILED]: "Placeholder: failed label",
  [POLICY_STATUS.UNAVAILABLE]: "Placeholder: unavailable label",
};
const PLACEHOLDER_RETRY_LABEL = "Placeholder: retry label";
const PLACEHOLDER_MACHINE_DETAIL = "Placeholder: machine detail";
const PLACEHOLDER_UNAVAILABLE_DETAIL = "Placeholder: unavailable detail";
const PLACEHOLDER_ROW_HEADING = "Placeholder: settings row heading";
const PLACEHOLDER_ROW_LEVEL = "Placeholder: selected level";

/**
 * The indicator's props, flattened so the controls panel can drive the
 * failed-only retry props without the discriminated union getting in the way.
 * `retryLabel` and `onRetry` only take effect on Failed.
 */
type IndicatorStoryProps = {
  status: PolicyStatus;
  label: string;
  detail?: string;
  retryLabel: string;
  onRetry: () => void;
};

function IndicatorStory({
  status,
  label,
  detail,
  retryLabel,
  onRetry,
}: IndicatorStoryProps) {
  return status === POLICY_STATUS.FAILED ? (
    <PolicyStatusIndicator
      detail={detail}
      label={label}
      onRetry={onRetry}
      retryLabel={retryLabel}
      status={status}
    />
  ) : (
    <PolicyStatusIndicator detail={detail} label={label} status={status} />
  );
}

const meta = {
  title: "Composites/Shared/Data Controls/Policy Status Indicator",
  tags: ["experimental"],
  component: IndicatorStory,
  parameters: { layout: "padded" },
  args: {
    status: POLICY_STATUS.ACTIVE,
    label: PLACEHOLDER_LABEL[POLICY_STATUS.ACTIVE],
    retryLabel: PLACEHOLDER_RETRY_LABEL,
    onRetry: fn(),
  },
  argTypes: {
    status: {
      control: "select",
      options: Object.values(POLICY_STATUS),
      description: "Which of the four policy states to show.",
    },
    label: {
      control: "text",
      description:
        "The state's visible text and accessible name. Supplied by the host.",
    },
    detail: {
      control: "text",
      description:
        "Optional supporting line, e.g. which machine it applies to.",
    },
    retryLabel: {
      control: "text",
      description: "Failed only: the retry control's text.",
    },
    onRetry: {
      control: false,
      description: "Failed only: the retry handler (see the Actions panel).",
    },
  },
} satisfies Meta<typeof IndicatorStory>;

export default meta;

type Story = StoryObj<typeof meta>;

const DARK = { globals: { theme: "dark" } } as const;

/** Active: the chosen policy is the one applied. */
export const Default: Story = {};

/**
 * Unavailable: the policy cannot be read or applied here, e.g. golden mode,
 * or a web surface with no paired desktop.
 */
export const Unavailable: Story = {
  args: {
    status: POLICY_STATUS.UNAVAILABLE,
    label: PLACEHOLDER_LABEL[POLICY_STATUS.UNAVAILABLE],
    detail: PLACEHOLDER_UNAVAILABLE_DETAIL,
  },
};

export const UnavailableDark: Story = { ...Unavailable, ...DARK };

/** Pending: a change was chosen and has not applied yet. The dot pulses. */
export const Pending: Story = {
  args: {
    status: POLICY_STATUS.PENDING,
    label: PLACEHOLDER_LABEL[POLICY_STATUS.PENDING],
  },
};

/** Failed: applying the change failed. Retry re-sends the same change. */
export const Failed: Story = {
  args: {
    status: POLICY_STATUS.FAILED,
    label: PLACEHOLDER_LABEL[POLICY_STATUS.FAILED],
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: PLACEHOLDER_RETRY_LABEL })
    );
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

/** The supporting line naming which machine the policy applies to. */
export const WithDetail: Story = {
  args: { detail: PLACEHOLDER_MACHINE_DETAIL },
};

/**
 * In context: the indicator beside the policy it describes, the way a
 * settings row would carry it. The heading and level are placeholders too.
 */
export const InSettingsRow: Story = {
  args: { detail: PLACEHOLDER_MACHINE_DETAIL },
  render: (args) => (
    <div className="flex max-w-xl items-start justify-between gap-4 rounded-lg border p-4">
      <div className="space-y-1">
        <p className="font-medium text-sm">{PLACEHOLDER_ROW_HEADING}</p>
        <p className="text-muted-foreground text-sm">{PLACEHOLDER_ROW_LEVEL}</p>
      </div>
      <IndicatorStory {...args} />
    </div>
  ),
};

export const DefaultDark: Story = { ...Default, ...DARK };

export const PendingDark: Story = { ...Pending, ...DARK };

export const FailedDark: Story = { ...Failed, ...DARK, play: undefined };
