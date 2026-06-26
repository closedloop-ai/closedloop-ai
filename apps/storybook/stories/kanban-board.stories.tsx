"use client";

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { AgentCard } from "@repo/app/agents/components/agent-card";
import { SessionCard } from "@repo/app/agents/components/sessions/session-card";
import { sessions } from "@repo/app/agents/lib/session-mock-data";
import type {
  SessionAgent,
  SessionRow,
} from "@repo/app/agents/lib/session-types";
import { Card } from "@repo/design-system/components/ui/card";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  KanbanBoardLayout,
  KanbanCardFrame,
  KanbanColumn,
} from "@repo/design-system/components/ui/layout/kanban-board";
import { cn } from "@repo/design-system/lib/utils";
import type { Meta, StoryObj } from "@storybook/react";
import {
  Bot,
  Boxes,
  FileCode2,
  FileSearch,
  FlaskConical,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";

type BoardColumn = {
  id: string;
  label: string;
};

type ArtifactCardRecord = {
  id: string;
  title: string;
  slug: string;
  artifactType: "PRD" | "Spec" | "Workflow";
  priority: "High" | "Medium" | "Low";
  status: "Draft" | "In Review" | "Ready";
  assignee: string;
  updatedAt: string;
};

type BoardItem =
  | {
      id: string;
      kind: "session";
      columnId: string;
      session: SessionRow;
    }
  | {
      id: string;
      kind: "agent";
      columnId: string;
      agent: SessionAgent;
    }
  | {
      id: string;
      kind: "artifact";
      columnId: string;
      artifact: ArtifactCardRecord;
    };

const columns: BoardColumn[] = [
  { id: "queued", label: "Queued" },
  { id: "active", label: "Active" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

const agents: SessionAgent[] = [
  {
    id: "agent-main",
    sessionId: "sess-1",
    name: "Main Agent",
    type: "main",
    status: "working",
    task: "Compose the shared monitoring dashboard from workflow primitives.",
    currentTool: "Edit",
    model: "gpt-5.5",
    cost: 1.82,
    label: "Dashboard assembly",
    startedAt: "2026-05-29T12:00:00.000Z",
    updatedAt: "2026-05-29T12:08:00.000Z",
  },
  {
    id: "agent-review",
    sessionId: "sess-2",
    name: "Review Worker",
    type: "subagent",
    subagentType: "code:review-worker",
    status: "waiting",
    task: "Validate menu parity between the app shell and the design system.",
    currentTool: "Read",
    model: "claude-sonnet-4.6",
    cost: 0.41,
    label: "Champion audit",
    startedAt: "2026-05-29T11:44:00.000Z",
    updatedAt: "2026-05-29T12:06:00.000Z",
  },
  {
    id: "agent-verify",
    sessionId: "sess-3",
    name: "Verification Agent",
    type: "subagent",
    subagentType: "code:verification-subagent",
    status: "completed",
    task: "Backfill Storybook coverage for layout and document blocks.",
    currentTool: "Test",
    model: "gpt-5.5-mini",
    cost: 0.27,
    label: "Coverage sweep",
    startedAt: "2026-05-29T10:12:00.000Z",
    updatedAt: "2026-05-29T11:32:00.000Z",
  },
];

const artifacts: ArtifactCardRecord[] = [
  {
    id: "artifact-prd",
    title: "Champion Review PRD",
    slug: "prd-423",
    artifactType: "PRD",
    priority: "High",
    status: "In Review",
    assignee: "Design Systems",
    updatedAt: "2m ago",
  },
  {
    id: "artifact-spec",
    title: "Kanban Card Normalization",
    slug: "spec-kanban-cards",
    artifactType: "Spec",
    priority: "Medium",
    status: "Draft",
    assignee: "Frontend",
    updatedAt: "14m ago",
  },
  {
    id: "artifact-workflow",
    title: "Workflow Visualization Adoption",
    slug: "workflow-viz-adoption",
    artifactType: "Workflow",
    priority: "Low",
    status: "Ready",
    assignee: "Monitoring",
    updatedAt: "35m ago",
  },
];

const initialItems: BoardItem[] = [
  {
    id: "session-sess-1",
    kind: "session",
    columnId: "queued",
    session: sessions[0]!,
  },
  {
    id: "session-sess-2",
    kind: "session",
    columnId: "active",
    session: sessions[1]!,
  },
  {
    id: "session-sess-3",
    kind: "session",
    columnId: "review",
    session: sessions[2]!,
  },
  {
    id: "agent-agent-main",
    kind: "agent",
    columnId: "active",
    agent: agents[0]!,
  },
  {
    id: "agent-agent-review",
    kind: "agent",
    columnId: "review",
    agent: agents[1]!,
  },
  {
    id: "agent-agent-verify",
    kind: "agent",
    columnId: "done",
    agent: agents[2]!,
  },
  {
    id: "artifact-prd",
    kind: "artifact",
    columnId: "review",
    artifact: artifacts[0]!,
  },
  {
    id: "artifact-spec",
    kind: "artifact",
    columnId: "queued",
    artifact: artifacts[1]!,
  },
  {
    id: "artifact-workflow",
    kind: "artifact",
    columnId: "done",
    artifact: artifacts[2]!,
  },
];

type ArtifactCardVariant = "default" | "lane" | "drag-preview";

const ARTIFACT_CARD_VARIANT_CLASS_NAMES: Record<ArtifactCardVariant, string> = {
  default: "",
  lane: "rounded-md shadow-none hover:bg-accent/50",
  "drag-preview": "cursor-grabbing rounded-md shadow-lg",
};

function ArtifactCard({
  artifact,
  active = false,
  onClick,
  variant = "lane",
}: {
  artifact: ArtifactCardRecord;
  active?: boolean;
  onClick?: () => void;
  variant?: ArtifactCardVariant;
}) {
  let ArtifactIcon = FileCode2;
  if (artifact.artifactType === "PRD") {
    ArtifactIcon = FileSearch;
  } else if (artifact.artifactType === "Workflow") {
    ArtifactIcon = Sparkles;
  }

  const content = (
    <KanbanCardFrame
      active={active}
      className={cn(
        "rounded-xl p-3 shadow-sm hover:border-border",
        ARTIFACT_CARD_VARIANT_CLASS_NAMES[variant]
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/12 text-amber-400">
            <ArtifactIcon className="size-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="truncate font-medium text-sm">{artifact.title}</p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {artifact.slug}
            </p>
          </div>
        </div>
        <Chip size="sm" variant="outline">
          {artifact.artifactType}
        </Chip>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Chip size="sm" variant="accent">
          {artifact.priority}
        </Chip>
        <Chip size="sm" variant="outline">
          {artifact.status}
        </Chip>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">{artifact.assignee}</span>
        <span className="shrink-0">{artifact.updatedAt}</span>
      </div>
    </KanbanCardFrame>
  );

  if (!onClick) {
    return content;
  }

  return (
    <button className="block w-full text-left" onClick={onClick} type="button">
      {content}
    </button>
  );
}

function renderBoardItem(
  item: BoardItem,
  activeId: string | null,
  setActiveId: (id: string) => void
) {
  switch (item.kind) {
    case "session":
      return (
        <SessionCard
          active={activeId === item.id}
          onClick={() => setActiveId(item.id)}
          session={item.session}
        />
      );
    case "agent":
      return (
        <button
          className="block w-full text-left"
          onClick={() => setActiveId(item.id)}
          type="button"
        >
          <AgentCard active={activeId === item.id} agent={item.agent} />
        </button>
      );
    case "artifact":
      return (
        <ArtifactCard
          active={activeId === item.id}
          artifact={item.artifact}
          onClick={() => setActiveId(item.id)}
        />
      );
    default:
      return null;
  }
}

function renderOverlayCard(item: BoardItem) {
  switch (item.kind) {
    case "session":
      return <SessionCard session={item.session} />;
    case "agent":
      return <AgentCard agent={item.agent} />;
    case "artifact":
      return <ArtifactCard artifact={item.artifact} variant="drag-preview" />;
    default:
      return null;
  }
}

function DraggableBoardCard({
  item,
  isActive,
  onActivate,
}: {
  item: BoardItem;
  isActive: boolean;
  onActivate: (id: string) => void;
}) {
  const { attributes, isDragging, listeners, setNodeRef, transform } =
    useDraggable({ id: item.id });
  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  return (
    <div
      className={cn(isDragging ? "cursor-grabbing opacity-40" : "cursor-grab")}
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      {renderBoardItem(item, isActive ? item.id : null, onActivate)}
    </div>
  );
}

function DroppableColumn({
  column,
  children,
  count,
}: {
  column: BoardColumn;
  children: React.ReactNode;
  count: number;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: column.id });

  return (
    <div ref={setNodeRef}>
      <KanbanColumn
        count={count}
        highlighted={isOver}
        icon={<Boxes className="size-4 text-muted-foreground" />}
        title={column.label}
        trailing={
          <Chip size="sm" variant="outline">
            Lane
          </Chip>
        }
      >
        <div className="flex flex-col gap-2">{children}</div>
      </KanbanColumn>
    </div>
  );
}

function KanbanBoardCanvas() {
  const [items, setItems] = useState<BoardItem[]>(initialItems);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialItems[0]!.id
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const activeItem = useMemo(
    () => items.find((item) => item.id === activeId) ?? null,
    [activeId, items]
  );

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId]
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    setSelectedId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const overId = event.over ? String(event.over.id) : null;
    if (!overId) {
      setActiveId(null);
      return;
    }

    const overItem = items.find((item) => item.id === overId);
    const nextColumnId = columns.some((column) => column.id === overId)
      ? overId
      : overItem?.columnId;

    if (!nextColumnId) {
      setActiveId(null);
      return;
    }

    setItems((current) =>
      current.map((item) =>
        item.id === event.active.id ? { ...item, columnId: nextColumnId } : item
      )
    );
    setActiveId(null);
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
        <Chip size="sm" variant="outline">
          <Bot className="size-3" />
          Drag cards between columns
        </Chip>
        <Chip size="sm" variant="outline">
          Sessions
        </Chip>
        <Chip size="sm" variant="outline">
          Agents
        </Chip>
        <Chip size="sm" variant="outline">
          Artifacts
        </Chip>
      </div>

      <DndContext
        onDragEnd={handleDragEnd}
        onDragStart={handleDragStart}
        sensors={sensors}
      >
        <KanbanBoardLayout className="w-full" contentClassName="min-h-[30rem]">
          {columns.map((column) => {
            const columnItems = items.filter(
              (item) => item.columnId === column.id
            );
            return (
              <DroppableColumn
                column={column}
                count={columnItems.length}
                key={column.id}
              >
                {columnItems.map((item) => (
                  <DraggableBoardCard
                    isActive={selectedId === item.id}
                    item={item}
                    key={item.id}
                    onActivate={setSelectedId}
                  />
                ))}
              </DroppableColumn>
            );
          })}
        </KanbanBoardLayout>
        <DragOverlay>
          {activeItem ? (
            <div className="w-[280px]">{renderOverlayCard(activeItem)}</div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <Card className="p-4">
        <div className="flex items-center gap-2 font-medium text-sm">
          <FlaskConical className="size-4 text-muted-foreground" />
          Wired interaction state
        </div>
        <p className="mt-2 text-muted-foreground text-sm">
          Selected: {selectedItem ? selectedItem.id : "none"}
        </p>
        <p className="text-muted-foreground text-sm">
          Drop target updates column state immediately so the shared board
          layout can be reviewed with real drag behavior.
        </p>
      </Card>
    </div>
  );
}

const meta = {
  title: "Design System/Layout/Kanban Board",
  component: KanbanBoardCanvas,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof KanbanBoardCanvas>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
