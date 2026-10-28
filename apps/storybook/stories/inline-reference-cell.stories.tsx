import { ReferenceSearchStatus } from "@repo/app/custom-fields/components/custom-field-reference-search";
import {
  InlineReferenceCell,
  type InlineReferenceCellProps,
  type InlineReferenceOption,
} from "@repo/design-system/components/ui/inline-reference-cell";
import { TableReferenceListCell } from "@repo/design-system/components/ui/table-cell-list-primitives";
import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";

const TARGETS: InlineReferenceOption[] = [
  { value: "t-1", label: "ISS-101", description: "Ship the importer" },
  { value: "t-2", label: "ISS-102", description: "Fix the retry budget" },
  { value: "t-3", label: "SES-7", description: "Importer spike" },
];

const RETRY_BUDGET = /Fix the retry budget/;

const SEARCH = {
  label: "Search references",
  placeholder: "Search references…",
};

/**
 * The reference grid editor (PRD-722): one linked record or a set, chosen
 * from a searchable list the host loads. A pick commits the whole set, and a
 * refused write puts the previous targets back.
 *
 * States that do not apply, and why:
 *
 * - **Hover and focus-visible** are CSS only.
 * - **Loading** and **Error** are the host's: it hands its own status in
 *   place of the options (`listStatus`), shown in Host Status.
 * - **Disabled and no permission** are both `readOnly` (Read Only).
 */
const meta = {
  title: "Composites/Shared/Artifact List/Inline Reference Cell",
  component: InlineReferenceCell,
  tags: ["stable", "autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    label: { control: "text" },
    multiple: { control: "boolean" },
    values: { control: "object" },
    readOnly: { control: "boolean" },
    // Fixtures: options, slots and the controlled query are the host's.
    options: { control: false },
    renderValues: { control: false },
    valueLabel: { control: false },
    search: { control: false },
    query: { control: false },
    listStatus: { control: false },
    listFooter: { control: false },
    done: { control: false },
    className: { control: false },
  },
  args: {
    label: "Blocks",
    values: ["t-1"],
    multiple: false,
    options: TARGETS,
    search: SEARCH,
    query: "",
    onQueryChange: fn(),
    renderValues: references,
    valueLabel: handleOf,
    onCommit: fn(),
  },
} satisfies Meta<typeof InlineReferenceCell>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A single reference: choosing a target links it and closes. */
export const Default: Story = {
  render: (args) => <ControlledReferences {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Blocks, currently ISS-101" })
    );
    await userEvent.click(
      await screen.findByRole("option", { name: RETRY_BUDGET })
    );
    await waitFor(() => expect(args.onCommit).toHaveBeenCalledWith(["t-2"]));
  },
};

/** Nothing linked: the trigger is named for the action ("Set Blocks"). */
export const Empty: Story = {
  args: { values: [] },
  render: (args) => <ControlledReferences {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Set Blocks" })
    ).toBeInTheDocument();
  },
};

/** Read-only, which is also how a viewer without write permission sees it. */
export const ReadOnly: Story = {
  args: { readOnly: true },
  render: (args) => <ControlledReferences {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

/** A set: each choice toggles, the list stays open, the footer counts. */
export const Multiple: Story = {
  tags: ["!manifest"],
  args: {
    multiple: true,
    values: ["t-1", "t-3"],
    done: { label: "Done", summary: (count) => `${count} selected` },
  },
  render: (args) => <ControlledReferences {...args} />,
};

/** The host's status in place of the options, while it loads. */
export const HostStatus: Story = {
  tags: ["!manifest"],
  args: {
    listStatus: (
      <div className="px-3 py-8 text-center text-muted-foreground text-sm">
        Loading references…
      </div>
    ),
  },
  render: (args) => <ControlledReferences {...args} />,
};

/**
 * The commit below always rejects, and the cell puts the previous target back
 * rather than leaving the new one on screen looking saved.
 */
export const WriteRejects: Story = {
  tags: ["!manifest"],
  args: {
    onCommit: fn(() => Promise.reject(new Error("the server refused it"))),
  },
  render: (args) => <ControlledReferences {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Blocks, currently ISS-101" })
    );
    await userEvent.click(
      await screen.findByRole("option", { name: RETRY_BUDGET })
    );
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Edit Blocks, currently ISS-101" })
      ).toBeInTheDocument()
    );
  },
};

/** The same cell in the dark theme. */
export const Dark: Story = {
  render: (args) => <ControlledReferences {...args} />,
  globals: { theme: "dark" },
};

function handleOf(value: string): string {
  return TARGETS.find((target) => target.value === value)?.label ?? value;
}

function references(values: readonly string[]) {
  return (
    <TableReferenceListCell
      references={values.map((value) => ({
        id: value,
        label: handleOf(value),
        tooltip:
          TARGETS.find((target) => target.value === value)?.description ??
          value,
      }))}
    />
  );
}

function ControlledReferences({
  values: initialValues,
  onCommit,
  options,
  ...rest
}: InlineReferenceCellProps) {
  const [values, setValues] = useState(initialValues);
  const [query, setQuery] = useState("");
  // The Controls panel is a second author of the set, so the arg outranks
  // what the story has picked.
  useEffect(() => setValues(initialValues), [initialValues]);
  const normalized = query.trim().toLowerCase();
  const matching = options.filter((option) =>
    `${option.label} ${option.description ?? ""}`
      .toLowerCase()
      .includes(normalized)
  );
  return (
    <InlineReferenceCell
      {...rest}
      listStatus={
        matching.length === 0 ? (
          <ReferenceSearchStatus
            error={false}
            isLoading={false}
            onRetry={() => undefined}
            optionCount={0}
            query={query}
          />
        ) : undefined
      }
      onCommit={(next) =>
        // Settle before echoing, as a host does: echoing first would make the
        // pick the confirmed value and leave a refusal nothing to restore.
        Promise.resolve(onCommit(next)).then(() => setValues(next))
      }
      onQueryChange={setQuery}
      options={matching}
      query={query}
      values={values}
    />
  );
}
