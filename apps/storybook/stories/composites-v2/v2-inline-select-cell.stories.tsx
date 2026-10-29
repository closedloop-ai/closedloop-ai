// Composites copy of stories/inline-select-cell.stories.tsx (Composites
// v1.0/Data Display/Inline Select Cell), so the current Storybook can change
// without touching v1.0. The Documents, Sessions and generic artifact lists all
// mount it, so it sits under Shared/Artifact List (TAXONOMY.md, "The page
// tree"). Empty, Read Only and Dark are new here (ISS-12642, moved out of v1.0
// by ISS-12914).

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import {
  InlineMultiSelectCell,
  InlineSelectCell,
  type InlineSelectCellProps,
  type InlineSelectOption,
} from "@repo/design-system/components/ui/inline-select-cell";
import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";

const PRIORITIES: InlineSelectOption[] = [
  {
    value: "urgent",
    label: "Urgent",
    chipClassName:
      "border-transparent bg-destructive text-destructive-foreground",
  },
  {
    value: "high",
    label: "High",
    chipClassName: "border-transparent bg-chart-5 text-white",
  },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

const OWNERS: InlineSelectOption[] = [
  {
    value: "ae",
    label: "Ottilie Eastwick",
    adornment: <Initials initials="AE" />,
  },
  {
    value: "pb",
    label: "Pascoe Birchall",
    adornment: <Initials initials="PB" />,
  },
  { value: "sc", label: "Sam Chen", adornment: <Initials initials="SC" /> },
];

const STATUSES: InlineSelectOption[] = [
  { value: "open", label: "Open" },
  { value: "in-progress", label: "In progress" },
  { value: "done", label: "Done" },
];

const LABELS: InlineSelectOption[] = [
  { value: "infra", label: "Infra" },
  { value: "ux", label: "UX" },
  { value: "docs", label: "Docs" },
];

/**
 * The closed-list grid editor: one value (`InlineSelectCell`) or a set
 * (`InlineMultiSelectCell`). A pick IS the write, so there is no draft, and a
 * refused write puts the previous option back.
 *
 * States that do not apply, and why:
 *
 * - **Hover and focus-visible** are CSS only (the trigger's hover fill and the
 *   shared focus ring); the plays drive the trigger the way a keyboard or
 *   pointer user does.
 * - **Loading** has no state of its own: the pick shows at once and the ledger
 *   settles it.
 * - **Retained failure** does not apply: with no draft there is nothing to
 *   keep, so a refusal always restores the confirmed option (Write Rejects).
 * - **Disabled and no permission** are both `readOnly` (Read Only).
 */
const meta = {
  title: "Composites/Shared/Artifact List/Inline Select Cell",
  component: InlineSelectCell,
  tags: ["stable", "autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    label: { control: "text" },
    // The closed list itself, including a value no option carries, the case
    // the cell must not hide. Driving it from the panel is how a reader sees
    // the unknown chip without editing the story.
    value: {
      control: "select",
      options: ["urgent", "high", "medium", "low", "", "archived"],
    },
    // A fixture: the options carry `ReactNode` adornments, which the panel
    // cannot author.
    options: { control: false },
    readOnly: { control: "boolean" },
    className: { control: false },
  },
  args: {
    label: "Priority",
    value: "urgent",
    options: PRIORITIES,
    onCommit: fn(),
  },
} satisfies Meta<typeof InlineSelectCell>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A priority-style single select. Picking an option commits it. */
export const Default: Story = {
  render: (args) => <ControlledSelect {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Priority, currently Urgent" })
    );
    await userEvent.click(
      await screen.findByRole("menuitemradio", { name: "High" })
    );
    await expect(args.onCommit).toHaveBeenCalledWith("high");
    await expect(
      await canvas.findByRole("button", {
        name: "Edit Priority, currently High",
      })
    ).toBeInTheDocument();
  },
};

/** No value: the trigger is named for the action ("Set Priority"). */
export const Empty: Story = {
  args: { value: "" },
  render: (args) => <ControlledSelect {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Set Priority" }));
    await userEvent.click(
      await screen.findByRole("menuitemradio", { name: "Low" })
    );
    await expect(
      await canvas.findByRole("button", {
        name: "Edit Priority, currently Low",
      })
    ).toBeInTheDocument();
  },
};

/**
 * Read-only, which is also how a viewer without write permission sees the
 * cell: the option as it renders at rest, with no menu to open.
 */
