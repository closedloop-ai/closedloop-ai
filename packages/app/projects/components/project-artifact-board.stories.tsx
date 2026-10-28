import {
  type ArtifactBoardItem,
  type ArtifactBoardMoveTarget,
  ArtifactBoardMutationState,
} from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import {
  TableChoiceCell,
  TableDateCell,
  TablePersonCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import {
  TablePriority,
  TablePriorityCell,
} from "@repo/design-system/components/ui/table-cell-semantic-primitives";
import type { Meta, StoryObj } from "@storybook/react";
import { CircleDotIcon, FileTextIcon } from "lucide-react";
import { expect, fn, within } from "storybook/test";
import {
  ProjectArtifactBoard,
  ProjectArtifactBoardField,
} from "./project-artifact-board";

const CHILD_TITLE = "Implement canonical champion";
const PROJECT_ITEMS: readonly ArtifactBoardItem[] = [
  {
    id: "prd-724",
    rootId: "prd-724",
    parentId: null,
    laneId: "draft",
    slug: "PRD-724",
    title: "Artifact Board and Board Card",
    typeLabel: "PRD",
    fieldValues: {
      owner: "Marisol Ashgrove",
      priority: TablePriority.Medium,
      status: "Draft",
      tags: ["Design system"],
      updated: "Yesterday",
    },
  },
  {
    id: "iss-9361",
    rootId: "prd-724",
    parentId: "prd-724",
    laneId: "in_progress",
    slug: "ISS-9361",
    title: CHILD_TITLE,
    typeLabel: "Issue",
    fieldValues: {
      owner: "Daveth Oakhurst",
      priority: TablePriority.High,
      status: "In Progress",
      tags: ["Design system"],
      updated: "2h ago",
    },
  },
  {
    id: "iss-12654",
    rootId: "iss-12654",
    parentId: null,
    laneId: "in_progress",
    slug: "ISS-12654",
    title: "Wire the shared root-artifact board to project mutations",
    typeLabel: "Issue",
    fieldValues: {
      owner: "Daveth Oakhurst",
      priority: TablePriority.Medium,
      status: "In Progress",
      tags: [],
      updated: "just now",
    },
  },
];

const PROJECT_LANES = [
  { id: "draft", label: "Draft", rootIds: ["prd-724"] },
  { id: "in_progress", label: "In Progress", rootIds: ["iss-12654"] },
  { id: "in_review", label: "In Review", rootIds: [] },
] as const;

// No controls: the composed Project fixture documents the adapter, not the shared board props.
const meta = {
  title: "Composites/Your Teams/Project Detail/Project Artifact Board",
  component: ProjectArtifactBoard,
  tags: ["stable", "autodocs"],
  parameters: {
    a11y: { test: "error" },
    layout: "fullscreen",
    controls: { disable: true },
    docs: {
      description: {
        component:
          "No controls: this composed Project fixture documents the domain adapter rather than the shared board prop surface.",
      },
    },
  },
  args: {
    feedback: { state: ArtifactBoardMutationState.Idle },
    getDropTargetLabel: projectDropTargetLabel,
    groupBy: ProjectArtifactBoardField.Status,
    items: PROJECT_ITEMS,
    lanes: PROJECT_LANES,
    onMove: fn(),
    onOpen: fn(),
    onSelectionChange: fn(),
    renderField: renderProjectField,
    renderTypeIcon: renderProjectTypeIcon,
    selectedIds: [],
    visibleFieldIds: [
      ProjectArtifactBoardField.Priority,
      ProjectArtifactBoardField.Owner,
      ProjectArtifactBoardField.Tags,
      ProjectArtifactBoardField.Updated,
    ],
  },
} satisfies Meta<typeof ProjectArtifactBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvasElement.querySelectorAll("[data-artifact-board-card]").length
    ).toBe(2);
    await expect(
      canvas.getByText("Artifact Board and Board Card")
    ).toBeVisible();
    await expect(canvas.queryByText(CHILD_TITLE)).not.toBeInTheDocument();
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

export const ReadOnlyStatus: Story = {
  args: {
    groupBy: ProjectArtifactBoardField.Priority,
    visibleFieldIds: [
      ProjectArtifactBoardField.Status,
      ProjectArtifactBoardField.Owner,
      ProjectArtifactBoardField.Tags,
      ProjectArtifactBoardField.Updated,
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvasElement.querySelectorAll('[data-artifact-board-field="status"]')
        .length
    ).toBeGreaterThan(0);
    await expect(canvas.queryByRole("combobox")).toBeNull();
  },
};

function renderProjectField(item: ArtifactBoardItem, field: { id: string }) {
  const value = item.fieldValues[field.id];
  switch (field.id) {
    case ProjectArtifactBoardField.Status:
      return <TableChoiceCell label={String(value)} />;
    case ProjectArtifactBoardField.Priority:
      return <TablePriorityCell priority={value as TablePriority} />;
    case ProjectArtifactBoardField.Owner:
      return <TablePersonCell person={{ name: String(value) }} />;
    case ProjectArtifactBoardField.Updated:
      return <TableDateCell value={String(value)} />;
    case ProjectArtifactBoardField.Tags:
      return <span>{(Array.isArray(value) ? value : []).join(" · ")}</span>;
    default:
      return null;
  }
}

function renderProjectTypeIcon(item: ArtifactBoardItem) {
  const Icon = item.typeLabel === "Issue" ? CircleDotIcon : FileTextIcon;
  return <Icon className="size-4" />;
}

function projectDropTargetLabel(target: ArtifactBoardMoveTarget) {
  return `${target.position} ${target.referenceRootId ?? target.laneId}`;
}
