import {
  PROJECT_ARTIFACT_LANE_POLICY_REASON_LABELS,
  ProjectArtifactLanePolicyReason,
} from "@repo/api/src/types/project-artifact-lane-policy";
import { MOVE_ARTIFACT_CONFLICT } from "@repo/api/src/types/project-artifact-move";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  TableChoiceCell,
  TableCountCell,
  TableDateCell,
  TablePeopleCell,
  TablePersonCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import {
  type TablePriority,
  TablePriorityCell,
} from "@repo/design-system/components/ui/table-cell-semantic-primitives";
import type { Meta, StoryObj } from "@storybook/react";
import {
  CircleDotIcon,
  FileCode2Icon,
  FileTextIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  expect,
  fireEvent,
  fn,
  userEvent,
  waitFor,
  within,
} from "storybook/test";
import {
  ArtifactBoard,
  type ArtifactBoardFeedback,
  type ArtifactBoardProps,
} from "./artifact-board";
import {
  ArtifactBoardDropPosition,
  type ArtifactBoardFieldDefinition,
  type ArtifactBoardItem,
  type ArtifactBoardLane,
  type ArtifactBoardMove,
  type ArtifactBoardMoveTarget,
  ArtifactBoardMutationState,
  type ArtifactBoardMutationState as ArtifactBoardMutationStateValue,
  ArtifactBoardSelectionIntent,
} from "./artifact-board-model";
import {
  CHILD_TITLE,
  FIELD_OPTIONS,
  OVERFLOW_ITEMS,
  OVERFLOW_LANES,
  ROOT_IDS,
  STORY_FIELDS,
  STORY_ITEMS,
  storyLanes,
  VIRTUAL_ITEMS,
  VIRTUAL_LANES,
  VIRTUAL_ROOT_IDS,
} from "./artifact-board-story-data";

type StoryArgs = {
  groupBy: string;
  mutationState: ArtifactBoardMutationStateValue;
  onMove: (move: ArtifactBoardMove) => void;
  onOpen: (item: ArtifactBoardItem) => void;
  secondaryGroupBy: string | null;
  selectedIds: string[];
  visibleFieldIds: string[];
};

const UNIFIED_ARTIFACT_TITLE_PATTERN = /Unified artifact experience/;
const UNIFIED_ARTIFACT_ACTION_PATTERN = /Actions for Unified artifact/;
const SELECTED_ARTIFACT_PATTERN = /selected$/;
const SELECTED_UNIFIED_ARTIFACT_PATTERN =
  /Unified artifact experience, selected$/;
const ARTIFACT_SLUG_PATTERN = /^(ISS|PRD|PLN)-/;
const ISSUE_SLUG_PATTERN = /^ISS-/;

const meta = {
  title: "Composites/Shared/Artifact List/Artifact Board",
  component: ArtifactBoardStory,
  tags: ["stable", "autodocs"],
  parameters: {
    a11y: { test: "error" },
    controls: { expanded: true },
    docs: {
      description: {
        component:
          "Use for field-grouped root artifacts whose descendants travel with their root. Domain adapters own data, copy, navigation, mutation authority and field editors; do not use it as a generic detail drawer or a fixture-shaped status board.",
      },
    },
    layout: "fullscreen",
  },
  argTypes: {
    groupBy: {
      control: "select",
      options: FIELD_OPTIONS,
      table: { category: "Grouping" },
    },
    secondaryGroupBy: {
      control: "select",
      options: [null, ...FIELD_OPTIONS],
      table: { category: "Grouping" },
    },
    visibleFieldIds: {
      control: "multi-select",
      options: FIELD_OPTIONS,
      table: { category: "Options" },
    },
    selectedIds: {
      control: "multi-select",
      options: ROOT_IDS,
      table: { category: "Selection" },
    },
    mutationState: {
      control: "inline-radio",
      options: Object.values(ArtifactBoardMutationState),
      table: { category: "Mutation" },
    },
    onMove: { control: false, table: { category: "Events" } },
    onOpen: { control: false, table: { category: "Events" } },
  },
  args: {
    groupBy: "status",
    mutationState: ArtifactBoardMutationState.Idle,
    onMove: fn(),
    onOpen: fn(),
    secondaryGroupBy: null,
    selectedIds: [],
    visibleFieldIds: ["priority", "owner", "tags", "comments", "updated"],
  },
} satisfies Meta<StoryArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvasElement.querySelectorAll("[data-artifact-board-card]")
    ).toHaveLength(ROOT_IDS.length);
    await expect(canvas.queryByText(CHILD_TITLE)).not.toBeInTheDocument();
    await expect(
      canvasElement.querySelector('[data-artifact-board-field="status"]')
    ).toBeNull();
  },
};