export const ReadOnly: Story = {
  args: { readOnly: true, value: "high" },
  render: (args) => <ControlledSelect {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("High")).toBeInTheDocument();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

/**
 * One component, three fields. A priority is a coloured chip, an owner is an
 * avatar beside a name, a plain enum is text, and the difference is entirely
 * the caller's `adornment` / `chipClassName`, which is what keeps the menu out
 * of the domain's business and the domain out of the design system's.
 */
export const Variants: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="grid w-96 grid-cols-[7rem_auto] items-center gap-x-6 gap-y-3 text-muted-foreground text-sm">
      <span>Priority</span>
      <ControlledSelect label="Priority" options={PRIORITIES} value="urgent" />
      <span>Status</span>
      <ControlledSelect label="Status" options={STATUSES} value="in-progress" />
      <span>Owner</span>
      <ControlledSelect label="Owner" options={OWNERS} value="pb" />
      <span>Owners (multi)</span>
      <ControlledMulti label="Owners" options={OWNERS} values={["ae", "sc"]} />
      <span>Empty</span>
      <ControlledSelect label="Owner" options={OWNERS} value="" />
      <span>Read-only</span>
      <ControlledSelect
        label="Priority"
        options={PRIORITIES}
        readOnly
        value="high"
      />
      <span>Labels (multi)</span>
      <ControlledMulti
        label="Labels"
        options={LABELS}
        values={["infra", "ux"]}
      />
      <span>Labels, empty</span>
      <ControlledMulti label="Labels" options={LABELS} values={[]} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // A multi-select stays open across picks, so each one is its own commit.
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Labels, currently Infra, UX" })
    );
    await userEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "Docs" })
    );
    await userEvent.keyboard("{Escape}");
    await expect(
      await canvas.findByRole("button", {
        name: "Edit Labels, currently Infra, UX, Docs",
      })
    ).toBeInTheDocument();
  },
};

/**
 * The two things a closed list gets wrong, side by side.
 *
 * A stored value the option list does not carry (a deleted option, a
 * half-loaded list) is SHOWN as unknown rather than filtered out. Filtering
 * it renders an empty cell over a value the server is still holding, and the
 * next toggle would re-submit it with nothing on screen having said so.
 *
 * And a set wider than its column collapses to `+N` at the measured width
 * rather than spilling into the neighbouring cell: the chips are `shrink-0`,
 * so nothing else stops them.
 */
export const UnknownAndOverflow: Story = {
  tags: ["!manifest"],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", {
        name: "Edit Priority, currently archived (unknown)",
      })
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", {
        name: "Edit Labels, currently Infra, retired (unknown)",
      })
    ).toBeInTheDocument();
  },
  render: () => (
    <div className="grid w-96 grid-cols-[9rem_auto] items-center gap-x-6 gap-y-3 text-muted-foreground text-sm">
      <span>Unknown value</span>
      <ControlledSelect
        label="Priority"
        options={PRIORITIES}
        value="archived"
      />
      <span>Unknown in a set</span>
      <ControlledMulti
        label="Labels"
        options={LABELS}
        values={["infra", "retired"]}
      />
      <span>Narrow column</span>
      <div className="w-24">
        <ControlledMulti
          label="Labels"
          options={LABELS}
          values={["infra", "ux", "docs"]}
        />
      </div>
    </div>
  ),
};

/**
 * The behaviour that is the whole reason not to hand-roll this: the commit
 * below always rejects, and the cell puts the previous option back rather than
 * leaving the new one on screen looking saved. Every hand-rolled copy this
 * component replaced offered an "Undo" toast instead, which rolls back when the
 * USER asks and never when the SERVER refuses.
 */
export const WriteRejects: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="grid w-96 grid-cols-[7rem_auto] items-center gap-x-6 gap-y-3 text-muted-foreground text-sm">
      <span>Single</span>
      <InlineSelectCell
        label="Priority"
        onCommit={() => Promise.reject(new Error("the server refused it"))}
        options={PRIORITIES}
        value="urgent"
      />
      <span>Multi</span>
      <InlineMultiSelectCell
        label="Labels"
        onCommit={() => Promise.reject(new Error("the server refused it"))}
        options={LABELS}
        values={["infra"]}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Priority, currently Urgent" })
    );
    await userEvent.click(
      await screen.findByRole("menuitemradio", { name: "High" })
    );
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Edit Priority, currently Urgent" })
      ).toBeInTheDocument()
    );
  },
};

/** Every variant in the dark theme. */
export const Dark: Story = {
  ...Variants,
  globals: { theme: "dark" },
};

function Initials({ initials }: { initials: string }) {
  return (
    <Avatar className="size-5">
      <AvatarFallback className="text-[9px]">{initials}</AvatarFallback>
    </Avatar>
  );
}

function ControlledSelect({
  value: initialValue,
  onCommit,
  ...rest
}: Omit<InlineSelectCellProps, "onCommit" | "value"> & {
  onCommit?: InlineSelectCellProps["onCommit"];
  value: string;
}) {
  const [value, setValue] = useState(initialValue);
  // The Controls panel is a second author of this value, so the arg outranks
  // what the story has picked. Without this the initializer runs once and the
  // `value` control silently does nothing.
  useEffect(() => setValue(initialValue), [initialValue]);
  return (
    <InlineSelectCell
      {...rest}
      onCommit={(next) => {
        setValue(next);
        onCommit?.(next);
      }}
      value={value}
    />
  );
}

function ControlledMulti({
  values: initialValues,
  ...rest
}: {
  label: string;
  options: readonly InlineSelectOption[];
  values: readonly string[];
}) {
  const [values, setValues] = useState(initialValues);
  return (
    <InlineMultiSelectCell {...rest} onCommit={setValues} values={values} />
  );
}
