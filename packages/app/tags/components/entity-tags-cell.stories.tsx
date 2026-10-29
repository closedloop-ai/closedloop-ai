import type { Tag, TagSummary } from "@repo/api/src/types/tag";
import { TagColor, TagEntityType } from "@repo/api/src/types/tag";
import type { Meta, StoryObj } from "@storybook/react";
import { tagKeys } from "../hooks/use-tags";
import { EntityTagsCell } from "./entity-tags-cell";

const orgTags: Tag[] = [
  makeTag("t1", "backend", TagColor.Blue),
  makeTag("t2", "urgent", TagColor.Red),
  makeTag("t3", "design", TagColor.Purple),
];

const twoTags: TagSummary[] = [
  { id: "t1", name: "backend", color: TagColor.Blue },
  { id: "t2", name: "urgent", color: TagColor.Red },
];

const crowdedTags: TagSummary[] = [
  ...twoTags,
  { id: "t3", name: "design", color: TagColor.Purple },
  { id: "t4", name: "platform-observability", color: TagColor.Emerald },
];

/**
 * ISS-9215: the one tags cell Sessions, Branches and Documents all render. The
 * matrix worth seeing is what the cell OFFERS, which is a product of the
 * reader's grants and whether the row has anything to show — a state a test
 * can name but not judge for crowding at a real column width.
 */
const meta: Meta<typeof EntityTagsCell> = {
  title: "Composites v1.0/Tags/Entity Tags Cell",
  component: EntityTagsCell,
  tags: ["deprecated", "autodocs"],
  parameters: { appCore: { queryData: [[tagKeys.list({}), orgTags]] } },
  args: {
    canApply: true,
    canRemove: true,
    editLabel: "Edit tags for Session One",
    entityId: "artifact_1",
    entityType: TagEntityType.Artifact,
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Editable: Story = {
  args: { tags: twoTags },
};

/** Nothing applied yet: the trigger is the affordance. */
export const EditableEmpty: Story = {
  args: { tags: [] },
};

/** Past the visible cap the overflow indicator holds the rest. */
export const OverflowingChips: Story = {
  args: { tags: crowdedTags },
};

/**
 * Documents' layout: the chips navigate, so they sit BESIDE the trigger rather
 * than inside it — a `<button>` cannot nest in a `<button>`. The cap still
 * belongs to the cell, so this crowds no more than `OverflowingChips` does.
 */
export const NavigableChips: Story = {
  args: { onChipClick: () => undefined, tags: crowdedTags },
};

/** No grant to apply or remove: chips, and no control that cannot act. */
export const ReadOnly: Story = {
  args: { canApply: false, canRemove: false, tags: twoTags },
};

/** Read-only and untagged — the grid's own empty-value glyph. */
export const ReadOnlyEmpty: Story = {
  args: { canApply: false, canRemove: false, tags: [] },
};

function makeTag(id: string, name: string, color: Tag["color"]): Tag {
  return {
    id,
    name,
    color,
    organizationId: "org_test",
    createdById: "user_test",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
}
