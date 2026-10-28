"use client";

import {
  type Announcements,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  useDraggable,
  useDroppable,
} from "@dnd-kit/core";
import {
  DragPreviewChip,
  type DragPreviewChipProps,
} from "@repo/design-system/components/ui/drag-preview-chip";
import { KanbanColumn } from "@repo/design-system/components/ui/layout/kanban-board";
import {
  sortableSubtreeAnnouncementData,
  sortableSubtreeAnnouncementLabel,
  sortableSubtreeAnnouncements,
} from "@repo/design-system/components/ui/sortable-subtree";
import { cn } from "@repo/design-system/lib/utils";
import { isRecord } from "@repo/lib/harness/type-guards";
import { Loader2Icon } from "lucide-react";
import {
  type FocusEvent,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ArtifactBoardCard } from "./artifact-board-card";
import { useArtifactBoardSensors } from "./artifact-board-dnd";
import {
  ARTIFACT_BOARD_LABEL,
  ArtifactBoardDropPosition,
  type ArtifactBoardFieldDefinition,
  type ArtifactBoardItem,
  type ArtifactBoardLane,
  type ArtifactBoardMove,
  type ArtifactBoardMoveTarget,
  ArtifactBoardMutationState,
  type ArtifactBoardRenderers,
  type ArtifactBoardSelectionIntent as ArtifactBoardSelectionIntentValue,
  artifactBoardMoveRootIds,
  visibleArtifactBoardFields,
} from "./artifact-board-model";
import { artifactBoardPinnedIds } from "./artifact-board-virtualization";
import {
  ArtifactBoardCardWindow,
  ArtifactBoardLaneWindow,
} from "./artifact-board-virtualized";

export type ArtifactBoardFeedback =
  | { state: typeof ArtifactBoardMutationState.Idle }
  | { label: string; state: typeof ArtifactBoardMutationState.Pending }
  | { content: ReactNode; state: typeof ArtifactBoardMutationState.Error };

export type ArtifactBoardProps = ArtifactBoardRenderers & {
  canMoveItem?: (item: ArtifactBoardItem) => boolean;
  canMoveItemToTarget?: (
    item: ArtifactBoardItem,
    target: ArtifactBoardMoveTarget
  ) => boolean;
  fields: readonly ArtifactBoardFieldDefinition[];
  feedback: ArtifactBoardFeedback;
  getDropTargetLabel: (target: ArtifactBoardMoveTarget) => string;
  items: readonly ArtifactBoardItem[];
  lanes: readonly ArtifactBoardLane[];
  onMove: (move: ArtifactBoardMove) => void;
  onMoveRejected?: (
    item: ArtifactBoardItem,
    target: ArtifactBoardMoveTarget
  ) => void;
  onOpen: (item: ArtifactBoardItem) => void;
  onSelectionChange: (
    itemId: string,
    intent: ArtifactBoardSelectionIntentValue
  ) => void;
  primaryGroupFieldId: string;
  secondaryGroupFieldId: string | null;
  selectedIds: readonly string[];
  visibleFieldIds: readonly string[];
};

/**
 * Field-grouped Artifact Board shared by production adapters and the preserved
 * prototype. It owns pointer movement and card/lane geometry; domain writes,
 * navigation, cells and copy remain injected by the host.
 */
