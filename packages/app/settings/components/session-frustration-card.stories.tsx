import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import {
  SessionFrustrationErrorState,
  SessionFrustrationLoadingState,
  SessionFrustrationToggleCard,
} from "./session-frustration-card";

const meta = {
  title: "App Core/Settings/Session Frustration Card",
  component: SessionFrustrationToggleCard,
  args: {
    checked: false,
    isSaving: false,
    hasSaveError: false,
    onToggle: fn(),
  },
} satisfies Meta<typeof SessionFrustrationToggleCard>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Off by default — the score is derived from prompt content, so orgs opt in. */
export const Disabled: Story = {};

/** The org opted in. */
export const Enabled: Story = {
  args: {
    checked: true,
  },
};

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
