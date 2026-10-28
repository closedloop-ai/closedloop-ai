"use client";

import { GroupSectionHeader } from "@closedloop-ai/design-system/components/ui/group-section-header";
import { isInteractiveRowClickTarget } from "@closedloop-ai/design-system/lib/grid-table-navigation";
import type { GridGroupDropHandlers } from "@closedloop-ai/design-system/lib/grid-table-v2-group-drop";
import {
  buildSubgroupKey,
  resolveGroupCount,
} from "@closedloop-ai/design-system/lib/grid-table-v2-rows";
import type { GridRenderRow } from "@closedloop-ai/design-system/lib/grid-table-v2-tree";
import type {
  GridTableV2Column,
  GridTableV2Group,
  GridTableV2Mode,
  GridTableV2Props,
} from "@closedloop-ai/design-system/lib/grid-table-v2-types";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { CARD_FALLBACK_BREAKPOINT } from "@closedloop-ai/design-system/lib/column-order";
import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
} from "react";
import { CHIP_FOCUS_RING_CLASS } from "./chip";
import { GridTableV2TreeLead } from "./grid-table-v2-tree-lead";

/**
 * `GridTableV2`'s narrow-surface layout: a stacked card list instead of a
 * horizontally-scrolling grid (FEA-3865).
 *
 * Extracted from `grid-table-v2.tsx` (ISS-8930) because it is the one branch of
 * that file that is not a grid at all — it paints no `row`, no `gridcell` and
 * no roving tab stop, so none of the keyboard model the rest of the component
 * exists to carry applies here. Keeping it in place made every addition to the
 * grid's keyboard model read as if it might apply to the cards too.
 *
 * Exactly one layout renders, never both, so this mounts only when the grid
 * does not.
 */