export function ArtifactBoard({
  canMoveItem = () => true,
  canMoveItemToTarget = () => true,
  feedback,
  fields,
  getDropTargetLabel,
  items,
  lanes,
  onMove,
  onMoveRejected,
  onOpen,
  onSelectionChange,
  primaryGroupFieldId,
  renderActions,
  renderField,
  renderTitle,
  renderTypeIcon,
  secondaryGroupFieldId,
  selectedIds,
  visibleFieldIds,
}: Readonly<ArtifactBoardProps>) {
  const [activeRootId, setActiveRootId] = useState<string | null>(null);
  const [activeTarget, setActiveTarget] =
    useState<ArtifactBoardMoveTarget | null>(null);
  const [focusedRootId, setFocusedRootId] = useState<string | null>(null);
  const dragPreviewStart = useRef<DragPreviewChipProps | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreviewChipProps | null>(
    null
  );
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const itemById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items]
  );
  const visibleFields = useMemo(
    () =>
      visibleArtifactBoardFields(
        fields,
        new Set(visibleFieldIds),
        primaryGroupFieldId,
        secondaryGroupFieldId
      ),
    [fields, primaryGroupFieldId, secondaryGroupFieldId, visibleFieldIds]
  );
  const sensors = useArtifactBoardSensors();
  const activeItem = activeRootId ? itemById.get(activeRootId) : undefined;
  const typeGrouped =
    primaryGroupFieldId === "type" || secondaryGroupFieldId === "type";
  const dragDisabled = feedback.state === ArtifactBoardMutationState.Pending;
  const pinnedRootIds = useMemo(() => {
    return artifactBoardPinnedIds({
      activeRootId,
      destinationRootId: activeTarget?.referenceRootId,
      focusedRootId,
      selectedIds,
    });
  }, [activeRootId, activeTarget?.referenceRootId, focusedRootId, selectedIds]);
  const pinnedLaneIds = useMemo(() => {
    const pinned = new Set<string>();
    if (activeTarget) {
      pinned.add(activeTarget.laneId);
    }
    for (const lane of lanes) {
      if (lane.rootIds.some((id) => pinnedRootIds.has(id))) {
        pinned.add(lane.id);
      }
    }
    return pinned;
  }, [activeTarget, lanes, pinnedRootIds]);
  const rootPositionById = useMemo(
    () =>
      new Map(
        lanes
          .flatMap((lane) => lane.rootIds)
          .map((id, index) => [id, index + 1])
      ),
    [lanes]
  );

  const moveFromRoot = (activeId: string, target: ArtifactBoardMoveTarget) => {
    const item = itemById.get(activeId);
    if (!(item && canMoveItem(item))) {
      return;
    }
    if (!canMoveItemToTarget(item, target)) {
      onMoveRejected?.(item, target);
      return;
    }
    onMove({
      rootIds: artifactBoardMoveRootIds(items, item.rootId, selectedIdSet),
      sourceLaneId: item.laneId,
      target,
    });
  };

  const handleDragStart = (event: DragStartEvent) => {
    const activeId = String(event.active.id);
    setActiveRootId(activeId);
    const item = itemById.get(activeId);
    const preview = item ? pointerDragPreview(event, item.title) : null;
    dragPreviewStart.current = preview;
    setDragPreview(preview);
  };
  const handleDragMove = (event: DragMoveEvent) => {
    const start = dragPreviewStart.current;
    if (start) {
      setDragPreview({
        ...start,
        x: start.x + event.delta.x,
        y: start.y + event.delta.y,
      });
    }
  };
  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    dragPreviewStart.current = null;
    setDragPreview(null);
    setActiveRootId(null);
    setActiveTarget(null);
    const target = resolveArtifactBoardMoveTarget(
      event.over?.data.current?.target
    );
    if (target) {
      moveFromRoot(activeId, target);
    }
  };
  const handleDragOver = (event: DragOverEvent) => {
    const target = resolveArtifactBoardMoveTarget(
      event.over?.data.current?.target
    );
    setActiveTarget((current) =>
      artifactBoardTargetsEqual(current, target) ? current : target
    );
  };
  const handleFocusCapture = (event: FocusEvent<HTMLFieldSetElement>) => {
    const card = (event.target as Element).closest<HTMLElement>(
      "[data-artifact-board-card]"
    );
    setFocusedRootId(card?.dataset.artifactBoardCard ?? null);
  };
  const handleBlurCapture = (event: FocusEvent<HTMLFieldSetElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setFocusedRootId(null);
    }
  };

  return (
    <fieldset
      aria-label={ARTIFACT_BOARD_LABEL}
      className="m-0 flex min-h-0 min-w-0 flex-1 flex-col border-0 p-0"
      data-artifact-board
      onBlurCapture={handleBlurCapture}
      onFocusCapture={handleFocusCapture}
    >
      <ArtifactBoardFeedbackBanner feedback={feedback} />
      <DndContext
        accessibility={{ announcements: ARTIFACT_BOARD_ANNOUNCEMENTS }}
        autoScroll
        onDragCancel={() => {
          dragPreviewStart.current = null;
          setDragPreview(null);
          setActiveRootId(null);
          setActiveTarget(null);
        }}
        onDragEnd={handleDragEnd}
        onDragMove={handleDragMove}
        onDragOver={handleDragOver}
        onDragStart={handleDragStart}
        sensors={sensors}
      >
        <ArtifactBoardLaneWindow
          lanes={lanes}
          pinnedLaneIds={pinnedLaneIds}
          renderLane={(lane, laneIndex) => {
            const roots = lane.rootIds
              .map((id) => itemById.get(id))
              .filter(isArtifactBoardRoot);
            return (
              <ArtifactBoardLaneColumn
                activeItem={activeItem}
                canMoveItem={canMoveItem}
                canMoveItemToTarget={canMoveItemToTarget}
                dragDisabled={dragDisabled}
                fields={visibleFields}
                getDropTargetLabel={getDropTargetLabel}
                key={lane.id}
                lane={lane}
                laneIndex={laneIndex}
                onMoveFromRoot={moveFromRoot}
                onOpen={onOpen}
                onSelectionChange={onSelectionChange}
                pinnedRootIds={pinnedRootIds}
                renderActions={renderActions}
                renderField={renderField}
                renderTitle={renderTitle}
                renderTypeIcon={typeGrouped ? undefined : renderTypeIcon}
                rootPositionById={rootPositionById}
                roots={roots}
                selectedIds={selectedIdSet}
                totalLaneCount={lanes.length}
                totalRootCount={rootPositionById.size}
              />
            );
          }}
        />
        {dragPreview
          ? createPortal(
              <DragPreviewChip
                {...dragPreview}
                dropTarget={artifactBoardDragPreviewTarget(
                  activeTarget,
                  dragPreview.sourceElement
                )}
              />,
              globalThis.document.body
            )
          : null}
      </DndContext>
    </fieldset>
  );
}

