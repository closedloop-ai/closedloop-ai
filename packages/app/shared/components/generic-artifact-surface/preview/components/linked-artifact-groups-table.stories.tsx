import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { ArtifactTypeIcons } from "./artifact-icons";
import {
  LinkedArtifactGroupsTable,
  type LinkedArtifactTableGroup,
  type LinkedArtifactTableRow,
} from "./artifact-linked-artifacts-table";
import {
  LINKED_ARTIFACT_GROUP_HEADINGS,
  LINKED_ARTIFACT_RELATIONSHIP_LABELS,
  LinkEnd,
} from "./linked-artifact-groups";

const LONG_LIST_LENGTH = 176;

/**
 * The grouped linked-artifacts table on Session and Branch Details (PLN-2175):
 * one titled group per artifact type, no Type column, every row drawn.
 *
 * Controls: none. Each story is one fixed set of groups, shaped as the mapper
 * emits them, so the sandbox cannot assemble a row the mapper never draws.
 */
const meta = {
  title: "Composites/Shared/Artifact Detail/Linked Artifact Groups Table",
  component: LinkedArtifactGroupsTable,
  tags: ["stable"],
  parameters: { controls: { disable: true }, layout: "padded" },
  args: { groups: branchGroups() },
} satisfies Meta<typeof LinkedArtifactGroupsTable>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A branch's links: its documents, then the sessions that worked it. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent)
    ).toEqual([
      LINKED_ARTIFACT_GROUP_HEADINGS[ArtifactType.Document],
      LINKED_ARTIFACT_GROUP_HEADINGS[ArtifactType.Session],
    ]);
  },
};

export const Dark: Story = { globals: { theme: "dark" } };

/** A phone-width column: names truncate, the relationship keeps its column. */
export const Narrow: Story = {
  decorators: [
    (StoryFn) => (
      <div className="max-w-[390px]">
        <StoryFn />
      </div>
    ),
  ],
  globals: { viewport: { value: "mobile1", isRotated: false } },
};

/** The largest real session links 176 documents; every row is drawn. */
export const LongList: Story = {
  args: {
    groups: [
      group(
        ArtifactType.Document,
        Array.from({ length: LONG_LIST_LENGTH }, (_, index) =>
          documentRow(`ISS-${1000 + index}`, `Fixture: issue ${index + 1}`)
        )
      ),
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByRole("link").length).toBe(
      LONG_LIST_LENGTH
    );
  },
};

function group(
  type: ArtifactType,
  rows: readonly LinkedArtifactTableRow[]
): LinkedArtifactTableGroup {
  return { heading: LINKED_ARTIFACT_GROUP_HEADINGS[type], key: type, rows };
}

function documentRow(slug: string, name: string): LinkedArtifactTableRow {
  return {
    href: `#${slug}`,
    icon: ArtifactTypeIcons.Issue,
    key: slug,
    name,
    relationship:
      LINKED_ARTIFACT_RELATIONSHIP_LABELS[LinkType.Produces][LinkEnd.Target],
    slug,
  };
}

function branchGroups(): LinkedArtifactTableGroup[] {
  return [
    group(ArtifactType.Document, [
      documentRow("ISS-0004", "Fixture: Branch details tab"),
      {
        href: "#PRD-0002",
        icon: ArtifactTypeIcons.Document,
        key: "PRD-0002",
        name: "",
        relationship: null,
        slug: "PRD-0002",
      },
    ]),
    group(ArtifactType.Session, [
      {
        href: "#SES-0001",
        icon: ArtifactTypeIcons.Session,
        key: "SES-0001",
        name: "Fixture: Rebuild Storybook after component tests stalled",
        relationship:
          LINKED_ARTIFACT_RELATIONSHIP_LABELS[LinkType.RelatesTo][
            LinkEnd.Target
          ],
        slug: "SES-0001",
      },
    ]),
  ];
}