export function GridTableV2CardList<T>({
  afterGroupNodes,
  afterRowsNode,
  beginSiblingWalk,
  collapsedGroups,
  groupDropHandlers,
  groupIcon,
  groups,
  renderCardItem,
  showGroupCounts,
  toggleGroup,
  ungroupedRows,
}: {
  afterGroupNodes: Map<string, ReactNode>;
  afterRowsNode: ReactNode;
  /**
   * Starts this pass's own cycle guard — never shared with the grid's, and
   * never handed in already started (ISS-10335). A walk's guard is spent once
   * every id it has seen is in the set, and React may invoke this body more
   * than once for a single commit (StrictMode, a re-render reusing the prop),
   * so an already-started walk in a prop paints empty bands under headers that
   * still count their items. Taking the factory makes the walk begin where it
   * is consumed, which is the only place that can be once per render.
   */
  beginSiblingWalk: () => (items: readonly T[]) => GridRenderRow<T>[];
  collapsedGroups: ReadonlySet<string>;
  groupDropHandlers: (
    group: GridTableV2Group<T>,
    subgroup?: GridTableV2Group<T>
  ) => GridGroupDropHandlers;
  groupIcon: ReactNode;
  groups?: GridTableV2Group<T>[];
  renderCardItem: (row: GridRenderRow<T>) => ReactNode;
  showGroupCounts: boolean;
  toggleGroup: (key: string) => void;
  ungroupedRows: GridRenderRow<T>[];
}) {
  const expandSiblings = beginSiblingWalk();
  if (!groups) {
    return (
      <div className="flex flex-col gap-3 p-3">
        {ungroupedRows.map(renderCardItem)}
        {afterRowsNode}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-3">
      {groups.map((group) => {
        const isOpen = !collapsedGroups.has(group.key);
        return (
          <div className="flex flex-col gap-3" key={group.key}>
            <GroupSectionHeader
              count={resolveGroupCount(group, showGroupCounts)}
              icon={group.icon ?? groupIcon}
              isContinued={group.isContinued}
              isOpen={isOpen}
              label={group.label}
              onToggle={() => toggleGroup(group.key)}
            />
            {isOpen && group.subgroups
              ? group.subgroups.map((subgroup) => {
                  const subgroupKey = buildSubgroupKey(group.key, subgroup.key);
                  const subgroupOpen = !collapsedGroups.has(subgroupKey);
                  return (
                    <CardSubgroup
                      group={group}
                      groupDropHandlers={groupDropHandlers}
                      groupIcon={groupIcon}
                      isOpen={subgroupOpen}
                      key={subgroupKey}
                      showGroupCounts={showGroupCounts}
                      subgroup={subgroup}
                      subgroupKey={subgroupKey}
                      toggleGroup={toggleGroup}
                    >
                      {subgroupOpen
                        ? expandSiblings(subgroup.items).map(renderCardItem)
                        : null}
                    </CardSubgroup>
                  );
                })
              : null}
            {isOpen && !group.subgroups
              ? expandSiblings(group.items).map(renderCardItem)
              : null}
            {isOpen ? afterGroupNodes.get(group.key) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One card, plus whatever the grid's after-item slot painted for its row.
 *
 * Lives here rather than in `grid-table-v2.tsx` because a card is this
 * layout's unit, not the grid's: it paints no row, no cell and no roving tab
 * stop, so none of the component's keyboard model reaches it.
 */
export function GridTableV2CardItem<T>({
  afterNode,
  collapseLabel,
  columns,
  expandLabel,
  onToggleExpanded,
  render,
  row: { item, rowId, tree },
  selection,
}: {
  afterNode: ReactNode;
  collapseLabel?: string;
  columns: readonly GridTableV2Column[];
  expandLabel?: string;
  onToggleExpanded: (rowId: string, expanded: boolean) => void;
  render?: (item: T, columns: readonly GridTableV2Column[]) => ReactNode;
  row: GridRenderRow<T>;
  /** Supplied only when this card can resolve gestures into a selection. */
  selection?: GridTableV2CardSelection;
}) {
  const content = render?.(item, columns);
  const touch = useCardTouchSelection(selection);
  const card = selection ? (
    <div
      aria-label={selection.label}
      className={cn(
        "group/row rounded-xl pointer-coarse:select-none",
        CHIP_FOCUS_RING_CLASS,
        selection.selected &&
          "[&>[data-slot=card]]:border-primary/30 [&>[data-slot=card]]:bg-primary/10"
      )}
      data-grid-card-id={rowId}
      data-analytics-action="true"
      data-analytics-keyboard="true"
      data-analytics-label={selection.analyticsLabel}
      data-state={selection.selected ? "selected" : undefined}
      onClick={(event) => {
        if (
          event.target instanceof globalThis.Element &&
          isInteractiveRowClickTarget(event.target)
        ) {
          return;
        }
        touch.onClick(event, selection);
      }}
      onContextMenu={touch.onContextMenu}
      onKeyDown={(event) => {
        if (shouldSelectGridCardFromKey(event)) {
          event.preventDefault();
          selection.onKeyboardSelect(event);
        }
      }}
      onPointerCancel={touch.endPress}
      onPointerDown={(event) => touch.onPointerDown(event, selection)}
      onPointerMove={touch.onPointerMove}
      onPointerUp={touch.endPress}
      role="group"
      tabIndex={0}
    >
      {content}
    </div>
  ) : (
    <div className="group/row" data-grid-card-id={rowId}>
      {content}
    </div>
  );
  return (
    <Fragment key={rowId}>
      {tree === null ? (
        card
      ) : (
        // The narrow layout carries the SAME disclosure rather than a read-only
        // projection of it: a card list that painted only the roots would put a
        // row's children out of reach on a phone, and one that painted every
        // descendant regardless of state would show rows the user had closed.
        // Reusing the control keeps both layouts telling the same story about
        // what is open.
        <GridTableV2TreeLead
          className="items-start"
          collapseLabel={collapseLabel}
          // The card list paints no `row`, so unlike the grid there is nothing
          // above this control to carry the state — without this the
          // open/closed fact would reach assistive tech nowhere at all.
          declaresExpandedState
          expandLabel={expandLabel}
          onToggle={(expanded) => onToggleExpanded(rowId, expanded)}
          tree={tree}
        >
          {card}
        </GridTableV2TreeLead>
      )}
      {afterNode}
    </Fragment>
  );
}

/**
 * A subgroup band, over cards its caller already built.
 *
 * It takes the painted nodes rather than the walk that produces them
 * (ISS-10335): a walk is single-use, and a prop crosses a render boundary that
 * React may cross more than once per commit, so the band that received one
 * painted empty on every invocation after the first.
 */
function CardSubgroup<T>({
  children,
  group,
  groupDropHandlers,
  groupIcon,
  isOpen,
  showGroupCounts,
  subgroup,
  subgroupKey,
  toggleGroup,
}: {
  children: ReactNode;
  group: GridTableV2Group<T>;
  groupDropHandlers: (
    group: GridTableV2Group<T>,
    subgroup?: GridTableV2Group<T>
  ) => GridGroupDropHandlers;
  groupIcon: ReactNode;
  isOpen: boolean;
  showGroupCounts: boolean;
  subgroup: GridTableV2Group<T>;
  subgroupKey: string;
  toggleGroup: (key: string) => void;
}) {
  return (
    <div
      className="ml-3 flex flex-col gap-3 border-l pl-3"
      {...groupDropHandlers(group, subgroup)}
    >
      <GroupSectionHeader
        className="rounded-md"
        count={resolveGroupCount(subgroup, showGroupCounts)}
        icon={subgroup.icon ?? groupIcon}
        isContinued={subgroup.isContinued}
        isOpen={isOpen}
        label={subgroup.label}
        onToggle={() => toggleGroup(subgroupKey)}
      />
      {children}
    </div>
  );
}

/** The card owns its keys; links, editors and disclosures own their bubbled keys. */
export function shouldSelectGridCardFromKey(event: {
  currentTarget: EventTarget | null;
  key: string;
  target: EventTarget | null;
}): boolean {
  return (
    (event.key === "Enter" || event.key === " ") &&
    event.target === event.currentTarget
  );
}

/** Builds card nodes against the grid's painted order, including grouping/tree state. */
export function createGridTableV2CardRenderer<T>({
  analyticsLabel,
  afterNodes,
  collapseLabel,
  columns,
  expandLabel,
  getCardSelectionLabel,
  isRowSelected,
  onRowClick,
  onRowKeyboardNavigate,
  onRowSelectionToggle,
  onToggleExpanded,
  render,
  renderedItems,
}: {
  analyticsLabel?: string;
  afterNodes: ReadonlyMap<string, ReactNode>;
  collapseLabel?: string;
  columns: readonly GridTableV2Column[];
  expandLabel?: string;
  getCardSelectionLabel?: GridTableV2Props<T>["getCardSelectionLabel"];
  isRowSelected?: GridTableV2Props<T>["isRowSelected"];
  onRowClick?: GridTableV2Props<T>["onRowClick"];
  onRowKeyboardNavigate?: GridTableV2Props<T>["onRowKeyboardNavigate"];
  onRowSelectionToggle?: GridTableV2Props<T>["onRowSelectionToggle"];
  onToggleExpanded: (rowId: string, expanded: boolean) => void;
  render?: GridTableV2Props<T>["cardRender"];
  renderedItems: readonly T[];
}): (row: GridRenderRow<T>) => ReactNode {
  return (row) => {
    let selection: GridTableV2CardSelection | undefined;
    if (
      getCardSelectionLabel &&
      isRowSelected &&
      onRowClick &&
      onRowKeyboardNavigate
    ) {
      const selected = isRowSelected(row.item);
      selection = {
        analyticsLabel,
        label: getCardSelectionLabel(row.item, selected),
        onKeyboardSelect: (event) =>
          onRowKeyboardNavigate(row.item, event, renderedItems),
        onPointerSelect: (event) => onRowClick(row.item, event, renderedItems),
        onTouchToggle: onRowSelectionToggle
          ? () => onRowSelectionToggle(row.item)
          : undefined,
        selected,
      };
    }
    return (
      <GridTableV2CardItem
        afterNode={afterNodes.get(row.rowId)}
        collapseLabel={collapseLabel}
        columns={columns}
        expandLabel={expandLabel}
        key={row.rowId}
        onToggleExpanded={onToggleExpanded}
        render={render}
        row={row}
        selection={selection}
      />
    );
  };
}

/** Label and gestures are atomic so an opt-in cannot create a dead tab stop. */
export type GridTableV2CardSelection = {
  analyticsLabel?: string;
  label: string;
  onKeyboardSelect: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPointerSelect: (event: MouseEvent<HTMLDivElement>) => void;
  /** Adds or removes this card alone; what a touch tap and a long-press do. */
  onTouchToggle?: () => void;
  selected: boolean;
};

/** The existing explicit modes override only the measured auto-mode boundary. */
export function isGridTableV2CardMode(
  mode: GridTableV2Mode,
  containerWidth: number
): boolean {
  return (
    mode === "compact" ||
    (mode === "auto" && containerWidth < CARD_FALLBACK_BREAKPOINT)
  );
}

const TOUCH_POINTER_TYPE = "touch";
/** How long a touch must stay down to count as a long-press. */
const LONG_PRESS_MS = 500;
/** Travel beyond this is a scroll, not a press. */
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

/**
 * Touch tap and long-press toggle a card: Material Design selection
 * (https://m1.material.io/patterns/selection.html), Gmail Help
 * (https://support.google.com/mail/answer/7401?hl=en&co=GENIE.Platform%3DAndroid).
 */
function useCardTouchSelection(selection?: GridTableV2CardSelection) {
  // Safari's `click` carries no `pointerType`, so the press records it.
  const pressPointerType = useRef<string | null>(null);
  const press = useRef<{
    timer: ReturnType<typeof setTimeout>;
    x: number;
    y: number;
  } | null>(null);
  const longPressFired = useRef(false);
  const latestSelection = useRef(selection);
  latestSelection.current = selection;

  const endPress = () => {
    if (press.current) {
      clearTimeout(press.current.timer);
      press.current = null;
    }
  };

  useEffect(() => endPress, []);

  return {
    endPress,
    onPointerDown: (
      event: PointerEvent<HTMLDivElement>,
      current: GridTableV2CardSelection
    ) => {
      pressPointerType.current = event.pointerType;
      longPressFired.current = false;
      endPress();
      if (
        event.pointerType !== TOUCH_POINTER_TYPE ||
        !current.onTouchToggle ||
        (event.target instanceof globalThis.Element &&
          isInteractiveRowClickTarget(event.target))
      ) {
        return;
      }
      press.current = {
        timer: setTimeout(() => {
          press.current = null;
          longPressFired.current = true;
          latestSelection.current?.onTouchToggle?.();
        }, LONG_PRESS_MS),
        x: event.clientX,
        y: event.clientY,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const active = press.current;
      if (
        active &&
        Math.hypot(event.clientX - active.x, event.clientY - active.y) >
          LONG_PRESS_MOVE_TOLERANCE_PX
      ) {
        endPress();
      }
    },
    onContextMenu: (event: MouseEvent<HTMLDivElement>) => {
      if (pressPointerType.current === TOUCH_POINTER_TYPE) {
        event.preventDefault();
      }
    },
    onClick: (
      event: MouseEvent<HTMLDivElement>,
      current: GridTableV2CardSelection
    ) => {
      if (longPressFired.current) {
        longPressFired.current = false;
        return;
      }
      // The press decides: iOS Safari reports a tap's `click` as a "mouse"
      // PointerEvent, while its `pointerdown` says "touch".
      const pointerType =
        pressPointerType.current ??
        ("pointerType" in event.nativeEvent &&
        typeof event.nativeEvent.pointerType === "string"
          ? event.nativeEvent.pointerType
          : null);
      pressPointerType.current = null;
      if (pointerType === TOUCH_POINTER_TYPE && current.onTouchToggle) {
        current.onTouchToggle();
        return;
      }
      current.onPointerSelect(event);
    },
  };
}
