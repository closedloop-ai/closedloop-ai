// Composites copy of stories/inline-scalar-cell.stories.tsx (Composites
// v1.0/Data Display/Inline Scalar Cell), so the current Storybook can change
// without touching v1.0. The Documents, Sessions and generic artifact lists all
// mount it, so it sits under Shared/Artifact List (TAXONOMY.md, "The page
// tree"). Empty, Write Rejects, Retained Save Failure, Date Write Rejects,
// Retained Date Save Failure, Read Only, Narrow and Dark are new here
// (ISS-12642, moved out of v1.0 by ISS-12914).

import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import { INLINE_SCALAR_NUMBER_INVALID_MESSAGE } from "@repo/app/shared/lib/inline-scalar-invalid-message";
import { InlineScalarCell } from "@repo/design-system/components/ui/inline-scalar-cell";
import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";

const FIELD_LABEL = "Estimate";
const DATE_LABEL = "Due date";
const COMMITTED_DATE_NAME = "Due date: Aug 17, 2026";
const RETRIED_DATE_NAME = "Due date: Aug 15, 2026";

/**
 * The champion grid editor for a scalar the user sets: text, number, and date
 * (`type="date"`, which renders Inline Date Cell). Enter and blur commit,
 * Escape reverts, and a refused write either restores the confirmed value
 * (the default, compatibility policy) or, with `retainRejectedDraft` and the
 * host's `saveErrorMessage`, keeps the draft marked invalid beside the message.
 *
 * States that do not apply, and why:
 *
 * - **Hover and focus-visible** are CSS only (field chrome on hover, the shared
 *   focus ring); Default and Empty assert the focus a keyboard user lands on.
 * - **Loading** has no state of its own: the cell shows the draft while the
 *   write is in flight, and the ledger settles it.
 * - **Disabled and no permission** are both `readOnly` here: a viewer who
 *   cannot write gets the value with no control (Read Only).
 */
const meta = {
  title: "Composites/Shared/Artifact List/Inline Scalar Cell",
  component: InlineScalarCell,
  tags: ["stable", "autodocs"],
  parameters: {
    layout: "centered",
  },
  argTypes: {
    label: { control: "text" },
    value: { control: "text" },
    // A variant, not a state: each type has its own stories (Default, States,
    // Dates), and switching one in place leaves a value the type cannot read.
    type: { control: false },
    readOnly: { control: "boolean" },
    alignEnd: { control: "boolean" },
    // Handlers and host wiring, not appearance.
    onCommit: { control: false },
    onFailureCleared: { control: false },
    className: { control: false },
    // Only Inline Name Cell mounts the field already open.
    selectOnMount: { control: false },
    // Resolved from the canonical message for `number` by the story harness.
    invalidMessage: { control: false },
    // The failure policy is its own named stories, and its message is the
    // host's shared constant: switching it on without a message, or blanking
    // the message, is a programmer error the cell throws on.
    retainRejectedDraft: { control: false },
    saveErrorMessage: { control: false },
    // The host's formatted text for the committed value (Formatted At Rest).
    restingValue: { control: "text" },
    restingValueMatches: { control: false },
  },
  args: {
    label: FIELD_LABEL,
    value: "7",
    onCommit: fn(),
  },
} satisfies Meta<typeof InlineScalarCell>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A text cell holding a value. Escape reverts without writing; Enter commits
 * exactly once and keeps the field.
 */
export const Default: Story = {
  render: (args) => (
    <div className="w-48">
      <ControlledCell {...args} />
    </div>
  ),
  play: async ({ args, canvasElement }) => {
    const field = within(canvasElement).getByRole("textbox", {
      name: FIELD_LABEL,
    });
    await userEvent.clear(field);
    await userEvent.type(field, "9{Escape}");
    await expect(field).toHaveValue("7");
    await expect(args.onCommit).not.toHaveBeenCalled();
    await userEvent.clear(field);
    await userEvent.type(field, "9{Enter}");
    await expect(args.onCommit).toHaveBeenCalledOnce();
    await expect(args.onCommit).toHaveBeenCalledWith("9");
    await expect(field).toHaveValue("9");
    await expect(field).toHaveFocus();
  },
};

/**
 * No value: a real control named for what it does ("Set Estimate"), which
 * opens the field and hands it focus.
 */
export const Empty: Story = {
  args: { value: "" },
  render: (args) => (
    <div className="w-48">
      <ControlledCell {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: `Set ${FIELD_LABEL}` })
    );
    const field = canvas.getByRole("textbox", { name: FIELD_LABEL });
    await expect(field).toHaveFocus();
    await expect(field).toHaveValue("");
  },
};