export const EmptyLane: Story = {
  render: (args) => <ArtifactBoardStory {...args} includeEmptyLane />,
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(
        '[data-artifact-board-drop-target="artifact-board-drop:blocked:end:lane"]'
      )
    ).toHaveClass("min-h-34");
  },
};

export const HoverDisclosure: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = canvas.getByRole("group", {
      name: UNIFIED_ARTIFACT_TITLE_PATTERN,
    });
    card.focus();
    await expect(
      canvas.getByRole("button", { name: UNIFIED_ARTIFACT_ACTION_PATTERN })
    ).toBeVisible();
  },
};

export const FocusVisible: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = canvas.getByRole("group", {
      name: UNIFIED_ARTIFACT_TITLE_PATTERN,
    });
    card.focus();
    await expect(
      canvas.getByRole("group", { name: UNIFIED_ARTIFACT_TITLE_PATTERN })
    ).toHaveFocus();
    await expect(
      canvas.getByRole("button", { name: UNIFIED_ARTIFACT_ACTION_PATTERN })
    ).toBeVisible();
    fireEvent.keyDown(
      canvas.getByRole("group", { name: UNIFIED_ARTIFACT_TITLE_PATTERN }),
      { key: "Enter" }
    );
    await expect(
      canvas.getByRole("group", {
        name: SELECTED_UNIFIED_ARTIFACT_PATTERN,
      })
    ).toHaveFocus();
  },
};

export const EditingTitle: Story = {
  render: (args) => <EditingTitleArtifactBoardStory {...args} />,
  play: async ({ canvasElement }) => {
    const title = within(canvasElement).getByRole("textbox", {
      name: "Edit title",
    });
    fireEvent.change(title, { target: { value: "Unified artifact board" } });
    await expect(title).toHaveValue("Unified artifact board");
  },
};

export const GroupedFieldsOmitted: Story = {
  args: {
    groupBy: "status",
    secondaryGroupBy: "owner",
    visibleFieldIds: ["status", "priority", "owner", "tags"],
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector('[data-artifact-board-field="status"]')
    ).toBeNull();
    await expect(
      canvasElement.querySelector('[data-artifact-board-field="owner"]')
    ).toBeNull();
    await expect(
      canvasElement.querySelectorAll('[data-artifact-board-field="priority"]')
        .length
    ).toBeGreaterThan(0);
  },
};

export const MultipleRootsSelected: Story = {
  args: { selectedIds: [ROOT_IDS[0], ROOT_IDS[1]] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getAllByRole("group", { name: SELECTED_ARTIFACT_PATTERN })
    ).toHaveLength(2);
  },
};

export const MultipleRootsDragging: Story = {
  args: { selectedIds: [ROOT_IDS[0], ROOT_IDS[1]] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = canvas.getByRole("group", {
      name: UNIFIED_ARTIFACT_TITLE_PATTERN,
    });
    const bounds = card.getBoundingClientRect();
    fireEvent.mouseDown(card, {
      button: 0,
      clientX: bounds.left + 12,
      clientY: bounds.top + 12,
    });
    fireEvent.mouseMove(card.ownerDocument, {
      clientX: bounds.left + 28,
      clientY: bounds.top + 28,
    });
    const source = canvasElement
      .querySelector('[data-artifact-board-card="artifact-root-1"]')
      ?.closest<HTMLElement>(".touch-pan-y");
    await expect(source).toHaveClass("ring-primary/60");
    const preview = card.ownerDocument.querySelector<HTMLElement>(
      "[data-drag-preview-chip]"
    );
    await expect(preview).toBeInTheDocument();
    await expect(
      preview?.querySelector("[data-drag-preview-title]")
    ).toHaveTextContent(STORY_ITEMS[0].title);
    await expect(preview?.querySelectorAll("button, fieldset")).toHaveLength(0);
    if (source && preview && bounds.height > 0) {
      await expect(preview.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        source.getBoundingClientRect().bottom
      );
    }
    await expect(card.getBoundingClientRect().x).toBe(bounds.x);
    await expect(card.getBoundingClientRect().y).toBe(bounds.y);
    // Release the drag this story started so its sensor and overlay do not
    // outlive the story.
    fireEvent.mouseUp(card.ownerDocument, {
      clientX: bounds.left + 28,
      clientY: bounds.top + 28,
    });
    await waitFor(() =>
      expect(
        card.ownerDocument.querySelector("[data-drag-preview-chip]")
      ).toBeNull()
    );
  },
};