type ArtifactBoardLaneColumnProps = ArtifactBoardRenderers & {
  activeItem: ArtifactBoardItem | undefined;
  canMoveItem: NonNullable<ArtifactBoardProps["canMoveItem"]>;
  canMoveItemToTarget: NonNullable<ArtifactBoardProps["canMoveItemToTarget"]>;
  dragDisabled: boolean;
  fields: readonly ArtifactBoardFieldDefinition[];
  getDropTargetLabel: ArtifactBoardProps["getDropTargetLabel"];
  lane: ArtifactBoardLane;
  laneIndex: number;
  onMoveFromRoot: (rootId: string, target: ArtifactBoardMoveTarget) => void;
  onOpen: ArtifactBoardProps["onOpen"];
  onSelectionChange: ArtifactBoardProps["onSelectionChange"];
  roots: readonly ArtifactBoardItem[];
  rootPositionById: ReadonlyMap<string, number>;
  pinnedRootIds: ReadonlySet<string>;
  selectedIds: ReadonlySet<string>;
  totalLaneCount: number;
  totalRootCount: number;
};

function ArtifactBoardLaneColumn({
  activeItem,
  canMoveItem,
  canMoveItemToTarget,
  dragDisabled,
  fields,
  getDropTargetLabel,
  lane,
  laneIndex,
  onMoveFromRoot,
  onOpen,
  onSelectionChange,
  renderActions,
  renderField,
  renderTitle,
  renderTypeIcon,
  roots,
  rootPositionById,
  pinnedRootIds,
  selectedIds,
  totalLaneCount,
  totalRootCount,
}: Readonly<ArtifactBoardLaneColumnProps>) {
  const endSlot = (
    <ArtifactBoardDropSlot
      cardShaped={roots.length === 0}
      disabled={
        activeItem
          ? !canMoveItemToTarget(activeItem, {
              laneId: lane.id,
              position: ArtifactBoardDropPosition.End,
            })
          : false
      }
      fillRemaining
      getDropTargetLabel={getDropTargetLabel}
      target={{ laneId: lane.id, position: ArtifactBoardDropPosition.End }}
    />
  );
  return (
    <fieldset
      aria-label={lane.label}
      className="contents"
      data-artifact-board-lane={lane.id}
      data-artifact-board-lane-position={`${laneIndex + 1}/${totalLaneCount}`}
    >
      <legend className="sr-only">{lane.label}</legend>
      {lane.collapsed ? (
        <KanbanColumn
          bodyClassName="flex flex-col gap-0 bg-muted/40"
          className="w-80 min-w-80 rounded-md bg-muted/30 shadow-none"
          count={lane.count ?? roots.length}
          headerClassName="min-h-8"
          title={lane.label}
          trailing={lane.header}
        />
      ) : (
        <ArtifactBoardCardWindow
          endSlot={endSlot}
          pinnedRootIds={pinnedRootIds}
          renderColumn={(children, bodyRef) => (
            <KanbanColumn
              bodyClassName="flex flex-col gap-0 bg-muted/40"
              bodyRef={bodyRef}
              // Each lane scrolls on its own inside a viewport-high bound, so
              // the card window has a bounded scroller even where the page
              // itself scrolls (the phone shell). Precedent: Asana, Linear and
              // Trello boards scroll columns independently (PRD-724 is silent;
              // orchestrator ruling, ISS-9594).
              className="max-h-svh w-80 min-w-80 rounded-md bg-muted/30 shadow-none"
              count={lane.count ?? roots.length}
              headerClassName="min-h-8"
              title={lane.label}
              trailing={lane.header}
            >
              {children}
            </KanbanColumn>
          )}
          renderRoot={(item) => (
            <ArtifactBoardDraggableCard
              activeItem={activeItem}
              canMoveItemToTarget={canMoveItemToTarget}
              disabled={dragDisabled}
              fields={fields}
              getDropTargetLabel={getDropTargetLabel}
              item={item}
              itemMoveDisabled={!canMoveItem(item)}
              key={item.id}
              laneId={lane.id}
              onMoveFromRoot={onMoveFromRoot}
              onOpen={onOpen}
              onSelectionChange={onSelectionChange}
              positionInSet={rootPositionById.get(item.id)}
              renderActions={renderActions}
              renderField={renderField}
              renderTitle={renderTitle}
              renderTypeIcon={renderTypeIcon}
              selected={selectedIds.has(item.id)}
              setSize={totalRootCount}
            />
          )}
          roots={roots}
        />
      )}
    </fieldset>
  );
}

