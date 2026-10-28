import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import {
  DELETION_SCOPE_ITEM_KIND,
  type DeletionEffects,
  type DeletionScopeItem,
} from "./deletion-scope-review";

/**
 * ISS-12537 (PRD-808): the deletion scope review, shown where it ships: inside
 * the shared `DeleteConfirmationDialog` through its `scopeReview` prop.
 *
 * Every string below is a neutral placeholder, one per copy slot, so a
 * designer can see which slot is which. None of it is product copy and none
 * of it says what a deletion does or when. The proposed wording, including
 * the four effect statements (subject to technical verification, PRD-796),
 * lives on the ticket for owner review, in ISS-12537 thread
 * th_PHguDGnk2nrZcbgq8m68y. The dialog takes all of it as props.
 *
 * Placeholders here are allowed by operator ruling (Nerys, 2026-10-15),
 * ISS-12537 thread th_qU6J96Cqnz_SwM0T3SVe_, until the owner supplies the
 * wording.
 */
const PLACEHOLDER_ITEMS: DeletionScopeItem[] = [
  {
    id: "dir-1",
    kind: DELETION_SCOPE_ITEM_KIND.DIRECTORY,
    label: "Placeholder: directory 1 label",
    detail: "Placeholder: directory 1 detail",
  },
  {
    id: "dir-2",
    kind: DELETION_SCOPE_ITEM_KIND.DIRECTORY,
    label: "Placeholder: directory 2 label",
    detail: "Placeholder: directory 2 detail",
  },
  {
    id: "ses-1",
    kind: DELETION_SCOPE_ITEM_KIND.SESSION,
    label: "Placeholder: session 1 label",
    detail: "Placeholder: session 1 detail",
  },
  {
    id: "ses-2",
    kind: DELETION_SCOPE_ITEM_KIND.SESSION,
    label: "Placeholder: session 2 label",
    detail: "Placeholder: session 2 detail",
  },
];

const PLACEHOLDER_LONG_ITEMS: DeletionScopeItem[] = [
  ...PLACEHOLDER_ITEMS,
  ...Array.from({ length: 10 }, (_, index) => ({
    id: `ses-${index + 3}`,
    kind: DELETION_SCOPE_ITEM_KIND.SESSION,
    label: `Placeholder: session ${index + 3} label`,
    detail: `Placeholder: session ${index + 3} detail`,
  })),
];

const PLACEHOLDER_EFFECTS: DeletionEffects = {
  localCopies: {
    label: "Placeholder: local copies label",
    statement: "Placeholder: effect on local copies",
  },
  serverData: {
    label: "Placeholder: server data label",
    statement: "Placeholder: effect on server data",
  },
  sharedAccess: {
    label: "Placeholder: shared access label",
    statement: "Placeholder: effect on shared access",
  },
  futureReupload: {
    label: "Placeholder: future re-upload label",
    statement: "Placeholder: effect on future re-upload",
  },
};

const PLACEHOLDER_COPY = {
  title: "Placeholder: dialog title",
  itemName: "Placeholder: item name",
  description: "Placeholder: dialog description",
  scopeLabel: "Placeholder: scope heading",
  effectsLabel: "Placeholder: effects heading",
} as const;

type ScopeReviewStoryProps = {
  items: DeletionScopeItem[];
  initialSelectedIds: string[];
  isPending: boolean;
  onConfirm: () => Promise<boolean>;
  onOpenChange: (open: boolean) => void;
};

/**
 * The dialog with its scope held in story state, so unchecking an item narrows
 * the scope the way a host's state would.
 */
function ScopeReviewDialog({
  items,
  initialSelectedIds,
  isPending,
  onConfirm,
  onOpenChange,
}: ScopeReviewStoryProps) {
  const [selectedIds, setSelectedIds] = useState(initialSelectedIds);
  return (
    <DeleteConfirmationDialog
      description={PLACEHOLDER_COPY.description}
      isPending={isPending}
      itemName={PLACEHOLDER_COPY.itemName}
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
      open
      scopeReview={{
        effects: PLACEHOLDER_EFFECTS,
        effectsLabel: PLACEHOLDER_COPY.effectsLabel,
        items,
        onSelectedIdsChange: setSelectedIds,
        scopeLabel: PLACEHOLDER_COPY.scopeLabel,
        selectedIds,
      }}
      title={PLACEHOLDER_COPY.title}
    />
  );
}

/** The item the Narrowed story unchecks, matched by its fixture label. */
const NARROWED_ITEM = PLACEHOLDER_ITEMS[3];

const ALL_IDS = PLACEHOLDER_ITEMS.map((item) => item.id);

const meta = {
  title: "Composites/Shared/Data Controls/Deletion Scope Review",
  tags: ["experimental"],
  component: ScopeReviewDialog,
  parameters: { layout: "fullscreen" },
  args: {
    items: PLACEHOLDER_ITEMS,
    initialSelectedIds: ALL_IDS,
    isPending: false,
    onConfirm: fn(async () => true),
    onOpenChange: fn(),
  },
  argTypes: {
    isPending: {
      control: "boolean",
      description: "A confirmed deletion request is in flight.",
    },
    items: {
      control: false,
      description: "Fixture: the sessions and directories in scope.",
    },
    initialSelectedIds: {
      control: false,
      description: "Fixture: what starts in scope. Narrow it in the canvas.",
    },
    onConfirm: { control: false },
    onOpenChange: { control: false },
  },
} satisfies Meta<typeof ScopeReviewDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

const DARK = { globals: { theme: "dark" } } as const;

/** Two directories and two sessions in scope, all selected. */
export const Default: Story = {};

/** Everything unchecked: Delete is disabled until something is in scope. */
export const Empty: Story = {
  args: { initialSelectedIds: [] },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByRole("button", { name: "Delete" })).toBeDisabled();
  },
};

/** The user narrows the scope by unchecking one session. */
export const Narrowed: Story = {
  play: async ({ canvasElement }) => {
    // The dialog portals into document.body.
    const body = within(canvasElement.ownerDocument.body);
    const session = body.getByRole("checkbox", {
      name: new RegExp(NARROWED_ITEM.label),
    });
    await userEvent.click(session);
    await expect(session).not.toBeChecked();
    await expect(body.getByRole("button", { name: "Delete" })).toBeEnabled();
  },
};

/** A confirmed request in flight: the existing dialog's pending state. */
export const Deleting: Story = { args: { isPending: true } };

/**
 * A long scope scrolls inside the list, and the review body scrolls between
 * the dialog's header and footer, so Delete stays in view at any height.
 */
export const LongList: Story = {
  args: {
    items: PLACEHOLDER_LONG_ITEMS,
    initialSelectedIds: PLACEHOLDER_LONG_ITEMS.map((item) => item.id),
  },
};

export const Dark: Story = { ...DARK };

/** Below `sm` the shared dialog becomes a bottom sheet. */
export const Narrow: Story = {
  globals: { viewport: { value: "390-844" } },
};
