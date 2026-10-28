import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type {
  DataControlsPolicy,
  DataControlsScopeEditorCopy,
} from "./data-controls-scope-editor";
import {
  DataControlsScopeEditorFixtureHost,
  FIXTURE_SAVE_OUTCOME,
} from "./data-controls-scope-editor-fixtures";
import type {
  AutoExcludedDirectory,
  DirectoryScopeEntry,
  DirectoryScopeListCopy,
} from "./directory-scope-list";
import { POLICY_STATUS, type PolicyStatus } from "./policy-status-indicator";

/**
 * ISS-12527 (PRD-806): the Settings scope editor. It composes the directory
 * scope list (ISS-12520), the sync-level picker and the policy status
 * indicator (ISS-12526), and adds an explicit draft that is saved or
 * discarded. The stories drive it through the shared fixture host, which
 * pretends to write: pending on save, then active or failed.
 *
 * Every string below is a neutral placeholder, one per copy slot, named after
 * the slot. None of it is product copy and none of it makes a product claim.
 * Placeholders here are allowed by operator ruling (Nerys, 2026-10-15),
 * ISS-12526 thread th_Dc0RuSiAdyCvLQpC_X2G4, until the owner supplies the
 * wording. The level cards inside the picker are the shipped picker's own
 * approved copy. Directories are fictional.
 */
const PLACEHOLDER: DataControlsScopeEditorCopy = {
  scopeHeading: "Placeholder: scope heading",
  levelHeading: "Placeholder: level heading",
  levelLabel: "Placeholder: level group label",
  unsavedChanges: "Placeholder: unsaved changes",
  saveLabel: "Placeholder: save",
  discardLabel: "Placeholder: discard",
  leaveTitle: "Placeholder: leave prompt title",
  leaveDescription: "Placeholder: leave prompt description",
  leaveStayLabel: "Placeholder: stay",
  leaveDiscardLabel: "Placeholder: discard and leave",
};

const PLACEHOLDER_SCOPE: DirectoryScopeListCopy = {
  autoExcludedHeading: "Placeholder: auto-excluded heading",
  autoExcludedReason: "Placeholder: auto-excluded reason",
  empty: "Placeholder: empty",
  newlyDiscovered: "Placeholder: new badge",
  noSelection: "Placeholder: no selection",
  treeLabel: "Placeholder: tree label",
  unavailable: "Placeholder: unavailable badge",
  unavailableReason: "Placeholder: unavailable reason",
};

const PLACEHOLDER_STATUS: Record<PolicyStatus, string> = {
  [POLICY_STATUS.ACTIVE]: "Placeholder: active",
  [POLICY_STATUS.PENDING]: "Placeholder: pending",
  [POLICY_STATUS.FAILED]: "Placeholder: failed",
  [POLICY_STATUS.UNAVAILABLE]: "Placeholder: unavailable",
};

const PLACEHOLDER_RETRY = "Placeholder: retry";
const PLACEHOLDER_LEAVE = "Placeholder: go to another settings tab";
const PLACEHOLDER_SECTION = "Placeholder: data settings section heading";

// Fictional directories throughout.
const ENTRIES: readonly DirectoryScopeEntry[] = [
  {
    id: "~/code",
    label: "~/code",
    children: [
      { id: "~/code/orbit-api", label: "orbit-api" },
      { id: "~/code/orbit-web", label: "orbit-web" },
      { id: "~/code/lumen-cli", label: "lumen-cli" },
    ],
  },
  {
    id: "~/client-work",
    label: "~/client-work",
    children: [
      { id: "~/client-work/harbor", label: "harbor" },
      { id: "~/client-work/quill", label: "quill" },
    ],
  },
  { id: "~/sandbox", label: "~/sandbox" },
];

const AUTO_EXCLUDED: readonly AutoExcludedDirectory[] = [
  { id: "~/Desktop", label: "~/Desktop" },
  { id: "~/Documents", label: "~/Documents" },
  { id: "~/Downloads", label: "~/Downloads" },
];

const SAVED: DataControlsPolicy = {
  includedIds: ["~/code"],
  level: DataSyncLevel.Metadata,
};

const DRAFT: DataControlsPolicy = {
  includedIds: ["~/code", "~/sandbox"],
  level: DataSyncLevel.Full,
};