export const DragOverCardEdge: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = canvas.getByRole("group", {
      name: UNIFIED_ARTIFACT_TITLE_PATTERN,
    });
    const target = canvasElement.querySelector<HTMLElement>(
      '[data-artifact-board-drop-target="artifact-board-drop:in_progress:before:artifact-root-2"]'
    );
    if (!target) {
      throw new Error("expected card-edge drop target");
    }
    const cardBounds = card.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    if (cardBounds.width === 0 || targetBounds.width === 0) {
      await expect(target).toHaveAttribute(
        "data-artifact-board-drop-label",
        "before artifact-root-2"
      );
      return;
    }
    fireEvent.mouseDown(card, {
      button: 0,
      clientX: cardBounds.left + 12,
      clientY: cardBounds.top + 12,
    });
    fireEvent.mouseMove(card.ownerDocument, {
      clientX: cardBounds.left + 28,
      clientY: cardBounds.top + 28,
    });
    fireEvent.mouseMove(card.ownerDocument, {
      clientX: targetBounds.left + 2,
      clientY: targetBounds.top + 1,
    });
    await expect(target).toHaveClass("before:bg-primary");
  },
};

export const DropIntoLaneWhitespace: Story = {
  play: async ({ args, canvasElement }) => {
    const source = canvasElement.querySelector<HTMLElement>(
      '[data-artifact-board-card="artifact-root-2"]'
    );
    const target = canvasElement.querySelector<HTMLElement>(
      '[data-artifact-board-drop-target="artifact-board-drop:todo:end:lane"]'
    );
    if (!(source && target)) {
      throw new Error("expected source card and lane-end drop target");
    }
    const sourceBounds = source.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    if (sourceBounds.width === 0 || targetBounds.width === 0) {
      await expect(target).toHaveClass("grow");
      return;
    }
    await expect(targetBounds.height).toBeGreaterThan(32);
    fireEvent.mouseDown(source, {
      button: 0,
      clientX: sourceBounds.left + 12,
      clientY: sourceBounds.top + 12,
    });
    fireEvent.mouseMove(source.ownerDocument, {
      clientX: sourceBounds.left + 28,
      clientY: sourceBounds.top + 28,
    });
    fireEvent.mouseMove(target, {
      clientX: targetBounds.left + 12,
      clientY: targetBounds.bottom - 12,
    });
    fireEvent.mouseUp(target, {
      clientX: targetBounds.left + 12,
      clientY: targetBounds.bottom - 12,
    });
    await expect(args.onMove).toHaveBeenCalledWith({
      rootIds: [ROOT_IDS[1]],
      sourceLaneId: "in_progress",
      target: { laneId: "todo", position: ArtifactBoardDropPosition.End },
    });
  },
};

export const HiddenDescendants: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvasElement.querySelectorAll("[data-artifact-board-card]")
    ).toHaveLength(ROOT_IDS.length);
    await expect(canvas.queryByText(CHILD_TITLE)).not.toBeInTheDocument();
  },
};

