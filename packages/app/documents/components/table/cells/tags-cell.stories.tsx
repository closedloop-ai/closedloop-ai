import { TagColor } from "@repo/api/src/types/tag";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { LabelledStates } from "@repo/app/shared/storybook/story-states";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { makeProject } from "@repo/app/shared/test-fixtures/project";
import type { Meta, StoryObj } from "@storybook/react";
import { TagsCell } from "./tags-cell";

/**
 * The tags cell (ISS-6386). Documents get the interactive `TagPicker` behind
 * the `artifact-tags` flag; every other row kind, and every surface with the
 * flag off, renders the same read-only `TagChips`.
 *
 * Both branches render the canonical `packages/app/tags` chip bound to the
 * canonical `TagColor` vocabulary — a table that wants tags composes this cell
 * rather than growing a second palette (ISS-6385).
 */
const meta = {
  title: "Primitives v1.0/Data Display/Tables/Tags Cell",
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const TAGS = [
  { id: "tag-1", name: "backend", color: TagColor.Blue },
  { id: "tag-2", name: "urgent", color: TagColor.Red },
  { id: "tag-3", name: "needs-design", color: TagColor.Violet },
];

const TAGGED_ROW: DocumentRowItem = {
  kind: "document",
  data: makeArtifact({ tags: TAGS }),
};

const UNTAGGED_ROW: DocumentRowItem = {
  kind: "document",
  data: makeArtifact({ id: "artifact-untagged", tags: [] }),
};

/** At the `maxVisible` cap, so nothing rolls into a `+N` yet. */
const AT_CAP_ROW: DocumentRowItem = {
  kind: "document",
  data: makeArtifact({ id: "artifact-at-cap", tags: TAGS.slice(0, 2) }),
};

const PROJECT_ROW: DocumentRowItem = {
  kind: "project",
  data: makeProject({ name: "Apollo" }),
};

/**
 * The read-only treatment, which is what the cell renders whenever it has no
 * entity it can attach a tag to. `TagChips` caps at two visible chips and rolls
 * the rest into a `+N` — a fixed cap rather than a measured fit, which the
 * extend ticket's overflow work is meant to replace.
 */
export const ReadOnly: Story = {
  render: () => (
    <LabelledStates
      rows={[
        ["At the cap", <TagsCell item={AT_CAP_ROW} key="at-cap" />],
        ["Over the cap", <TagsCell item={TAGGED_ROW} key="many" />],
        ["No tags", <TagsCell item={UNTAGGED_ROW} key="none" />],
        ["Project row", <TagsCell item={PROJECT_ROW} key="project" />],
      ]}
    />
  ),
};

/**
 * The editable treatment, behind the `artifact-tags` flag. The `+` trigger
 * carries its own accessible name because it is an icon-only control, and
 * clicking a chip navigates to that tag's search rather than opening the
 * editor.
 */
export const Editable: Story = {
  parameters: { appCore: { enabledFlags: ["artifact-tags"] } },
  render: () => (
    <LabelledStates
      rows={[
        ["Tagged", <TagsCell item={TAGGED_ROW} key="tagged" />],
        ["Untagged", <TagsCell item={UNTAGGED_ROW} key="untagged" />],
      ]}
    />
  ),
};
