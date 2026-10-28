import { TablePriority } from "@repo/design-system/components/ui/table-cell-semantic-primitives";
import type {
  ArtifactBoardFieldDefinition,
  ArtifactBoardItem,
  ArtifactBoardLane,
} from "./artifact-board-model";

export const FIELD_OPTIONS = [
  "status",
  "priority",
  "owner",
  "collaborators",
  "tags",
  "comments",
  "updated",
  "type",
] as const;
export const ROOT_IDS = [
  "artifact-root-1",
  "artifact-root-2",
  "artifact-root-3",
  "artifact-root-4",
];
export const CHILD_TITLE = "Implement canonical champion";

export const STORY_FIELDS = FIELD_OPTIONS.filter(
  (field) => field !== "type"
).map(
  (id): ArtifactBoardFieldDefinition => ({
    id,
    label: id[0]!.toUpperCase() + id.slice(1),
    tier:
      id === "status" || id === "priority" || id === "owner"
        ? "primary"
        : "secondary",
  })
);

export const STORY_ITEMS: readonly ArtifactBoardItem[] = [
  storyItem({
    id: ROOT_IDS[0]!,
    laneId: "todo",
    slug: "ISS-2481",
    status: "Todo",
    title: "Unified artifact experience",
    typeLabel: "Issue",
    owner: "Ottilie Eastwick",
    priority: TablePriority.Urgent,
    tags: ["Foundations", "UX"],
    comments: 14,
    updated: "just now",
  }),
  storyItem({
    id: "artifact-child-1",
    rootId: ROOT_IDS[0],
    parentId: ROOT_IDS[0],
    laneId: "done",
    slug: "DOC-184",
    status: "Approved",
    title: CHILD_TITLE,
    typeLabel: "Document",
    owner: "Pascoe Birchall",
    priority: TablePriority.High,
    tags: ["Principles"],
    comments: 8,
    updated: "12d ago",
  }),
  storyItem({
    id: ROOT_IDS[1]!,
    laneId: "in_progress",
    slug: "PRD-706",
    status: "In Progress",
    title: "Prototype componentization and production rollout",
    typeLabel: "PRD",
    owner: "Pascoe Birchall",
    priority: TablePriority.High,
    tags: ["Design system", "Platform"],
    comments: 9,
    updated: "2h ago",
  }),
  storyItem({
    id: ROOT_IDS[2]!,
    laneId: "in_review",
    slug: "PLN-1936",
    status: "In Review",
    title: "Gridview champion contract",
    typeLabel: "Implementation Plan",
    owner: "Sam Chen",
    priority: TablePriority.Medium,
    tags: ["Governance"],
    comments: 4,
    updated: "Yesterday",
  }),
  storyItem({
    id: ROOT_IDS[3]!,
    laneId: "done",
    slug: "DOC-1838",
    status: "Approved",
    title: "Artifact interaction principles",
    typeLabel: "Document",
    owner: "Jordan Lee",
    priority: TablePriority.Low,
    tags: ["Product", "Research"],
    comments: 2,
    updated: "3d ago",
  }),
];

export const VIRTUAL_ROOT_IDS = Array.from(
  { length: 80 },
  (_, index) => `virtual-root-${index}`
);
export const VIRTUAL_ITEMS: readonly ArtifactBoardItem[] = VIRTUAL_ROOT_IDS.map(
  (id, index) =>
    storyItem({
      comments: index,
      id,
      laneId: "todo",
      owner: "Ottilie Eastwick",
      priority: TablePriority.Medium,
      slug: `ISS-${index + 1}`,
      status: "Todo",
      tags: ["Foundations"],
      title: `Virtualized artifact ${index + 1}`,
      typeLabel: "Issue",
      updated: "just now",
    })
);
export const VIRTUAL_LANES: readonly ArtifactBoardLane[] = [
  {
    count: 120,
    id: "todo",
    label: "Todo",
    rootIds: VIRTUAL_ROOT_IDS,
  },
];

export const OVERFLOW_ITEMS: readonly ArtifactBoardItem[] = Array.from(
  { length: 8 },
  (_, index) =>
    storyItem({
      comments: index + 1,
      id: `overflow-root-${index + 1}`,
      laneId: `lane-${index + 1}`,
      owner: "Ottilie Eastwick",
      priority: TablePriority.Medium,
      slug: `ISS-${720 + index}`,
      status: `Lane ${index + 1}`,
      tags: ["Artifact Board"],
      title: `Overflow artifact ${index + 1}`,
      typeLabel: "Issue",
      updated: "just now",
    })
);
export const OVERFLOW_LANES: readonly ArtifactBoardLane[] = OVERFLOW_ITEMS.map(
  (item) => ({
    id: item.laneId,
    label: String(item.fieldValues.status),
    rootIds: [item.id],
  })
);

function storyItem(input: {
  comments: number;
  id: string;
  laneId: string;
  owner: string;
  parentId?: string | null;
  priority: TablePriority;
  rootId?: string;
  slug: string;
  status: string;
  tags: readonly string[];
  title: string;
  typeLabel: string;
  updated: string;
}): ArtifactBoardItem {
  return {
    id: input.id,
    fieldValues: {
      collaborators: ["Ottilie Eastwick", "Pascoe Birchall"],
      comments: input.comments,
      owner: input.owner,
      priority: input.priority,
      status: input.status,
      tags: input.tags,
      type: input.typeLabel,
      updated: input.updated,
    },
    laneId: input.laneId,
    parentId: input.parentId ?? null,
    rootId: input.rootId ?? input.id,
    slug: input.slug,
    title: input.title,
    typeLabel: input.typeLabel,
  };
}

export function storyLanes(
  groupBy: string,
  includeEmptyLane: boolean
): ArtifactBoardLane[] {
  const roots = STORY_ITEMS.filter((item) => item.id === item.rootId);
  const valueFor = (item: ArtifactBoardItem) => {
    const value = item.fieldValues[groupBy];
    return Array.isArray(value) ? value[0] : String(value ?? "");
  };
  const values = [...new Set(roots.map(valueFor))];
  const lanes = values.map((value) => ({
    id: laneId(value),
    label: value,
    rootIds: roots
      .filter((item) => valueFor(item) === value)
      .map((item) => item.id),
  }));
  if (includeEmptyLane && groupBy === "status") {
    lanes.splice(3, 0, { id: "blocked", label: "Blocked", rootIds: [] });
  }
  return lanes;
}

function laneId(value: string) {
  return value.toLowerCase().replaceAll(" ", "_");
}