export const PartialLane: Story = {
  render: (args) => (
    <ArtifactBoardStory
      {...args}
      lanes={storyLanes(args.groupBy, false).map((lane, index) =>
        index === 0 ? { ...lane, count: lane.rootIds.length + 4 } : lane
      )}
    />
  ),
  play: async ({ canvasElement }) => {
    const firstLane = canvasElement.querySelector("[data-artifact-board-lane]");
    if (!firstLane) {
      throw new Error("expected partial lane");
    }
    const canvas = within(firstLane as HTMLElement);
    await expect(canvas.getByText("5")).toBeVisible();
    await expect(
      canvas.getAllByRole("group", { name: ARTIFACT_SLUG_PATTERN })
    ).toHaveLength(1);
  },
};

export const MoveDisabled: Story = {
  render: (args) => (
    <ArtifactBoardStory
      {...args}
      canMoveItem={() => false}
      renderActions={() => null}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector('[data-artifact-board-drag-disabled="true"]')
    ).not.toBeNull();
    await expect(
      within(canvasElement).queryByRole("button", {
        name: UNIFIED_ARTIFACT_ACTION_PATTERN,
      })
    ).toBeNull();
  },
};

export const MovePending: Story = {
  args: { mutationState: ArtifactBoardMutationState.Pending },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Loading...")).toBeVisible();
  },
};

export const MoveError: Story = {
  args: { mutationState: ArtifactBoardMutationState.Error },
  // Daveth accepted the destructive-token contrast miss; every other axe rule stays active.
  parameters: {
    a11y: { options: { rules: { "color-contrast": { enabled: false } } } },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toHaveTextContent(
      MOVE_ARTIFACT_CONFLICT
    );
  },
};

export const Light: Story = {
  globals: { theme: "light", viewport: { value: "1512-900" } },
};

export const Dark: Story = {
  globals: { theme: "dark", viewport: { value: "1512-900" } },
};

export const Narrow: Story = {
  globals: { viewport: { value: "390-844" } },
  play: async ({ canvasElement }) => {
    const board = canvasElement.querySelector("[data-artifact-board]");
    await expect(board).not.toBeNull();
    await expect(
      canvasElement.querySelectorAll("[data-artifact-board-card]")
    ).toHaveLength(ROOT_IDS.length);
  },
};

export const WideOverflow: Story = {
  globals: { viewport: { value: "1512-900" } },
  render: (args) => (
    <ArtifactBoardStory
      {...args}
      items={OVERFLOW_ITEMS}
      lanes={OVERFLOW_LANES}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelectorAll("[data-artifact-board-lane]")
    ).toHaveLength(8);
    const viewport = canvasElement.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    );
    await expect(viewport).toHaveStyle({ overflowX: "scroll" });
  },
};

export const LargeVirtualized: Story = {
  globals: { viewport: { value: "390-844" } },
  render: (args) => <LargeVirtualizedArtifactBoardStory {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const painted = canvas.getAllByRole("group", {
      name: ISSUE_SLUG_PATTERN,
    });
    await expect(painted.length).toBeLessThan(VIRTUAL_ROOT_IDS.length);
    await expect(
      canvasElement.querySelector("[data-artifact-board-card-window]")
    ).not.toBeNull();
    const pinned = canvas.getByRole("group", {
      name: SELECTED_ARTIFACT_PATTERN,
    });
    await expect(pinned).toHaveAttribute(
      "data-position-in-set",
      String(VIRTUAL_ROOT_IDS.length)
    );
    await expect(pinned).toHaveAttribute(
      "data-set-size",
      String(VIRTUAL_ROOT_IDS.length)
    );
    await expect(
      canvasElement.querySelector(
        '[data-artifact-board-drop-target="artifact-board-drop:todo:end:lane"]'
      )
    ).not.toBeNull();
  },
};

export const LanePolicyDenied: Story = {
  render: (args) => <LanePolicyDeniedArtifactBoardStory {...args} />,
  // Daveth accepted the destructive-token contrast miss; every other axe rule stays active.
  parameters: {
    a11y: { options: { rules: { "color-contrast": { enabled: false } } } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      PROJECT_ARTIFACT_LANE_POLICY_REASON_LABELS[
        ProjectArtifactLanePolicyReason.UnsupportedTransition
      ]
    );
  },
};