type ArtifactBoardDraggableCardProps = ArtifactBoardRenderers & {
  activeItem: ArtifactBoardItem | undefined;
  canMoveItemToTarget: NonNullable<ArtifactBoardProps["canMoveItemToTarget"]>;
  disabled: boolean;
  fields: readonly ArtifactBoardFieldDefinition[];
  getDropTargetLabel: ArtifactBoardProps["getDropTargetLabel"];
  item: ArtifactBoardItem;
  itemMoveDisabled: boolean;
  laneId: string;
  onMoveFromRoot: (rootId: string, target: ArtifactBoardMoveTarget) => void;
  onOpen: ArtifactBoardProps["onOpen"];
  onSelectionChange: ArtifactBoardProps["onSelectionChange"];
  selected: boolean;
  positionInSet: number | undefined;
  setSize: number;
};

function ArtifactBoardDraggableCard({
  activeItem,
  canMoveItemToTarget,
  disabled,
  fields,
  getDropTargetLabel,
  item,
  itemMoveDisabled,
  laneId,
  onMoveFromRoot,
  onOpen,
  onSelectionChange,
  renderActions,
  renderField,
  renderTitle,
  renderTypeIcon,
  selected,
  positionInSet,
  setSize,
}: Readonly<ArtifactBoardDraggableCardProps>) {
  const { active, listeners, setNodeRef } = useDraggable({
    data: sortableSubtreeAnnouncementData(item.title.trim() || item.slug),
    disabled: disabled || itemMoveDisabled,
    id: item.id,
  });
  const isDragging = active?.id === item.id;
  return (
    <>
      <ArtifactBoardDropSlot
        disabled={
          activeItem
            ? !canMoveItemToTarget(activeItem, {
                laneId,
                position: ArtifactBoardDropPosition.Before,
                referenceRootId: item.id,
              })
            : false
        }
        getDropTargetLabel={getDropTargetLabel}
        target={{
          laneId,
          position: ArtifactBoardDropPosition.Before,
          referenceRootId: item.id,
        }}
      />
      <div
        className={cn(
          "touch-pan-y",
          isDragging && "rounded-md ring-2 ring-primary/60"
        )}
        data-artifact-board-drag-disabled={
          disabled || itemMoveDisabled || undefined
        }
        data-artifact-board-drag-source={item.id}
        ref={setNodeRef}
        {...listeners}
        tabIndex={-1}
      >
        <ArtifactBoardCard
          fields={fields}
          item={item}
          onMove={(target) => onMoveFromRoot(item.id, target)}
          onOpen={onOpen}
          onSelect={(selectedItem, intent) =>
            onSelectionChange(selectedItem.id, intent)
          }
          positionInSet={positionInSet}
          renderActions={renderActions}
          renderField={renderField}
          renderTitle={renderTitle}
          renderTypeIcon={renderTypeIcon}
          selected={selected}
          setSize={setSize}
        />
      </div>
      <ArtifactBoardDropSlot
        disabled={
          activeItem
            ? !canMoveItemToTarget(activeItem, {
                laneId,
                position: ArtifactBoardDropPosition.After,
                referenceRootId: item.id,
              })
            : false
        }
        getDropTargetLabel={getDropTargetLabel}
        target={{
          laneId,
          position: ArtifactBoardDropPosition.After,
          referenceRootId: item.id,
        }}
      />
    </>
  );
}

