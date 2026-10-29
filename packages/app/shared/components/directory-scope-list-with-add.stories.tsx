import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { DirectoryScopeEntry } from "./directory-scope-list";
import {
  type AddDirectoryAdapter,
  AddDirectoryOutcome,
  AddDirectoryStatus,
  DirectoryScopeListWithAdd,
  type DirectoryScopeListWithAddProps,
  type PickedDirectory,
} from "./directory-scope-list-with-add";
import {
  ADD_DIRECTORY_CONTROL_COPY,
  FIXTURE_AUTO_EXCLUDED,
  FIXTURE_EXPANDED_IDS,
  FIXTURE_INCLUDED_IDS,
  FIXTURE_PICKS,
  FIXTURE_SCOPE_ENTRIES,
  UNWRITTEN_SCOPE_LIST_COPY,
} from "./directory-scope-list-with-add-fixtures";

function adapterFor(
  pickDirectory: () => Promise<PickedDirectory | null>
): AddDirectoryAdapter {
  return {
    copy: ADD_DIRECTORY_CONTROL_COPY,
    onAdd: () => undefined,
    onPickError: () => undefined,
    pickDirectory,
  };
}

function resolvesTo(picked: PickedDirectory | null) {
  return adapterFor(() => Promise.resolve(picked));
}

/** Holds entries and the included set in story state, the way a host would. */
function StatefulDirectoryScopeListWithAdd(
  props: DirectoryScopeListWithAddProps
) {
  const [entries, setEntries] = useState<readonly DirectoryScopeEntry[]>(
    props.entries
  );
  const [included, setIncluded] = useState(props.includedIds);
  const add = props.add;
  return (
    <DirectoryScopeListWithAdd
      {...props}
      add={
        add && {
          ...add,
          onAdd: (entry) => {
            setEntries((previous) => [...previous, entry]);
            add.onAdd(entry);
          },
        }
      }
      entries={entries}
      includedIds={included}
      onIncludedIdsChange={setIncluded}
    />
  );
}

function controlRoot(canvasElement: HTMLElement): HTMLElement {
  const root = canvasElement.querySelector<HTMLElement>(
    '[data-slot="directory-scope-add"]'
  );
  if (root === null) {
    throw new Error("add control is not rendered");
  }
  return root;
}

function trigger(canvasElement: HTMLElement): HTMLElement {
  const button = canvasElement.querySelector<HTMLElement>(
    '[data-slot="directory-scope-add-trigger"]'
  );
  if (button === null) {
    throw new Error("add trigger is not rendered");
  }
  return button;
}

/** Clicks Add and waits for the outcome the story's pick resolves to. */
function playsTo(outcome: AddDirectoryStatus): Story["play"] {
  return async ({ canvasElement }) => {
    await userEvent.click(trigger(canvasElement));
    await waitFor(() =>
      expect(controlRoot(canvasElement).dataset.state).toBe(outcome)
    );
  };
}

function playsToRefusal(
  outcome: Exclude<AddDirectoryOutcome, typeof AddDirectoryOutcome.Added>
): Story["play"] {
  return async (context) => {
    await playsTo(outcome)?.(context);
    const alert = within(context.canvasElement).getByRole("alert");
    await expect(alert.dataset.outcome).toBe(outcome);
    await expect(
      alert.querySelector(`[data-slot="directory-scope-add-${outcome}-icon"]`)
    ).not.toBeNull();
  };
}

/**
 * ISS-12521: the directory scope list with a control that adds a directory
 * discovery missed, through the host's native folder picker. A pick resolves to
 * exactly one outcome: added as a new row, or refused as a duplicate, an
 * unreadable directory, or a macOS-protected folder, each with its own alert
 * tone and icon. On web there is no picker and the control is absent.
 *
 * No controls: each story fixes one pick and its play function makes it.
 * `AddDirectoryControlCopy` (this ticket) now carries approved wording;
 * `DirectoryScopeListCopy` (ISS-12520) still has none and renders a glyph.
 * Either way the states are also told apart by `data-state`, `data-outcome`
 * and the icons, which do not depend on the wording landing.
 */
