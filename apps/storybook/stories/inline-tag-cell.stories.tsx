import { TagChip } from "@repo/app/shared/components/tag-chip";
import { TAG_COLOR_PALETTE } from "@repo/app/shared/components/tag-color-picker";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  InlineTagCell,
  type InlineTagCellProps,
  type InlineTagOption,
} from "@repo/design-system/components/ui/inline-tag-cell";
import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";

const TAGS: InlineTagOption[] = [
  { value: "infra", label: "Infra" },
  { value: "ux", label: "UX" },
  { value: "docs", label: "Docs" },
];

const SEARCH: InlineTagCellProps["search"] = {
  label: "Search or create tags",
  placeholder: "Search or create tag…",
  createLabel: (query) => `Create tag “${query}”`,
  emptyMessage: "Type to find or create a tag",
};

/**
 * The open-list grid editor (PRD-722): tags the user picks from what exists or
 * creates by typing a label nobody has used. Each pick or create commits the
 * whole set, and a refused write puts the previous set back.
 *
 * States that do not apply, and why:
 *
 * - **Hover and focus-visible** are CSS only (the trigger's hover fill and the
 *   shared focus ring).
 * - **Loading** has no state of its own: a pick shows at once and the ledger
 *   settles it.
 * - **Disabled and no permission** are both `readOnly` (Read Only).
 */
const meta = {
  title: "Composites/Shared/Artifact List/Inline Tag Cell",
  component: InlineTagCell,
  tags: ["stable", "autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    label: { control: "text" },
    values: { control: "object" },
    readOnly: { control: "boolean" },
    // Fixtures: the options and render slots carry `ReactNode`s, which the
    // panel cannot author.
    options: { control: false },
    renderValues: { control: false },
    renderSelected: { control: false },
    search: { control: false },
    createdContent: { control: false },
    className: { control: false },
  },
  args: {
    label: "tags",
    values: ["infra", "ux"],
    options: TAGS,
    search: SEARCH,
    renderValues: chips,
    renderSelected: selectedChip,
    onCommit: fn(),
  },
} satisfies Meta<typeof InlineTagCell>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Picking a tag in the list toggles it into the set. */
export const Default: Story = {
  render: (args) => <ControlledTags {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit tags, currently Infra, UX" })
    );
    // The applied chips render above the search box with remove buttons;
    // opening still lands on the search box.
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Search or create tags" })
      ).toHaveFocus()
    );
    await userEvent.click(await screen.findByRole("option", { name: "Docs" }));
    await waitFor(() =>
      expect(args.onCommit).toHaveBeenCalledWith(["infra", "ux", "docs"])
    );
  },
};

/** No tags: the trigger is named for the action ("Set tags"). */
export const Empty: Story = {
  args: { values: [] },
  render: (args) => <ControlledTags {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Set tags" })
    ).toBeInTheDocument();
  },
};

/** Read-only, which is also how a viewer without write permission sees it. */
export const ReadOnly: Story = {
  args: { readOnly: true },
  render: (args) => <ControlledTags {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

/**
 * Typing a label no tag has offers to create it; the new tag is committed
 * with the rest of the set.
 */
export const CreateTag: Story = {
  tags: ["!manifest"],
  render: (args) => <ControlledTags {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit tags, currently Infra, UX" })
    );
    await userEvent.type(
      await screen.findByRole("combobox", { name: SEARCH.label }),
      "Billing"
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Create tag “Billing”" })
    );
    await userEvent.keyboard("{Escape}");
    await expect(
      await canvas.findByRole("button", {
        name: "Edit tags, currently Infra, UX, Billing",
      })
    ).toBeInTheDocument();
  },
};

/**
 * The commit below always rejects, and the cell puts the previous set back
 * rather than leaving the new tag on screen looking saved.
 */
export const WriteRejects: Story = {
  tags: ["!manifest"],
  args: {
    values: ["infra"],
    onCommit: fn(() => Promise.reject(new Error("the server refused it"))),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit tags, currently Infra" })
    );
    await userEvent.click(await screen.findByRole("option", { name: "UX" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Edit tags, currently Infra" })
      ).toBeInTheDocument()
    );
  },
};

/** The same cell in the dark theme. */
export const Dark: Story = {
  render: (args) => <ControlledTags {...args} />,
  globals: { theme: "dark" },
};

function chips(values: readonly string[]) {
  return values.map((value) => (
    <Chip key={value} size="sm" variant="outline">
      {TAGS.find((tag) => tag.value === value)?.label ?? value}
    </Chip>
  ));
}

function selectedChip(value: string, remove: () => void) {
  return (
    <TagChip
      onRemove={remove}
      tag={{
        color: TAG_COLOR_PALETTE[0].name,
        id: value,
        name: TAGS.find((tag) => tag.value === value)?.label ?? value,
      }}
    />
  );
}

function ControlledTags({
  values: initialValues,
  onCommit,
  ...rest
}: InlineTagCellProps) {
  const [values, setValues] = useState(initialValues);
  // The Controls panel is a second author of the set, so the arg outranks
  // what the story has picked.
  useEffect(() => setValues(initialValues), [initialValues]);
  return (
    <InlineTagCell
      {...rest}
      onCommit={(next) =>
        // Settle before echoing, as a host does: echoing first would make the
        // pick the confirmed value and leave a refusal nothing to restore.
        Promise.resolve(onCommit(next)).then(() => setValues(next))
      }
      values={values}
    />
  );
}