function ArtifactBoardDropSlot({
  cardShaped = false,
  disabled = false,
  fillRemaining = false,
  getDropTargetLabel,
  target,
}: Readonly<{
  cardShaped?: boolean;
  disabled?: boolean;
  fillRemaining?: boolean;
  getDropTargetLabel: ArtifactBoardProps["getDropTargetLabel"];
  target: ArtifactBoardMoveTarget;
}>) {
  const label = getDropTargetLabel(target);
  const { isOver, setNodeRef } = useDroppable({
    data: { ...sortableSubtreeAnnouncementData(label), target },
    id: dropTargetId(target),
  });
  return (
    <div
      aria-disabled={disabled || undefined}
      className={cn(
        "relative shrink-0 rounded-md",
        fillRemaining && "grow",
        cardShaped ? "min-h-34 border border-dashed" : "min-h-2",
        isOver &&
          !disabled &&
          (cardShaped
            ? "border-primary bg-primary/8"
            : "before:absolute before:inset-x-0 before:top-0 before:h-1 before:rounded before:bg-primary")
      )}
      data-artifact-board-drop-disabled={disabled || undefined}
      data-artifact-board-drop-label={label}
      data-artifact-board-drop-target={dropTargetId(target)}
      ref={setNodeRef}
    />
  );
}

function ArtifactBoardFeedbackBanner({
  feedback,
}: Readonly<{ feedback: ArtifactBoardFeedback }>) {
  switch (feedback.state) {
    case ArtifactBoardMutationState.Idle:
      return null;
    case ArtifactBoardMutationState.Pending:
      return (
        <div
          className="flex items-center gap-2 border-b px-4 py-2 text-muted-foreground text-sm"
          role="status"
        >
          <Loader2Icon className="size-4 animate-spin" />
          {feedback.label}
        </div>
      );
    case ArtifactBoardMutationState.Error:
      return (
        <div
          className="border-b px-4 py-2 text-destructive text-sm"
          role="alert"
        >
          {feedback.content}
        </div>
      );
    default:
      return exhaustiveArtifactBoardMutationState(feedback);
  }
}