/**
 * A number resting on the host's formatted text ("$1,234.50") while the field
 * is unfocused and holds the committed value. Focus shows the bare value to
 * edit; the field is described by the formatted text.
 */
export const FormattedAtRest: Story = {
  args: {
    label: "Budget",
    restingValue: "$1,234.50",
    type: "number",
    value: "1234.5",
  },
  render: (args) => (
    <div className="w-48">
      <ControlledCell {...args} alignEnd />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole("spinbutton", { name: "Budget" });
    await expect(canvas.getByText("$1,234.50")).toBeVisible();
    await expect(field).toHaveAccessibleDescription("$1,234.50");
    await userEvent.click(field);
    await expect(field).toHaveValue(1234.5);
    await expect(canvas.queryByText("$1,234.50")).toBeNull();
  },
};

/**
 * A refused write under the compatibility policy: the field puts the confirmed
 * value back rather than leaving the refused one on screen looking saved, and
 * renders no message of its own.
 */
export const WriteRejects: Story = {
  render: (args) => (
    <div className="w-48">
      <InlineScalarCell
        label={args.label}
        onCommit={() => Promise.reject(new Error("the server refused it"))}
        value={args.value}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole("textbox", { name: FIELD_LABEL });
    await userEvent.clear(field);
    await userEvent.type(field, "9{Enter}");
    await waitFor(() => expect(field).toHaveValue("7"));
    await expect(field).not.toHaveAttribute("aria-invalid");
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/**
 * A refused write under the retained policy: the draft stays, the field is
 * marked invalid, and the host's message is its accessible description.
 */
export const RetainedSaveFailure: Story = {
  args: {
    retainRejectedDraft: true,
    saveErrorMessage: INLINE_EDIT_SAVE_ERROR_MESSAGE,
  },
  render: (args) => (
    <div className="w-48">
      <InlineScalarCell
        {...args}
        onCommit={() => Promise.reject(new Error("the server refused it"))}
      />
    </div>
  ),
  play: playRetainedTextFailure,
};

/**
 * A refused date under the compatibility policy: the trigger returns to the
 * confirmed day.
 */
export const DateWriteRejects: Story = {
  render: () => (
    <div className="w-48">
      <InlineScalarCell
        label={DATE_LABEL}
        onCommit={() => Promise.reject(new Error("the server refused it"))}
        type="date"
        value="2026-08-17"
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await pickDay(canvas.getByRole("button", { name: COMMITTED_DATE_NAME }));
    const trigger = await canvas.findByRole("button", {
      name: COMMITTED_DATE_NAME,
    });
    await expect(trigger).not.toHaveAttribute("aria-invalid");
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/**
 * A refused date under the retained policy: the picked day stays on the
 * trigger, marked invalid and described by the host's message. Picking again
 * retries; Escape restores the confirmed day.
 */
export const RetainedDateSaveFailure: Story = {
  args: {
    retainRejectedDraft: true,
    saveErrorMessage: INLINE_EDIT_SAVE_ERROR_MESSAGE,
  },
  render: () => (
    <div className="w-48">
      <InlineScalarCell
        label={DATE_LABEL}
        onCommit={() => Promise.reject(new Error("the server refused it"))}
        retainRejectedDraft
        saveErrorMessage={INLINE_EDIT_SAVE_ERROR_MESSAGE}
        type="date"
        value="2026-08-17"
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await pickDay(canvas.getByRole("button", { name: COMMITTED_DATE_NAME }));
    const trigger = await canvas.findByRole("button", {
      name: RETRIED_DATE_NAME,
    });
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-invalid", "true")
    );
    await expect(trigger).toHaveAccessibleDescription(
      INLINE_EDIT_SAVE_ERROR_MESSAGE
    );
    await expect(
      canvas.getByRole("alert", { name: INLINE_EDIT_SAVE_ERROR_MESSAGE })
    ).toBeInTheDocument();
  },
};

/**
 * Read-only, which is also how a viewer without write permission sees the
 * cell: the value as text, or the shared em-dash, and no control at all.
 */
export const ReadOnly: Story = {
  args: { readOnly: true },
  render: (args) => (
    <div className="grid w-96 grid-cols-[9rem_auto] items-center gap-x-6 gap-y-3 text-muted-foreground text-sm">
      <span>Value</span>
      <ControlledCell {...args} />
      <span>Empty</span>
      <ControlledCell {...args} value="" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("7")).toBeInTheDocument();
    await expect(canvas.getByTitle(`No ${FIELD_LABEL}`)).toBeInTheDocument();
    await expect(canvas.queryByRole("textbox")).toBeNull();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

/**
 * The state matrix. An empty editable cell is a real control named for what it
 * does ("Set Estimate"), not a decorated dash; an empty read-only cell is the
 * shared em-dash with no control at all.
 */
export const States: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="grid w-96 grid-cols-[9rem_auto] items-center gap-x-6 gap-y-3 text-muted-foreground text-sm">
      <span>Text</span>
      <ControlledCell label="Owner note" value="Needs a second pass" />
      <span>Number</span>
      <ControlledCell alignEnd label="Estimate" type="number" value="7" />
      <span>Number, formatted at rest</span>
      <ControlledCell
        alignEnd
        label="Budget"
        restingValue="$1,234.50"
        type="number"
        value="1234.5"
      />
      <span>Empty, editable</span>
      <ControlledCell label="Estimate" value="" />
      <span>Read-only</span>
      <ControlledCell label="Estimate" readOnly value="7" />
      <span>Read-only, empty</span>
      <ControlledCell label="Estimate" readOnly value="" />
    </div>
  ),
};

/**
 * The `date` variant, which is a `DatePickerPopover` and deliberately NOT an
 * `<input type="date">`: the native control ships the browser's own unstyled,
 * untokenized calendar, differently shaped on every platform and unreachable by
 * the design system.
 *
 * Its cancel semantics differ from the text branch's, and that is the point.
 * The text field needs an interlock because Escape reverts and then blurs out
 * through the commit path; a popover has no draft and no blur-commit, so
 * Escape, an outside click, and a re-focus write nothing by construction.
 * Clicking the day that is already selected is the picker's own single-mode
 * toggle and CLEARS the date, the same thing the documents grid's due-date
 * cell has always done on this popover, preserved rather than suppressed.
 *
 * `value` is an ISO `yyyy-MM-dd` calendar day, parsed and formatted in local
 * time: a UTC parse would render the 17th as the 16th anywhere west of
 * Greenwich, which is how a due date silently moves a day.
 */
export const Dates: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="grid w-96 grid-cols-[9rem_auto] items-center gap-x-6 gap-y-3 text-muted-foreground text-sm">
      <span>Date</span>
      <ControlledCell label="Due date" type="date" value="2026-08-17" />
      <span>Empty, editable</span>
      <ControlledCell label="Due date" type="date" value="" />
      <span>Read-only</span>
      <ControlledCell
        label="Due date"
        readOnly
        type="date"
        value="2026-08-17"
      />
      <span>Read-only, empty</span>
      <ControlledCell label="Due date" readOnly type="date" value="" />
      <span>Write rejects</span>
      <InlineScalarCell
        label="Due date"
        onCommit={() => Promise.reject(new Error("the server refused it"))}
        type="date"
        value="2026-08-17"
      />
    </div>
  ),
};