const meta = {
  title: "Composites/Shared/Data Sync/Directory Scope List With Add",
  tags: ["experimental"],
  component: DirectoryScopeListWithAdd,
  parameters: { layout: "padded", controls: { disable: true } },
  render: (args) => <StatefulDirectoryScopeListWithAdd {...args} />,
  args: {
    add: resolvesTo(FIXTURE_PICKS[AddDirectoryOutcome.Added]),
    autoExcluded: FIXTURE_AUTO_EXCLUDED,
    copy: UNWRITTEN_SCOPE_LIST_COPY,
    defaultExpandedIds: FIXTURE_EXPANDED_IDS,
    entries: FIXTURE_SCOPE_ENTRIES,
    includedIds: FIXTURE_INCLUDED_IDS,
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DirectoryScopeListWithAdd>;

export default meta;

type Story = StoryObj<typeof meta>;

const DARK = { globals: { theme: "dark" } } as const;

/** Desktop, before any pick. */
export const Default: Story = {};

/** Nothing was discovered yet; adding is the only way in. */
export const Empty: Story = {
  args: { autoExcluded: [], entries: [], includedIds: [] },
};

/** The native picker is open; the trigger waits for it. */
export const Picking: Story = {
  args: { add: adapterFor(() => new Promise(() => undefined)) },
  play: async (context) => {
    await playsTo(AddDirectoryStatus.Picking)?.(context);
    await expect(trigger(context.canvasElement)).toBeDisabled();
  },
};

/** AC-001: the picked directory joins the list as a new row, not included. */
export const Added: Story = {
  play: async (context) => {
    await playsTo(AddDirectoryStatus.Added)?.(context);
    const added = FIXTURE_PICKS[AddDirectoryOutcome.Added];
    await expect(
      within(context.canvasElement).getByText(added.label)
    ).toBeInTheDocument();
  },
};

/** AC-002: the picked directory is already listed, here as a nested row. */
export const Duplicate: Story = {
  args: { add: resolvesTo(FIXTURE_PICKS[AddDirectoryOutcome.Duplicate]) },
  play: playsToRefusal(AddDirectoryOutcome.Duplicate),
};

/** AC-002: the picked directory exists but cannot be opened. */
export const Unreadable: Story = {
  args: { add: resolvesTo(FIXTURE_PICKS[AddDirectoryOutcome.Unreadable]) },
  play: playsToRefusal(AddDirectoryOutcome.Unreadable),
};

/**
 * AC-002: the picked folder is macOS-protected. It already sits in the
 * read-only group below, so it is refused rather than added; the alert carries
 * that group's lock.
 */
export const Protected: Story = {
  args: { add: resolvesTo(FIXTURE_PICKS[AddDirectoryOutcome.Protected]) },
  play: playsToRefusal(AddDirectoryOutcome.Protected),
};

/** Cancelling the picker changes nothing. */
export const Cancelled: Story = {
  args: { add: resolvesTo(null) },
  play: async ({ canvasElement }) => {
    await userEvent.click(trigger(canvasElement));
    await expect(controlRoot(canvasElement).dataset.state).toBe(
      AddDirectoryStatus.Idle
    );
    await expect(
      canvasElement.querySelector('[data-slot="directory-scope-add-outcome"]')
    ).toBeNull();
  },
};

/** AC-003: web has no local filesystem, so the host passes no picker. */
export const Web: Story = {
  args: { add: undefined },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector('[data-slot="directory-scope-add"]')
    ).toBeNull();
  },
};

export const DefaultDark: Story = { ...DARK };

export const DuplicateDark: Story = { ...Duplicate, ...DARK };

export const UnreadableDark: Story = { ...Unreadable, ...DARK };

export const ProtectedDark: Story = { ...Protected, ...DARK };