function resolveArtifactBoardMoveTarget(
  value: unknown
): ArtifactBoardMoveTarget | null {
  if (!(isRecord(value) && typeof value.laneId === "string")) {
    return null;
  }
  if (
    value.position !== ArtifactBoardDropPosition.After &&
    value.position !== ArtifactBoardDropPosition.Before &&
    value.position !== ArtifactBoardDropPosition.End
  ) {
    return null;
  }
  if (
    (value.position === ArtifactBoardDropPosition.After ||
      value.position === ArtifactBoardDropPosition.Before) &&
    typeof value.referenceRootId !== "string"
  ) {
    return null;
  }
  return {
    laneId: value.laneId,
    position: value.position,
    ...(typeof value.referenceRootId === "string"
      ? { referenceRootId: value.referenceRootId }
      : {}),
  };
}

function dropTargetId(target: ArtifactBoardMoveTarget) {
  return [
    "artifact-board-drop",
    target.laneId,
    target.position,
    target.referenceRootId ?? "lane",
  ].join(":");
}

function isArtifactBoardRoot(
  item: ArtifactBoardItem | undefined
): item is ArtifactBoardItem {
  return item !== undefined && item.rootId === item.id;
}

function exhaustiveArtifactBoardMutationState(state: never): never {
  return state;
}

function artifactBoardTargetsEqual(
  left: ArtifactBoardMoveTarget | null,
  right: ArtifactBoardMoveTarget | null
): boolean {
  return (
    left?.laneId === right?.laneId &&
    left?.position === right?.position &&
    left?.referenceRootId === right?.referenceRootId
  );
}

function pointerDragPreview(
  event: DragStartEvent,
  label: string
): DragPreviewChipProps | null {
  const activator = event.activatorEvent;
  let y: number | null = null;
  if (activator instanceof globalThis.MouseEvent) {
    y = activator.clientY;
  } else if (
    typeof globalThis.TouchEvent === "function" &&
    activator instanceof globalThis.TouchEvent
  ) {
    y =
      activator.touches[0]?.clientY ??
      activator.changedTouches[0]?.clientY ??
      null;
  }
  if (y === null) {
    return null;
  }
  const sourceElement = Array.from(
    globalThis.document.querySelectorAll<HTMLElement>(
      "[data-artifact-board-drag-source]"
    )
  ).find(
    (candidate) =>
      candidate.dataset.artifactBoardDragSource === String(event.active.id)
  );
  if (!sourceElement) {
    return null;
  }
  return {
    label,
    sourceElement,
    x: sourceElement.getBoundingClientRect().left,
    y,
  };
}

function artifactBoardDragPreviewTarget(
  target: ArtifactBoardMoveTarget | null,
  sourceElement: HTMLElement
): DragPreviewChipProps["dropTarget"] {
  if (
    !target ||
    target.referenceRootId === sourceElement.dataset.artifactBoardDragSource
  ) {
    return { element: sourceElement, placement: "inside" };
  }
  if (target.position === ArtifactBoardDropPosition.End) {
    return undefined;
  }
  const element = Array.from(
    globalThis.document.querySelectorAll<HTMLElement>(
      "[data-artifact-board-drag-source]"
    )
  ).find(
    (candidate) =>
      candidate.dataset.artifactBoardDragSource === target.referenceRootId
  );
  if (!element) {
    return undefined;
  }
  return {
    element,
    placement:
      target.position === ArtifactBoardDropPosition.Before ? "before" : "after",
  };
}

/**
 * The shared title-aware announcements, plus a drop sentence: no board host
 * announces a settled move, so silence here would leave a drop unannounced.
 * Same wording as dnd-kit's default, with labels in place of ids (ISS-12905).
 */
const ARTIFACT_BOARD_ANNOUNCEMENTS: Announcements = {
  ...sortableSubtreeAnnouncements,
  onDragEnd: ({ active, over }) => {
    const activeLabel = sortableSubtreeAnnouncementLabel(active);
    if (!activeLabel) {
      return undefined;
    }
    const overLabel = sortableSubtreeAnnouncementLabel(over);
    return overLabel
      ? `Draggable item ${activeLabel} was dropped over droppable area ${overLabel}.`
      : `Draggable item ${activeLabel} was dropped.`;
  },
};
