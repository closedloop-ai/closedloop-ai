import { INLINE_SCALAR_NUMBER_INVALID_MESSAGE } from "@repo/app/shared/lib/inline-scalar-invalid-message";
import { InlineScalarCell } from "@repo/design-system/components/ui/inline-scalar-cell";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

const meta = {
  title: "Composites v1.0/Data Display/Inline Scalar Cell",
  component: InlineScalarCell,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "centered",
  },
  args: {
    label: "Estimate",
    value: "7",
    onCommit: () => undefined,
  },
} satisfies Meta<typeof InlineScalarCell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => <ControlledCell {...args} />,
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
 * `<input type="date">` — the native control ships the browser's own unstyled,
 * untokenized calendar, differently shaped on every platform and unreachable by
 * the design system.
 *
 * Its cancel semantics differ from the text branch's, and that is the point.
 * The text field needs an interlock because Escape reverts and then blurs out
 * through the commit path; a popover has no draft and no blur-commit, so
 * Escape, an outside click, and a re-focus write nothing by construction.
 * Clicking the day that is already selected is the picker's own single-mode
 * toggle and CLEARS the date — the same thing the documents grid's due-date
 * cell has always done on this popover, preserved rather than suppressed.
 *
 * `value` is an ISO `yyyy-MM-dd` calendar day, parsed and formatted in local
 * time — a UTC parse would render the 17th as the 16th anywhere west of
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
 *   indistinguishable from a deliberate clear — the cell reads `badInput`,
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

function ControlledCell({
  label,
  value: initial,
  alignEnd,
  readOnly,
  type,
  onCommit,
}: Readonly<{
  label: string;
  value: string;
  alignEnd?: boolean;
  readOnly?: boolean;
  type?: "date" | "number" | "text";
  onCommit?: (next: string) => void;
}>) {
  const [value, setValue] = useState(initial);
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