/**
 * The choreography this component exists to own. Type into the field, then:
 *
 * - **Enter** commits exactly once and keeps focus on the field.
 * - **Tab / click away** commits.
 * - **Escape** reverts without writing anything.
 *
 * The log below records every `onCommit`, so a double or phantom commit is
 * visible rather than inferred.
 */
export const CommitAndCancel: Story = {
  render: () => <CommitLog />,
};

/**
 * The two behaviours the docstring calls load-bearing, and the whole reason not
 * to hand-roll this.
 *
 * - **Rejected write.** The commit below always rejects. The field puts the
 *   previous value back rather than leaving the new one on screen looking
 *   saved.
 * - **Unparseable number.** Type `12e` into the numeric field. The browser
 *   blanks its own `value` for anything it cannot parse, which is
 *   indistinguishable from a deliberate clear; the cell reads `badInput`,
 *   declines to persist the erasure, keeps focus on Enter, and announces the
 *   adapter's `invalidMessage`, resolved by
 *   `INLINE_SCALAR_NUMBER_INVALID_MESSAGE` (ISS-9590) so this story shows the words
 *   production shows.
 */
export const FailureModes: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="grid w-96 grid-cols-[9rem_auto] items-center gap-x-6 gap-y-3 text-muted-foreground text-sm">
      <span>Write rejects</span>
      <InlineScalarCell
        label="Estimate"
        onCommit={() => Promise.reject(new Error("the server refused it"))}
        value="7"
      />
      <span>Try typing 12e</span>
      <ControlledCell alignEnd label="Estimate" type="number" value="7" />
    </div>
  ),
};

