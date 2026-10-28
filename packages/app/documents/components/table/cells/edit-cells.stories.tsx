import { Priority } from "@repo/api/src/types/common";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  RowEditContext,
  type RowEditHandlers,
} from "@repo/app/documents/components/table/row-edit-context";
import { LabelledStates } from "@repo/app/shared/storybook/story-states";
import {
  makeArtifact,
  TEST_USER,
} from "@repo/app/shared/test-fixtures/documents";
import type { Meta, StoryObj } from "@storybook/react";
import { type ReactNode, useRef, useState } from "react";
import { expect, screen, userEvent, within } from "storybook/test";
import { AssigneeCell, DueDateCell, PriorityCell } from "./edit-cells";

/**
 * The three inline-edit cells of the document table's shared cell layer
 * (ISS-6386). Each reads its editor from `RowEditContext`, and each has a
 * read-only twin for the surface that supplies no handler.
 *
 * That pairing is the contract worth seeing: a cell whose surface cannot save
 * renders **no control at all**, rather than a button that opens an editor
 * whose commit goes nowhere. Every row below is the same component; only the
 * context differs.
 */
const meta = {
  title: "Composites v1.0/Documents/Edit Cells",
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const ROW: DocumentRowItem = {
  kind: "document",
  data: makeArtifact({ priority: Priority.High }),
};

const UNSET_ROW: DocumentRowItem = {
  kind: "document",
  data: makeArtifact({ id: "artifact-unset", priority: undefined }),
};

const ASSIGNED_ROW: DocumentRowItem = {
  kind: "document",
  data: makeArtifact({ id: "artifact-assigned", assignee: TEST_USER }),
};

const TEAM_MEMBERS = [
  { id: TEST_USER.id, name: "Ada Lovelace" },
  { id: "user-2", name: "Grace Hopper" },
];

const EDITABLE: RowEditHandlers = {
  onUpdateDueDate: () => undefined,
  onUpdateAssignee: () => undefined,
  onUpdatePriority: () => undefined,
  teamMembers: TEAM_MEMBERS,
};

/**
 * Due date. The editable cell opens the shared `DatePickerPopover` — the same
 * calendar every other date editor in the product uses — rather than a native
 * `<input type="date">`, which renders differently in every browser.
 */
export const DueDate: Story = {
  render: () => (
    <LabelledStates
      rows={[
        ["Editable", withContext(<DueDateCell item={ROW} />, EDITABLE)],
        ["Read-only", withContext(<DueDateCell item={ROW} />, {})],
      ]}
    />
  ),
};

/**
 * Assignee. The editor needs both a save handler and a roster to pick from —
 * either one alone leaves the cell read-only, since a picker with no candidates
 * is as much a dead end as one that cannot save.
 */
export const Assignee: Story = {
  render: () => (
    <LabelledStates
      rows={[
        [
          "Editable",
          withContext(<AssigneeCell item={ASSIGNED_ROW} />, EDITABLE),
        ],
        ["Unassigned", withContext(<AssigneeCell item={ROW} />, EDITABLE)],
        [
          "No roster",
          withContext(<AssigneeCell item={ASSIGNED_ROW} />, {
            onUpdateAssignee: () => undefined,
          }),
        ],
        ["Read-only", withContext(<AssigneeCell item={ASSIGNED_ROW} />, {})],
      ]}
    />
  ),
};

/**
 * Priority. On My Issues the redundant default "Medium" text is dropped so a
 * page of default-priority rows reads as quiet icons instead of a column of
 * repeated words — but the trigger keeps an accessible name that says the
 * current priority out loud, so the shortened label costs a screen reader
 * nothing (FEA-3946).
 */
export const PriorityStates: Story = {
  name: "Priority",
  render: () => (
    <LabelledStates
      rows={[
        ["Editable", withContext(<PriorityCell item={ROW} />, EDITABLE)],
        [
          "Default, My Issues",
          withContext(<PriorityCell item={mediumRow()} />, {
            ...EDITABLE,
            surfaceVariant: "my-tasks",
          }),
        ],
        [
          "Default, elsewhere",
          withContext(<PriorityCell item={mediumRow()} />, EDITABLE),
        ],
        ["Unset", withContext(<PriorityCell item={UNSET_ROW} />, EDITABLE)],
        ["Read-only", withContext(<PriorityCell item={ROW} />, {})],
      ]}
    />
  ),
};

/**
 * Priority editing, driven end to end (ISS-9094 AC4). The harness below holds
 * the value the way a real surface does — set it optimistically, revert it if
 * the commit rejects — so these plays exercise the rollback path rather than a
 * spy.
 *
 * The menu renders in a portal, OUTSIDE `canvasElement`, so options are found
 * through `screen` while the trigger is found through the canvas. Reading
 * options off the canvas would silently match nothing.
 */
export const PriorityKeyboardEditing: Story = {
  name: "Priority — keyboard",
  render: () => <PriorityEditHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Priority: High" });

    // Enter opens, arrows move, Enter commits — no pointer anywhere, which is
    // what separates this from the pointer story.
    trigger.focus();
    await expect(trigger).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(
      await screen.findByRole("menuitem", { name: "Urgent" })
    ).toBeInTheDocument();

    // No gate provider mounts here, so the closed order applies: Low, Medium,
    // High, Urgent. Enter-open highlights the first, so one arrow reaches the
    // second. Asserting the COMMITTED value rather than Radix's internal
    // highlight keeps this about the contract, not the library.
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Enter}");

    await expect(
      await canvas.findByRole("button", { name: "Priority: Medium" })
    ).toBeInTheDocument();
  },
};