const meta = {
  title: "Composites/Shared/Data Controls/Data Controls Scope Editor",
  tags: ["experimental"],
  component: DataControlsScopeEditorFixtureHost,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
  args: {
    initialSaved: SAVED,
    saveOutcome: FIXTURE_SAVE_OUTCOME.SUCCEED,
    saveDelayMs: 800,
    entries: ENTRIES,
    autoExcluded: AUTO_EXCLUDED,
    levels: [DataSyncLevel.Off, DataSyncLevel.Metadata, DataSyncLevel.Full],
    defaultExpandedIds: ["~/code", "~/client-work"],
    copy: PLACEHOLDER,
    scopeCopy: PLACEHOLDER_SCOPE,
    statusLabels: PLACEHOLDER_STATUS,
    retryLabel: PLACEHOLDER_RETRY,
    leaveLabel: PLACEHOLDER_LEAVE,
    onSave: fn(),
    onDiscard: fn(),
    onLeave: fn(),
    onStay: fn(),
  },
  argTypes: {
    saveOutcome: {
      control: "inline-radio",
      options: Object.values(FIXTURE_SAVE_OUTCOME),
      description:
        "How the fixture's pretend write settles. Hold never settles.",
    },
    saveDelayMs: {
      control: { type: "number", min: 0, step: 100 },
      description: "How long the pretend write stays pending.",
    },
    unavailable: {
      control: "boolean",
      description: "Start with the status unavailable.",
    },
    initialSaved: { control: false },
    initialDraft: { control: false },
    entries: { control: false },
    autoExcluded: { control: false },
    levels: { control: false },
    defaultExpandedIds: { control: false },
    copy: { control: false },
    scopeCopy: { control: false },
    statusLabels: { control: false },
    retryLabel: { control: "text" },
    leaveLabel: { control: "text" },
    onSave: { control: false, description: "See the Actions panel." },
    onDiscard: { control: false, description: "See the Actions panel." },
    onLeave: { control: false, description: "See the Actions panel." },
    onStay: { control: false, description: "See the Actions panel." },
  },
} satisfies Meta<typeof DataControlsScopeEditorFixtureHost>;

export default meta;

type Story = StoryObj<typeof meta>;

const DARK = { globals: { theme: "dark" } } as const;

/**
 * The saved policy, nothing unsaved. Including `~/sandbox` makes a draft:
 * the unsaved line appears and save and discard turn on; discard puts the
 * saved policy back.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const save = canvas.getByRole("button", { name: PLACEHOLDER.saveLabel });
    await expect(save).toBeDisabled();
    const sandbox = canvas.getByRole("treeitem", { name: "~/sandbox" });
    await userEvent.click(sandbox);
    await expect(canvas.getByText(PLACEHOLDER.unsavedChanges)).toBeVisible();
    await expect(save).toBeEnabled();
    await userEvent.click(
      canvas.getByRole("button", { name: PLACEHOLDER.discardLabel })
    );
    await expect(sandbox).toHaveAttribute("aria-checked", "false");
    await expect(save).toBeDisabled();
  },
};

/**
 * No policy to show, e.g. on a host without a local policy. The editor is
 * locked, as while a save is pending: there is no policy to write to.
 */
export const Unavailable: Story = {
  args: { unavailable: true },
};

/** A draft with a directory and a level changed, not yet saved. */
export const UnsavedChanges: Story = {
  args: { initialDraft: DRAFT },
};

/**
 * Saving: the indicator shows pending and the editor is locked until the
 * write settles, then shows active with the draft as the saved policy.
 */
export const Saving: Story = {
  args: { initialDraft: DRAFT, saveDelayMs: 1500 },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: PLACEHOLDER.saveLabel })
    );
    await expect(args.onSave).toHaveBeenCalledTimes(1);
    await expect(
      canvas.getByRole("status", { name: PLACEHOLDER_STATUS.pending })
    ).toBeVisible();
    await waitFor(
      () =>
        expect(
          canvas.getByRole("status", { name: PLACEHOLDER_STATUS.active })
        ).toBeVisible(),
      { timeout: 4000 }
    );
  },
};

/** A save that is still pending: the editor stays locked. */
export const SavePending: Story = {
  args: { initialDraft: DRAFT, saveOutcome: FIXTURE_SAVE_OUTCOME.HOLD },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: PLACEHOLDER.saveLabel })
    );
    await expect(
      canvas.getByRole("status", { name: PLACEHOLDER_STATUS.pending })
    ).toBeVisible();
  },
};

/** A save that failed: the draft is kept and retry writes it again. */
export const SaveFailed: Story = {
  args: {
    initialDraft: DRAFT,
    saveOutcome: FIXTURE_SAVE_OUTCOME.FAIL,
    saveDelayMs: 0,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: PLACEHOLDER.saveLabel })
    );
    await expect(
      await canvas.findByRole("button", { name: PLACEHOLDER_RETRY })
    ).toBeVisible();
  },
};

/**
 * Leaving with unsaved changes asks first: stay keeps the draft, discard and
 * leave drops it. With nothing unsaved, leaving does not ask.
 */
export const LeaveWithUnsavedChanges: Story = {
  args: { initialDraft: DRAFT },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: PLACEHOLDER_LEAVE })
    );
    const body = within(canvasElement.ownerDocument.body);
    await expect(
      await body.findByRole("dialog", { name: PLACEHOLDER.leaveTitle })
    ).toBeVisible();
  },
};

/**
 * In context: inside a Data settings section, under the host's own heading.
 * The section heading is a placeholder too.
 */
export const InSettings: Story = {
  render: (args) => (
    <div className="space-y-4 rounded-lg border p-4">
      <p className="font-semibold text-base">{PLACEHOLDER_SECTION}</p>
      <DataControlsScopeEditorFixtureHost {...args} />
    </div>
  ),
};

export const DefaultDark: Story = { ...Default, ...DARK, play: undefined };

export const UnsavedChangesDark: Story = { ...UnsavedChanges, ...DARK };

export const SaveFailedDark: Story = { ...SaveFailed, ...DARK };
