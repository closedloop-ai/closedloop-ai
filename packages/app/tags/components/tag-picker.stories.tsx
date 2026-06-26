import type { Tag, TagSummary } from "@repo/api/src/types/tag";
import { TagColor, TagEntityType } from "@repo/api/src/types/tag";
import type { Meta, StoryObj } from "@storybook/react";
import { AppCoreStoryProviders } from "../../shared/storybook/decorators";
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
  title: "App Core/Tags/Tag Picker",
  component: TagPicker,
  decorators: [
    (Story) => (
      <AppCoreStoryProviders queryData={[[tagKeys.list({}), orgTags]]}>
        <Story />
      </AppCoreStoryProviders>
    ),
  ],
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
