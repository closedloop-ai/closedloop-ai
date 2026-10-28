import {
  TableBulkActionBar,
  TableBulkActionButton,
  TableSelectionAnnouncer,
} from "@repo/design-system/components/ui/table-bulk-action-bar";
import type { Meta, StoryObj } from "@storybook/react";
import {
  FolderPlusIcon,
  StarIcon,
  TagIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import { expect, fn, within } from "storybook/test";

const meta = {
  title: "Composites v1.0/Data Display/Tables/Table Bulk Action Bar",
  tags: ["deprecated"],
  component: TableBulkActionBar,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TableBulkActionBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    actionLabel: "3 artifacts selected",
    actions: (
      <>
        <TableBulkActionButton label="Favorite artifacts" onClick={fn()}>
          <StarIcon />
        </TableBulkActionButton>
        <TableBulkActionButton label="Add to project" onClick={fn()}>
          <FolderPlusIcon />
        </TableBulkActionButton>
        <TableBulkActionButton label="Assign owner" onClick={fn()}>
          <UserRoundIcon />
        </TableBulkActionButton>
        <TableBulkActionButton label="Add tag" onClick={fn()}>
          <TagIcon />
        </TableBulkActionButton>
        <TableBulkActionButton label="Clear selection" onClick={fn()}>
          <XIcon />
        </TableBulkActionButton>
      </>
    ),
  },
};

/**
 * The announcement this bar deliberately does NOT carry (ISS-9574).
 *
 * The bar is mounted conditionally by every host, so it is out of the document
 * at the two moments its count matters most — arriving, and vanishing when a
 * filter shrinks the selection under the host's threshold. A live region cannot
 * announce its own disappearance, so the region lives beside the bar and stays
 * mounted, and the bar carries only its `aria-label`.
 */
export const SelectionAnnouncerWithBar: Story = {
  args: {
    actionLabel: "3 artifacts selected",
    actions: (
      <TableBulkActionButton label="Clear selection" onClick={fn()}>
        <XIcon />
      </TableBulkActionButton>
    ),
  },
  render: (args) => (
    <>
      <TableSelectionAnnouncer count={3} noun={ARTIFACT_NOUN} />
      <TableBulkActionBar {...args} />
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "3 artifacts selected"
    );
    // The bar states the same sentence on screen and is deliberately NOT live.
    // That the PAIR holds exactly one live region is pinned on the production
    // surface, in
    // `packages/app/agents/components/sessions/__tests__/sessions-list-surface-v2-selection-announcement.test.tsx`;
    // a document-wide count inside a story play reads the sweep harness's shared
    // root rather than this story's own markup.
    await expect(
      canvas.getByRole("toolbar", { name: "3 artifacts selected" })
    ).not.toHaveAttribute("aria-live");
  },
};

/** The state a clear leaves behind, with no bar left to say anything. */
export const SelectionAnnouncerCleared: Story = {
  args: { actionLabel: "", actions: null },
  render: () => <TableSelectionAnnouncer count={0} noun={ARTIFACT_NOUN} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "No artifacts selected"
    );
  },
};

const ARTIFACT_NOUN = { one: "artifact", other: "artifacts" } as const;
