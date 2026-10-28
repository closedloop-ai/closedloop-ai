import {
  CheckboxTree,
  type CheckboxTreeNode,
} from "@repo/design-system/components/ui/checkbox-tree";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";

// Fixture labels only: the primitive owns no copy, so every string below is a
// fictional directory or a placeholder reason a consumer would supply.
const FLAT_NODES: CheckboxTreeNode[] = [
  { id: "acme-web", label: "~/code/acme-web" },
  { id: "acme-api", label: "~/code/acme-api" },
  { id: "dotfiles", label: "~/dotfiles" },
  { id: "notes", label: "~/notes" },
];

const NESTED_NODES: CheckboxTreeNode[] = [
  {
    id: "code",
    label: "~/code",
    children: [
      {
        id: "acme-web",
        label: "acme-web",
        children: [
          { id: "acme-web-src", label: "src" },
          { id: "acme-web-docs", label: "docs" },
          { id: "acme-web-scripts", label: "scripts" },
        ],
      },
      {
        id: "acme-api",
        label: "acme-api",
        children: [
          { id: "acme-api-src", label: "src" },
          { id: "acme-api-tests", label: "tests" },
        ],
      },
    ],
  },
  { id: "notes", label: "~/notes" },
];

const LOCKED_NODES: CheckboxTreeNode[] = [
  {
    id: "code",
    label: "~/code",
    children: [
      { id: "acme-web", label: "acme-web" },
      {
        id: "acme-vault",
        label: "acme-vault",
        readOnly: true,
        reason: "Read-only reason supplied by the consumer",
        children: [{ id: "acme-vault-keys", label: "keys" }],
      },
    ],
  },
  {
    id: "archive",
    label: "~/archive",
    disabled: true,
    reason: "Disabled reason supplied by the consumer",
  },
  { id: "notes", label: "~/notes" },
];

/**
 * A tree of checkable rows with inherited selection: checking a parent checks
 * its subtree, children added later included, and a parent whose children
 * disagree shows `mixed`. Checking every child one by one draws the parent
 * checked but never reports the parent's id, so a later child is not consented
 * to on its behalf. Follows the
 * WAI-ARIA tree pattern — one tab stop, arrows move and open/close, Space
 * toggles. Labels, reasons and the tree's own name are all props; the
 * primitive renders no copy of its own.
 */
const meta = {
  title: "Primitives/Inputs/Checkbox Tree",
  component: CheckboxTree,
  tags: ["experimental", "autodocs"],
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
  args: {
    "aria-label": "Directories",
    nodes: FLAT_NODES,
  },
  argTypes: {
    "aria-label": { control: "text", table: { category: "Accessibility" } },
    // The tree's shape is fixture data, and each state below is its own
    // story, so the node list, the id sets and the callbacks get no control.
    nodes: { control: false },
    checkedIds: { control: false },
    defaultCheckedIds: { control: false },
    expandedIds: { control: false },
    defaultExpandedIds: { control: false },
    onCheckedChange: { control: false },
    onExpandedChange: { control: false },
    className: { control: false },
  },
} satisfies Meta<typeof CheckboxTree>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Flat: every row is a root, so no row publishes `aria-expanded`. */
export const Default: Story = {
  args: { defaultCheckedIds: ["acme-api"] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = canvas.getByRole("treeitem", { name: "~/notes" });
    await expect(row).not.toHaveAttribute("aria-expanded");
    await userEvent.click(row);
    await expect(row).toHaveAttribute("aria-checked", "true");
  },
};

/** Nested, with the first two levels open. */
export const Nested: Story = {
  args: {
    nodes: NESTED_NODES,
    defaultExpandedIds: ["code", "acme-web"],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const root = canvas.getByRole("treeitem", { name: "~/code" });
    await userEvent.click(root);
    await expect(root).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowRight}");
    await expect(
      canvas.getByRole("treeitem", { name: "acme-web" })
    ).toHaveFocus();
  },
};

/**
 * One checked leaf makes every ancestor `mixed`. Toggling a mixed parent
 * checks the rest of its subtree.
 */
export const MixedSelection: Story = {
  args: {
    nodes: NESTED_NODES,
    defaultCheckedIds: ["acme-web-src"],
    defaultExpandedIds: ["code", "acme-web", "acme-api"],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const parent = canvas.getByRole("treeitem", { name: "acme-web" });
    await expect(parent).toHaveAttribute("aria-checked", "mixed");
    await expect(
      canvas.getByRole("treeitem", { name: "~/code" })
    ).toHaveAttribute("aria-checked", "mixed");
  },
};

/**
 * Disabled and read-only rows keep their check whatever happens around them,
 * and announce the consumer's reason as their description. A lock covers the
 * subtree: `keys` is locked by, and described with, `acme-vault`. The locked
 * value is checked, so `~/code` can never be cleared while it stays checked.
 * A read-only row stays at full strength because its value is real, just set
 * elsewhere.
 */
export const ReadOnly: Story = {
  args: {
    nodes: LOCKED_NODES,
    defaultCheckedIds: ["acme-vault"],
    defaultExpandedIds: ["code", "acme-vault"],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const readOnly = canvas.getByRole("treeitem", { name: "acme-vault" });
    await expect(readOnly).toHaveAccessibleDescription(
      "Read-only reason supplied by the consumer"
    );
    await userEvent.click(readOnly);
    await expect(readOnly).toHaveAttribute("aria-checked", "true");
    await expect(
      canvas.getByRole("treeitem", { name: "~/code" })
    ).toHaveAttribute("aria-checked", "mixed");
    const disabled = canvas.getByRole("treeitem", { name: "~/archive" });
    await expect(disabled).toHaveAttribute("aria-disabled", "true");
  },
};

const LONG_NODES: CheckboxTreeNode[] = [
  {
    id: "monorepo",
    label: "~/code/acme-platform-monorepo/packages",
    children: [
      {
        id: "ui",
        label: "~/code/acme-platform-monorepo/packages/shared-ui-components",
      },
      {
        id: "api",
        label: "~/code/acme-platform-monorepo/packages/shared-api-client",
      },
    ],
  },
];

/**
 * Labels end-truncate in a narrow column, so two paths that differ only in
 * their tail become indistinguishable. This is today's behaviour, shown so a
 * consumer with path labels can decide how to shorten them before passing them in.
 */
export const LongLabels: Story = {
  args: {
    nodes: LONG_NODES,
    defaultExpandedIds: ["monorepo"],
  },
  decorators: [
    (Story) => (
      <div className="w-64">
        <Story />
      </div>
    ),
  ],
};