export const PriorityEscapeCancels: Story = {
  name: "Priority — escape cancels, focus returns",
  render: () => <PriorityEditHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Priority: High" });

    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await expect(
      await screen.findByRole("menuitem", { name: "Urgent" })
    ).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    // Closed, nothing committed, and the trigger has focus back.
    await expect(
      screen.queryByRole("menuitem", { name: "Urgent" })
    ).not.toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Priority: High" })
    ).toBeInTheDocument();
    await expect(trigger).toHaveFocus();
  },
};

export const PriorityPointerEditing: Story = {
  name: "Priority — pointer",
  render: () => <PriorityEditHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(
      canvas.getByRole("button", { name: "Priority: High" })
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "Low" }));

    await expect(
      canvas.getByRole("button", { name: "Priority: Low" })
    ).toBeInTheDocument();
  },
};

export const PriorityOptimisticRollback: Story = {
  name: "Priority — optimistic rollback",
  render: () => <PriorityEditHarness commitFails />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(
      canvas.getByRole("button", { name: "Priority: High" })
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Urgent" })
    );

    // Rolled back to the server value.
    await expect(
      await canvas.findByRole("button", { name: "Priority: High" })
    ).toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: "Priority: Urgent" })
    ).not.toBeInTheDocument();

    // The cell PAINTED the optimistic value before it was restored. Without
    // this the assertions above also pass when the update never applied.
    await expect(
      canvasElement.querySelector("[data-priority-renders]")
    ).toHaveAttribute("data-priority-renders", "HIGH,URGENT,HIGH");
  },
};

/**
 * Drives the cell the way an optimistic surface does: set the new value at once,
 * restore the previous one when the commit rejects.
 *
 * What this proves about PRODUCTION is that `PriorityCell` renders from the
 * value it is handed and latches nothing of its own — the property that makes a
 * surface-level rollback possible at all. The rollback POLICY belongs to the
 * surface; `use-document-metadata` implements the shipped one for the detail
 * panel. `data-priority-renders` records the sequence the cell actually painted,
 * so a rollback is distinguishable from an update that never applied.
 */
function PriorityEditHarness({
  commitFails = false,
}: {
  commitFails?: boolean;
}) {
  const [priority, setPriority] = useState<Priority | null>(Priority.High);
  const renders = useRef<(Priority | null)[]>([]);
  if (renders.current.at(-1) !== priority) {
    renders.current.push(priority);
  }
  const item: DocumentRowItem = {
    kind: "document",
    data: makeArtifact({ id: "artifact-interactive", priority }),
  };
  const handlers: RowEditHandlers = {
    ...EDITABLE,
    onUpdatePriority: (_itemId, next) => {
      const previous = priority;
      setPriority(next);
      if (commitFails) {
        // A later tick, not the same handler: batched into one render the
        // optimistic value never paints, and the story could not tell a
        // rollback from an update that never applied.
        queueMicrotask(() => setPriority(previous));
      }
    },
  };
  return (
    <div
      data-priority-renders={renders.current
        .map((value) => value ?? "NONE")
        .join(",")}
    >
      {withContext(<PriorityCell item={item} />, handlers)}
    </div>
  );
}

function mediumRow(): DocumentRowItem {
  return {
    kind: "document",
    data: makeArtifact({ id: "artifact-medium", priority: Priority.Medium }),
  };
}

function withContext(cell: ReactNode, handlers: RowEditHandlers): ReactNode {
  return (
    <RowEditContext.Provider value={handlers}>{cell}</RowEditContext.Provider>
  );
}