/**
 * The retained failure in a narrow column: the message holds to one line
 * under the field and its full sentence stays in `title`.
 */
export const Narrow: Story = {
  args: {
    retainRejectedDraft: true,
    saveErrorMessage: INLINE_EDIT_SAVE_ERROR_MESSAGE,
  },
  render: (args) => (
    <div className="w-28">
      <InlineScalarCell
        {...args}
        onCommit={() => Promise.reject(new Error("the server refused it"))}
      />
    </div>
  ),
  play: async (context) => {
    await playRetainedTextFailure(context);
    await expect(
      within(context.canvasElement).getByRole("alert")
    ).toHaveAttribute("title", INLINE_EDIT_SAVE_ERROR_MESSAGE);
  },
};

/** The retained failure in the dark theme. */
export const Dark: Story = {
  ...RetainedSaveFailure,
  globals: { theme: "dark" },
};

async function playRetainedTextFailure({
  canvasElement,
}: Readonly<{ canvasElement: HTMLElement }>) {
  const canvas = within(canvasElement);
  const field = canvas.getByRole("textbox", { name: FIELD_LABEL });
  await userEvent.clear(field);
  await userEvent.type(field, "9{Enter}");
  await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
  await expect(field).toHaveValue("9");
  await expect(field).toHaveAccessibleDescription(
    INLINE_EDIT_SAVE_ERROR_MESSAGE
  );
  await expect(
    canvas.getByRole("alert", { name: INLINE_EDIT_SAVE_ERROR_MESSAGE })
  ).toBeInTheDocument();
}

/** Opens a date cell's picker and picks the 15th of the month it shows. */
async function pickDay(trigger: HTMLElement) {
  await userEvent.click(trigger);
  const dialog = await screen.findByRole("dialog");
  // A text query, not a gridcell role query: naming every cell of the month
  // grid is slow enough to stall the sweep (inline-date-cell.test.tsx).
  await userEvent.click(within(dialog).getByText("15"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

function ControlledCell({
  label,
  value: initial,
  alignEnd,
  readOnly,
  restingValue,
  type,
  onCommit,
}: Readonly<{
  label: string;
  value: string;
  alignEnd?: boolean;
  readOnly?: boolean;
  /** Fixture formatting for the value the story starts on. */
  restingValue?: string;
  type?: "date" | "number" | "text";
  onCommit?: (next: string) => void;
}>) {
  const [value, setValue] = useState(initial);
  // The Controls panel is a second author of this value, so the arg outranks
  // what the cell has committed (the same rule as Inline Select Cell's story).
  useEffect(() => setValue(initial), [initial]);
  const commit = (next: string) => {
    setValue(next);
    onCommit?.(next);
  };
  // ISS-9590: a numeric cell cannot be given no words, so the story reaches the
  // canonical resolver rather than the constant beneath it.
  if (type === "number") {
    return (
      <InlineScalarCell
        alignEnd={alignEnd}
        invalidMessage={INLINE_SCALAR_NUMBER_INVALID_MESSAGE}
        label={label}
        onCommit={commit}
        readOnly={readOnly}
        restingValue={value === initial ? restingValue : undefined}
        type="number"
        value={value}
      />
    );
  }
  return (
    <InlineScalarCell
      alignEnd={alignEnd}
      label={label}
      onCommit={commit}
      readOnly={readOnly}
      type={type}
      value={value}
    />
  );
}

function CommitLog() {
  // The same value can legitimately be committed twice, so each entry carries
  // its own identity rather than borrowing its position in the list.
  const [commits, setCommits] = useState<{ id: number; value: string }[]>([]);
  return (
    <div className="flex w-96 flex-col gap-4">
      <ControlledCell
        label="Estimate"
        onCommit={(next) =>
          setCommits((log) => [...log, { id: log.length, value: next }])
        }
        value="7"
      />
      <div className="rounded-md border bg-muted/50 p-3 text-sm">
        <p className="font-medium">Commits</p>
        {commits.length > 0 ? (
          <ol className="mt-1 list-decimal pl-5 font-mono text-muted-foreground text-xs">
            {commits.map((commit) => (
              <li key={commit.id}>{commit.value}</li>
            ))}
          </ol>
        ) : (
          <p className="mt-1 text-muted-foreground text-xs">
            Nothing committed yet.
          </p>
        )}
      </div>
    </div>
  );
}