type ArtifactBoardStoryProps = StoryArgs & {
  canMoveItem?: (item: ArtifactBoardItem) => boolean;
  includeEmptyLane?: boolean;
  items?: readonly ArtifactBoardItem[];
  lanes?: readonly ArtifactBoardLane[];
  renderActions?: ArtifactBoardProps["renderActions"];
  renderTitle?: (item: ArtifactBoardItem, open: () => void) => ReactNode;
};

function ArtifactBoardStory(props: ArtifactBoardStoryProps) {
  return (
    <StatefulArtifactBoardStory
      key={`${props.groupBy}:${props.secondaryGroupBy}:${props.selectedIds.join(",")}`}
      {...props}
    />
  );
}

function StatefulArtifactBoardStory({
  canMoveItem,
  groupBy,
  includeEmptyLane = false,
  items = STORY_ITEMS,
  lanes: laneOverride,
  mutationState,
  onMove,
  onOpen,
  renderActions = renderStoryActions,
  renderTitle,
  secondaryGroupBy,
  selectedIds: initialSelectedIds,
  visibleFieldIds,
}: ArtifactBoardStoryProps) {
  const [selectedIds, setSelectedIds] = useState(initialSelectedIds);
  const lanes = laneOverride ?? storyLanes(groupBy, includeEmptyLane);
  return (
    <div className="flex min-h-[620px] bg-background py-4">
      <ArtifactBoard
        canMoveItem={canMoveItem}
        feedback={storyFeedback(mutationState)}
        fields={STORY_FIELDS}
        getDropTargetLabel={dropTargetLabel}
        items={items}
        lanes={lanes}
        onMove={onMove}
        onOpen={onOpen}
        onSelectionChange={(itemId, intent) =>
          setSelectedIds((current) =>
            nextStorySelection(current, itemId, intent)
          )
        }
        primaryGroupFieldId={groupBy}
        renderActions={renderActions}
        renderField={renderStoryField}
        renderTitle={renderTitle}
        renderTypeIcon={renderStoryTypeIcon}
        secondaryGroupFieldId={secondaryGroupBy}
        selectedIds={selectedIds}
        visibleFieldIds={visibleFieldIds}
      />
    </div>
  );
}

function EditingTitleArtifactBoardStory(args: StoryArgs) {
  const [title, setTitle] = useState(STORY_ITEMS[0]?.title ?? "");
  return (
    <ArtifactBoardStory
      {...args}
      renderTitle={(item, open) =>
        item.id === ROOT_IDS[0] ? (
          <input
            aria-label="Edit title"
            className="w-full rounded-sm border bg-background px-1 font-semibold"
            onChange={(event) => setTitle(event.target.value)}
            value={title}
          />
        ) : (
          <Button
            className="h-auto min-h-0 w-full justify-start whitespace-normal p-0 text-left font-semibold text-base leading-6 hover:no-underline"
            onClick={open}
            variant="link"
          >
            {item.title}
          </Button>
        )
      }
    />
  );
}

function LargeVirtualizedArtifactBoardStory(args: StoryArgs) {
  return (
    <div className="flex min-h-[620px] bg-background py-4">
      <ArtifactBoard
        feedback={{ state: ArtifactBoardMutationState.Idle }}
        fields={STORY_FIELDS}
        getDropTargetLabel={dropTargetLabel}
        items={VIRTUAL_ITEMS}
        lanes={VIRTUAL_LANES}
        onMove={args.onMove}
        onOpen={args.onOpen}
        onSelectionChange={fn()}
        primaryGroupFieldId={args.groupBy}
        renderActions={renderStoryActions}
        renderField={renderStoryField}
        renderTypeIcon={renderStoryTypeIcon}
        secondaryGroupFieldId={args.secondaryGroupBy}
        selectedIds={[VIRTUAL_ROOT_IDS.at(-1)!]}
        visibleFieldIds={args.visibleFieldIds}
      />
    </div>
  );
}

