import {
  DATA_SYNC_LEVELS,
  DataSyncLevel,
} from "@repo/api/src/types/data-sync-level";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { DataSyncPolicySummary } from "./data-sync-policy-summary";

/**
 * ISS-12525 (PRD-806): the active policy summary, with the directory count in
 * scope and the machine and organization it applies to. Settings' Data tab on
 * desktop and the shared policy choice already render it with `level` only;
 * no host passes the new rows yet (the directory count waits on ISS-12688).
 *
 * Every new string below is a neutral placeholder, one per copy slot, named
 * after the slot. None of it is product copy. Placeholders here are allowed by
 * operator ruling (Nerys, 2026-10-15), ISS-12526 thread
 * th_Dc0RuSiAdyCvLQpC_X2G4, until the owner supplies the wording. "Current
 * level", the level names and the unset message are ISS-12523's shipped copy.
 */
const PLACEHOLDER = {
  directoryScopeLabel: "Placeholder: directories in scope label",
  appliesToLabel: "Placeholder: applies to label",
  machineName: "Placeholder: machine name",
  orgName: "Placeholder: organization name",
} as const;

const DIRECTORY_SCOPE = {
  label: PLACEHOLDER.directoryScopeLabel,
  count: 3,
};

const APPLIES_TO_BOTH = {
  label: PLACEHOLDER.appliesToLabel,
  machineName: PLACEHOLDER.machineName,
  orgName: PLACEHOLDER.orgName,
};

const UNSET_MESSAGE = /This device has not saved a sync choice yet/;
/** ISS-12523 shipped copy; Default checks it is shown and Unset that it is not. */
const CURRENT_LEVEL = "Current level";

const meta = {
  title: "Composites/Shared/Data Sync/Data Sync Policy Summary",
  tags: ["experimental"],
  component: DataSyncPolicySummary,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
  args: {
    level: DataSyncLevel.Full,
    directoryScope: DIRECTORY_SCOPE,
    appliesTo: APPLIES_TO_BOTH,
  },
  argTypes: {
    level: {
      control: "select",
      options: [null, ...DATA_SYNC_LEVELS],
      description:
        "The level in force, or null when this device has not saved a choice.",
    },
    directoryScope: {
      control: "object",
      description:
        "Optional: how many directories the policy covers, and the row's label. Supplied by the host.",
    },
    appliesTo: {
      control: "object",
      description:
        "Optional: the machine and/or organization the policy applies to, and the row's label. Supplied by the host.",
    },
  },
} satisfies Meta<typeof DataSyncPolicySummary>;

export default meta;

type Story = StoryObj<typeof meta>;

const DARK = { globals: { theme: "dark" } } as const;

/** The summary with every row: level, directories in scope, machine and organization. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(CURRENT_LEVEL)).toBeVisible();
    await expect(
      canvas.getByText(PLACEHOLDER.directoryScopeLabel).parentElement
    ).toHaveTextContent("3");
    await expect(canvas.getByText(PLACEHOLDER.machineName)).toBeVisible();
    await expect(canvas.getByText(PLACEHOLDER.orgName)).toBeVisible();
  },
};

export const DefaultDark: Story = { ...Default, ...DARK };

/**
 * Unset (A5): no choice saved yet. It stays distinct from an explicit Off and,
 * as in ISS-12523, shows the unset message alone: the scope rows are hidden
 * even though the args pass them, pending an owner call on ISS-12525.
 */
export const Unset: Story = {
  args: { level: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(UNSET_MESSAGE)).toBeVisible();
    await expect(canvas.queryByText(CURRENT_LEVEL)).not.toBeInTheDocument();
    await expect(
      canvas.queryByText(PLACEHOLDER.directoryScopeLabel)
    ).not.toBeInTheDocument();
    await expect(
      canvas.queryByText(PLACEHOLDER.machineName)
    ).not.toBeInTheDocument();
  },
};

export const UnsetDark: Story = { ...Unset, ...DARK };

/** What hosts render today: the level alone, unchanged from ISS-12523. */
export const LevelOnly: Story = {
  args: { directoryScope: undefined, appliesTo: undefined },
};

export const Redacted: Story = { args: { level: DataSyncLevel.Redacted } };
export const MetadataOnly: Story = { args: { level: DataSyncLevel.Metadata } };

/** An explicit Off: a saved choice, not the unset state above. */
export const Off: Story = { args: { level: DataSyncLevel.Off } };

/** No directory in scope yet: the count reads 0 rather than the row dropping. */
export const NoDirectories: Story = {
  args: { directoryScope: { ...DIRECTORY_SCOPE, count: 0 } },
};

export const OneDirectory: Story = {
  args: { directoryScope: { ...DIRECTORY_SCOPE, count: 1 } },
};

export const ManyDirectories: Story = {
  args: { directoryScope: { ...DIRECTORY_SCOPE, count: 248 } },
};

/** A machine with no organization, e.g. a device not tied to a workspace. */
export const MachineOnly: Story = {
  args: {
    appliesTo: {
      label: PLACEHOLDER.appliesToLabel,
      machineName: PLACEHOLDER.machineName,
    },
  },
};

/** An organization-wide scope, with no single machine. */
export const OrganizationOnly: Story = {
  args: {
    appliesTo: {
      label: PLACEHOLDER.appliesToLabel,
      orgName: PLACEHOLDER.orgName,
    },
  },
};
