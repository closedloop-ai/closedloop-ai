import type { Tag, TagSummary } from "@repo/api/src/types/tag";
import { TagColor, TagEntityType } from "@repo/api/src/types/tag";
import type { Meta, StoryObj } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { tagKeys } from "../hooks/use-tags";
import { TagPicker } from "./tag-picker";

const orgTags: Tag[] = [
  makeTag("t1", "backend", TagColor.Blue),
  makeTag("t2", "urgent", TagColor.Red),
  makeTag("t3", "design", TagColor.Purple),
  makeTag("t4", "infra", TagColor.Emerald),
];

const appliedTags: TagSummary[] = [
  { id: "t1", name: "backend", color: TagColor.Blue },
];

/**
 * The picker's `useTags` query is satisfied from the seeded story cache, so
 * the open-popover states render without any network access.
 */
const meta: Meta<typeof TagPicker> = {
  title: "Composites/Tags/Tag Picker",
  component: TagPicker,
  tags: ["autodocs"],
  argTypes: {
    entityType: {
      control: { type: "radio" },
      options: Object.values(TagEntityType),
      table: { category: "Data" },
    },
    entityId: { control: "text", table: { category: "Data" } },
    appliedTags: { control: "object", table: { category: "Data" } },
    trigger: { control: false, table: { category: "Content" } },
    showCreate: { control: "boolean", table: { category: "State" } },
    canApply: { control: "boolean", table: { category: "State" } },
    canRemove: { control: "boolean", table: { category: "State" } },
    showAppliedChips: { control: "boolean", table: { category: "State" } },
    onChipClick: {
      control: false,
      table: { category: "Events" },
      description:
        "When supplied the applied chips become buttons instead of static labels.",
    },
  },
  args: {
    showCreate: true,
    canApply: true,
    canRemove: true,
    showAppliedChips: true,
  },
  parameters: { appCore: { queryData: [[tagKeys.list({}), orgTags]] } },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const WithAppliedTags: Story = {
  args: {
    entityType: TagEntityType.Artifact,
    entityId: "doc_1",
    appliedTags,
  },
};

export const Empty: Story = {
  args: {
    entityType: TagEntityType.Artifact,
    entityId: "doc_2",
    appliedTags: [],
  },
};

/** Permission-restricted treatment used by the approved Branches list. */
export const ReadOnly: Story = {
  args: {
    entityType: TagEntityType.Artifact,
    entityId: "branch_read_only",
    appliedTags,
    canApply: false,
    canRemove: false,
    showAppliedChips: true,
    showCreate: false,
    trigger: <button type="button">Inspect tags</button>,
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Inspect tags" })
    );
  },
};

function makeTag(id: string, name: string, color: Tag["color"]): Tag {
  return {
    id,
    organizationId: "org_test",
    name,
    color,
    createdById: "user_test",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}