function LanePolicyDeniedArtifactBoardStory(args: StoryArgs) {
  const [rejected, setRejected] = useState(true);
  return (
    <div className="flex min-h-[620px] bg-background py-4">
      <ArtifactBoard
        canMoveItemToTarget={() => false}
        feedback={
          rejected
            ? {
                content:
                  PROJECT_ARTIFACT_LANE_POLICY_REASON_LABELS[
                    ProjectArtifactLanePolicyReason.UnsupportedTransition
                  ],
                state: ArtifactBoardMutationState.Error,
              }
            : { state: ArtifactBoardMutationState.Idle }
        }
        fields={STORY_FIELDS}
        getDropTargetLabel={dropTargetLabel}
        items={STORY_ITEMS}
        lanes={storyLanes(args.groupBy, false)}
        onMove={args.onMove}
        onMoveRejected={() => setRejected(true)}
        onOpen={args.onOpen}
        onSelectionChange={fn()}
        primaryGroupFieldId={args.groupBy}
        renderActions={renderStoryActions}
        renderField={renderStoryField}
        renderTypeIcon={renderStoryTypeIcon}
        secondaryGroupFieldId={args.secondaryGroupBy}
        selectedIds={[]}
        visibleFieldIds={args.visibleFieldIds}
      />
    </div>
  );
}

function storyFeedback(
  state: ArtifactBoardMutationStateValue
): ArtifactBoardFeedback {
  switch (state) {
    case ArtifactBoardMutationState.Idle:
      return { state };
    case ArtifactBoardMutationState.Pending:
      return { label: "Loading...", state };
    case ArtifactBoardMutationState.Error:
      return { content: MOVE_ARTIFACT_CONFLICT, state };
    default:
      return exhaustiveStoryMutationState(state);
  }
}

function renderStoryActions(
  item: ArtifactBoardItem,
  move: (target: ArtifactBoardMoveTarget) => void
) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Actions for ${item.title}`}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
          type="button"
        >
          <MoreHorizontalIcon className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() =>
            move({
              laneId: "todo",
              position: ArtifactBoardDropPosition.Before,
              referenceRootId: ROOT_IDS[0],
            })
          }
        >
          Move to top
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            move({
              laneId: "done",
              position: ArtifactBoardDropPosition.End,
            })
          }
        >
          Move to bottom
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function renderStoryField(
  item: ArtifactBoardItem,
  field: ArtifactBoardFieldDefinition
) {
  const value = item.fieldValues[field.id];
  switch (field.id) {
    case "owner":
      return <TablePersonCell person={{ name: String(value) }} />;
    case "collaborators":
      return (
        <TablePeopleCell
          people={(Array.isArray(value) ? value : []).map((name) => ({ name }))}
        />
      );
    case "status":
      return <TableChoiceCell label={String(value)} />;
    case "priority":
      return <TablePriorityCell priority={value as TablePriority} />;
    case "comments":
      return <TableCountCell count={Number(value)} icon={MessageSquareIcon} />;
    case "updated":
      return <TableDateCell value={String(value)} />;
    case "tags":
      return <span>{(Array.isArray(value) ? value : []).join(" · ")}</span>;
    default:
      return String(value ?? "");
  }
}

function renderStoryTypeIcon(item: ArtifactBoardItem) {
  if (item.typeLabel === "Issue") {
    return <CircleDotIcon className="size-4" />;
  }
  if (item.typeLabel === "Implementation Plan") {
    return <FileCode2Icon className="size-4" />;
  }
  return <FileTextIcon className="size-4" />;
}

function dropTargetLabel(target: ArtifactBoardMoveTarget) {
  if (target.position === ArtifactBoardDropPosition.End) {
    return `End of ${target.laneId}`;
  }
  return `${target.position} ${target.referenceRootId}`;
}

function nextStorySelection(
  current: readonly string[],
  itemId: string,
  intent: ArtifactBoardSelectionIntent
) {
  if (intent === ArtifactBoardSelectionIntent.Toggle) {
    return current.includes(itemId)
      ? current.filter((id) => id !== itemId)
      : [...current, itemId];
  }
  if (intent === ArtifactBoardSelectionIntent.Range) {
    const anchor = ROOT_IDS.indexOf(current.at(-1) ?? itemId);
    const target = ROOT_IDS.indexOf(itemId);
    const [start, end] = anchor <= target ? [anchor, target] : [target, anchor];
    return ROOT_IDS.slice(start, end + 1);
  }
  return [itemId];
}

function exhaustiveStoryMutationState(state: never): never {
  return state;
}
