import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import {
  ORG_POLICY_SAVE_OUTCOME_ALERTS,
  OrgPolicyFieldState,
  OrgPolicySaveOutcome,
} from "../lib/org-policy-toggle-state";
import {
  OrgPolicyEditableCard,
  OrgPolicyErrorState,
  OrgPolicyLoadingState,
  OrgPolicyUnavailableState,
} from "./org-policy-toggle-card";

const TITLE = "Session transcript sync";

const DESCRIPTION =
  "Control whether desktop sessions sync their transcripts to the cloud.";

const TOGGLE_LABEL = "Sync session transcripts";

const TOGGLE_HELP_TEXT =
  "When on, transcripts captured on the desktop are stored in the cloud so they can be searched and reviewed.";

const idleSaveState = {
  requested: undefined,
  isSaving: false,
  saveAlert: null,
};

/**
 * A settings card with a single on or off switch for an org level privacy
 * policy, built to take its own title and description as props.
 */
const meta = {
  title: "Composites/Settings/Org Policy Toggle Card",
  component: OrgPolicyEditableCard,
  tags: ["autodocs"],
  argTypes: {
    description: { control: "text", table: { category: "Content" } },
    onToggle: { control: false, table: { category: "Events" } },
    saveState: {
      control: "object",
      description:
        "The in-flight write: the requested value, whether it is still settling, and the alert to show. Pair a `saveAlert` with an ORG_POLICY_SAVE_OUTCOME_ALERTS entry.",
      table: { category: "State" },
    },
    state: {
      control: { type: "radio" },
      options: Object.values(OrgPolicyFieldState),
      description:
        "What the server said. `unavailable` is its own answer, not an off.",
      table: { category: "State" },
    },
    title: { control: "text", table: { category: "Content" } },
    toggleHelpText: { control: "text", table: { category: "Content" } },
    toggleId: { control: "text", table: { category: "Content" } },
    toggleLabel: { control: "text", table: { category: "Content" } },
  },
  args: {
    description: DESCRIPTION,
    saveState: idleSaveState,
    state: OrgPolicyFieldState.Enabled,
    title: TITLE,
    toggleHelpText: TOGGLE_HELP_TEXT,
    toggleId: "session-sync-policy-enabled",
    toggleLabel: TOGGLE_LABEL,
    onToggle: fn(),
  },
} satisfies Meta<typeof OrgPolicyEditableCard>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The server reported `true`: the switch is on and live. */
export const Enabled: Story = {};

/** The server reported `false` — a real off, not an unreadable one. */
export const Disabled: Story = {
  args: {
    state: OrgPolicyFieldState.Disabled,
  },
};

/**
 * A save is in flight (or the follow-up read hasn't caught up). The switch is
 * pinned to the requested value and locked so it cannot snap back mid-write.
 */
export const Saving: Story = {
  args: {
    saveState: {
      requested: true,
      isSaving: true,
      saveAlert: null,
    },
    state: OrgPolicyFieldState.Disabled,
  },
};

/** The write blew up. An error alert, and the switch follows the server. */
export const SaveError: Story = {
  args: {
    saveState: {
      requested: true,
      isSaving: false,
      saveAlert:
        ORG_POLICY_SAVE_OUTCOME_ALERTS[OrgPolicySaveOutcome.RequestFailed],
    },
    state: OrgPolicyFieldState.Disabled,
  },
};

/**
 * The ISS-4624 case: the API answered 200 but neither the echo nor the re-read
 * shows the requested value, so the write was an effective no-op. A warning,
 * deliberately a lighter weight than a failed request.
 */
export const NotConfirmed: Story = {
  args: {
    saveState: {
      requested: true,
      isSaving: false,
      saveAlert:
        ORG_POLICY_SAVE_OUTCOME_ALERTS[OrgPolicySaveOutcome.NotConfirmed],
    },
    state: OrgPolicyFieldState.Disabled,
  },
};

/** The org query hasn't produced data yet. */
export const Loading: Story = {
  args: {
    title: TITLE,
  },
  render: (args) => <OrgPolicyLoadingState title={args.title} />,
};

/** The read that backs the card failed outright. */
export const LoadError: Story = {
  render: (args) => (
    <OrgPolicyErrorState
      description={args.description}
      message="Request failed with status 500"
      title={args.title}
      toggleHelpText={args.toggleHelpText}
    />
  ),
};

/**
 * The query settled but the server sent no value for this field (a previous-
 * generation API strips it), so the card says "Status unknown" rather than
 * rendering an unreadable privacy gate as OFF.
 */
export const Unavailable: Story = {
  render: (args) => (
    <OrgPolicyUnavailableState
      description={args.description}
      title={args.title}
      toggleHelpText={args.toggleHelpText}
    />
  ),
};

/**
 * A save that fell into the unavailable state carries its alert across, so the
 * admin still learns the requested write could not be confirmed.
 */
export const UnavailableAfterUnconfirmedSave: Story = {
  render: (args) => (
    <OrgPolicyUnavailableState
      description={args.description}
      saveAlert={
        ORG_POLICY_SAVE_OUTCOME_ALERTS[OrgPolicySaveOutcome.NotConfirmed]
      }
      title={args.title}
      toggleHelpText={args.toggleHelpText}
    />
  ),
};
