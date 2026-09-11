import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import {
  SessionFrustrationErrorState,
  SessionFrustrationLoadingState,
  SessionFrustrationToggleCard,
} from "./session-frustration-card";

/**
 * A settings card with one switch: whether ClosedLoop scores sessions for
 * frustration signals, like repeated corrections and error spikes, and shows
 * the trend on the Insights dashboard. It is off by default, since the score
 * comes from reading prompt content, so an org has to opt in deliberately.
 * Unlike the general Org Policy Toggle Card, this one is built for this
 * single setting only, with its own separate loading state rather than a
 * built in one. The switch locks while a change is saving and shows an
 * inline alert, without moving on its own, if the save fails.
 */
const meta = {
  title: "Composites/Settings/Session Frustration Card",
  component: SessionFrustrationToggleCard,
  tags: ["autodocs"],
  argTypes: {
    checked: {
      control: "boolean",
      description: "What the server reports, not what was just requested.",
    },
    hasSaveError: { control: "boolean" },
    isSaving: { control: "boolean" },
    onToggle: { control: false, table: { category: "Events" } },
  },
  args: {
    checked: false,
    isSaving: false,
    hasSaveError: false,
    onToggle: fn(),
  },
} satisfies Meta<typeof SessionFrustrationToggleCard>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The org opted in. */
export const Enabled: Story = {
  args: {
    checked: true,
  },
};

/** Off by default — the score is derived from prompt content, so orgs opt in. */
export const Disabled: Story = {};

/** A save is in flight; the switch is locked until it settles. */
export const Saving: Story = {
  args: {
    checked: true,
    isSaving: true,
  },
};

/** The write failed; the switch still shows what the server reports. */
export const SaveError: Story = {
  args: {
    hasSaveError: true,
  },
};

/**
 * The persisted value is still unknown — the first fetch, or a paused/offline
 * fetch that leaves `data` absent. A confidently-OFF switch here would be a lie
 * on an opted-in install.
 */
export const Loading: Story = {
  render: () => <SessionFrustrationLoadingState />,
};

/** The setting could not be read at all. */
export const LoadError: Story = {
  render: () => (
    <SessionFrustrationErrorState message="Request failed with status 500" />
  ),
};
