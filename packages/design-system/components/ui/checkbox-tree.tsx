"use client";

import { Checkbox } from "@closedloop-ai/design-system/components/ui/checkbox";
import { buildTreeIndentStyle } from "@closedloop-ai/design-system/components/ui/grid-table-v2-tree-lead";
import {
  type CheckboxTreeCheckState,
  type CheckboxTreeLock,
  type CheckboxTreeNode,
  deriveCheckboxTreeLocks,
  deriveCheckboxTreeStates,
  normalizeCheckboxTree,
  toggleCheckboxTreeNode,
} from "@closedloop-ai/design-system/lib/checkbox-tree";
import {
  flattenRenderRows,
  type GridTreeRowMeta,
  treeRowAriaProps,
} from "@closedloop-ai/design-system/lib/grid-table-v2-tree";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { ChevronDownIcon, ChevronRightIcon, LockIcon } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

export type {
  CheckboxTreeCheckState,
  CheckboxTreeNode,
} from "@closedloop-ai/design-system/lib/checkbox-tree";

/**
 * The tree must be named, and the primitive owns no copy to name it with — so
 * the type makes the caller choose a visible label or an accessible one.
 */
type CheckboxTreeName =
  | { "aria-label": string; "aria-labelledby"?: never }
  | { "aria-labelledby": string; "aria-label"?: never };

export type CheckboxTreeProps = CheckboxTreeName & {
  nodes: readonly CheckboxTreeNode[];
  /**
   * Controlled checked ids. An id checks its whole subtree (inherited),
   * including children added to `nodes` later.
   */
  checkedIds?: readonly string[];
  defaultCheckedIds?: readonly string[];
  /**
   * Receives the checked set after a toggle. It is NOT every row that renders
   * checked:
   *
   * - A parent id appears only when the user clicked that parent — consent for
   *   the whole folder, children added later included. Checking every child
   *   one by one renders the parent checked but emits the child ids, never the
   *   parent's, so a later child arrives unchecked.
   * - Unchecking one child of a clicked parent drops the parent id and emits
   *   its remaining current children instead.
   * - Ids not present in `nodes` are passed through untouched: the tree never
   *   deletes a selection it cannot see.
   */
  onCheckedChange?: (checkedIds: string[]) => void;
  /** Controlled expanded ids. */
  expandedIds?: readonly string[];
  defaultExpandedIds?: readonly string[];
  onExpandedChange?: (expandedIds: string[]) => void;
  className?: string;
};

function useControlledIds(
  controlled: readonly string[] | undefined,
  initial: readonly string[] | undefined,
  onChange: ((ids: string[]) => void) | undefined
): [ReadonlySet<string>, (ids: string[]) => void] {
  const [uncontrolled, setUncontrolled] = useState<readonly string[]>(
    initial ?? []
  );
  const ids = controlled ?? uncontrolled;
  const set = useMemo(() => new Set(ids), [ids]);
  const update = useCallback(
    (next: string[]) => {
      if (controlled === undefined) {
        setUncontrolled(next);
      }
      onChange?.(next);
    },
    [controlled, onChange]
  );
  return [set, update];
}

/**
 * A domain-free checkbox tree (ISS-12517), following the WAI-ARIA APG tree
 * pattern: one tab stop, arrow keys move and open/close, Space toggles the
 * check, and each item publishes `aria-checked` (including `mixed`) and, when it
 * owns children, `aria-expanded`.
 *
 * Rows are painted FLAT, with `aria-level`/`aria-setsize`/`aria-posinset`
 * stating the hierarchy, rather than as nested groups: a focused item that
 * contains its own subtree would carry its focus ring around every descendant.
 *
 * The visible checkbox is the house `Checkbox`, hidden from assistive tech: the
 * tree item already IS the checkable thing, and a second `checkbox` inside it
 * would announce every state twice.
 *
 * An empty `nodes` paints an empty tree with no tab stop: the empty state is
 * the consumer's to render, with its own copy.
 */
export function CheckboxTree({
  nodes: callerNodes,
  checkedIds,
  defaultCheckedIds,
  onCheckedChange,
  expandedIds,
  defaultExpandedIds,
  onExpandedChange,
  className,
  ...name
}: CheckboxTreeProps) {
  const [checked, setChecked] = useControlledIds(
    checkedIds,
    defaultCheckedIds,
    onCheckedChange
  );
  const [expanded, setExpanded] = useControlledIds(
    expandedIds,
    defaultExpandedIds,
    onExpandedChange
  );
  // Normalized ONCE and handed to every walk below, painting included: the
  // row walker only claims ids in open subtrees, so feeding it the caller's
  // nodes would let a repeated id under a closed row paint a different node
  // than the one the state and lock model resolve.
  const nodes = useMemo(() => normalizeCheckboxTree(callerNodes), [callerNodes]);
  const states = useMemo(
    () => deriveCheckboxTreeStates(nodes, checked),
    [nodes, checked]
  );
  const locks = useMemo(() => deriveCheckboxTreeLocks(nodes), [nodes]);
  const rows = useMemo(() => buildRows(nodes, expanded), [nodes, expanded]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // A row that was focused and then hidden by an ancestor collapsing hands the
  // tab stop back to the first row rather than to nothing.
  const activeId = rows.some((row) => row.id === focusedId)
    ? focusedId
    : (rows[0]?.id ?? null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  // Reason ids are positional, never derived from a caller's node id: an id
  // may hold spaces, and `aria-describedby` is a space-separated list. A row
  // under a locked ancestor points at that ancestor's reason, so the id has to
  // be computable for a row other than the one that paints it.
  const reasonIdPrefix = useId();
  const reasonIdAt = (index: number) => `${reasonIdPrefix}-reason-${index}`;
  // A tree with nothing to expand reserves no chevron track, or every row
  // would start one empty control's width in from the edge.
  const reservesDisclosure = rows.some((row) => row.tree.hasChildren);

  const focusRow = (id: string) => {
    setFocusedId(id);
    itemRefs.current.get(id)?.focus();
  };

  const toggleChecked = (id: string) => {
    if (locks.has(id)) {
      return;
    }
    setChecked(toggleCheckboxTreeNode(nodes, checked, id));
  };

  const setRowExpanded = (id: string, open: boolean) => {
    const next = new Set(expanded);
    if (open) {
      next.add(id);
    } else {
      next.delete(id);
    }
    setExpanded([...next]);
  };

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    // A modified key belongs to the browser or assistive tech (Alt+Left is
    // history back), not to the tree.
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const row = rows[index];
    const target = row ? resolveKeyTarget(event.key, row, index, rows) : null;
    if (!(row && target)) {
      return;
    }
    event.preventDefault();
    if (target.kind === "focus") {
      focusRow(target.id);
    } else if (target.kind === "expand") {
      setRowExpanded(row.id, target.open);
    } else {
      toggleChecked(row.id);
    }
  };

  return (
    <div
      {...name}
      className={cn("flex flex-col", className)}
      data-slot="checkbox-tree"
      // Every item carries its own check, so more than one can be selected.
      aria-multiselectable="true"
      role="tree"
    >
      {rows.map((row, index) => {
        const lock = locks.get(row.id);
        return (
          <CheckboxTreeItem
            describedById={lock ? describedBy(lock, rows, reasonIdAt) : undefined}
            isActive={row.id === activeId}
            key={row.id}
            lock={lock}
            onFocus={() => setFocusedId(row.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            onToggleChecked={() => {
              focusRow(row.id);
              toggleChecked(row.id);
            }}
            onToggleExpanded={() => {
              focusRow(row.id);
              setRowExpanded(row.id, !row.tree.isExpanded);
            }}
            reasonId={reasonIdAt(index)}
            reservesDisclosure={reservesDisclosure}
            registerRef={(element) => {
              if (element) {
                itemRefs.current.set(row.id, element);
              } else {
                itemRefs.current.delete(row.id);
              }
            }}
            row={row}
            state={states.get(row.id) ?? "unchecked"}
          />
        );
      })}
    </div>
  );
}

type TreeRow = { id: string; node: CheckboxTreeNode; tree: GridTreeRowMeta };

/**
 * The visible rows, through the same lineage walker the table tree uses, so
 * the set arithmetic behind `aria-posinset`/`aria-setsize` is shared rather
 * than re-derived. It is always handed the normalized tree, so it paints the
 * same nodes the state and lock walks resolve.
 */
function buildRows(
  nodes: readonly CheckboxTreeNode[],
  expanded: ReadonlySet<string>
): TreeRow[] {
  return flattenRenderRows({
    expandedRowIds: expanded,
    getChildren: (node) => node.children,
    getRowId: (node) => node.id,
    items: nodes,
  }).flatMap(({ item, rowId, tree }) =>
    tree ? [{ id: rowId, node: item, tree }] : []
  );
}

/**
 * The reason that describes a locked row: its own, or its locking ancestor's.
 * An ancestor is always painted above a visible descendant, so its reason
 * element exists whenever this row does.
 */
function describedBy(
  lock: CheckboxTreeLock,
  rows: readonly TreeRow[],
  reasonIdAt: (index: number) => string
): string | undefined {
  const index = rows.findIndex((row) => row.id === lock.sourceId);
  const reason = rows[index]?.node.reason;
  if (reason === undefined || reason === null) {
    return;
  }
  return reasonIdAt(index);
}

type KeyTarget =
  | { kind: "focus"; id: string }
  | { kind: "expand"; open: boolean }
  | { kind: "toggle" };

/** The APG tree key map, resolved against the visible rows. */
function resolveKeyTarget(
  key: string,
  row: TreeRow,
  index: number,
  rows: readonly TreeRow[]
): KeyTarget | null {
  const at = (i: number): KeyTarget | null => {
    const id = rows[i]?.id;
    return id === undefined ? null : { kind: "focus", id };
  };
  const { tree } = row;
  switch (key) {
    case "ArrowDown":
      return at(index + 1);
    case "ArrowUp":
      return at(index - 1);
    case "Home":
      return at(0);
    case "End":
      return at(rows.length - 1);
    case "ArrowRight":
      if (!tree.hasChildren) {
        return null;
      }
      return tree.isExpanded ? at(index + 1) : { kind: "expand", open: true };
    case "ArrowLeft":
      if (tree.isExpanded) {
        return { kind: "expand", open: false };
      }
      return at(findParentIndex(rows, index, tree.level));
    case " ":
      return { kind: "toggle" };
    default:
      return null;
  }
}

/** The nearest row above that is one level shallower; -1 at the root. */
function findParentIndex(
  rows: readonly TreeRow[],
  index: number,
  level: number
): number {
  for (let i = index - 1; i >= 0; i--) {
    if (rows[i]?.tree.level === level - 1) {
      return i;
    }
  }
  return -1;
}

function toCheckboxValue(state: CheckboxTreeCheckState) {
  if (state === "mixed") {
    return "indeterminate";
  }
  return state === "checked";
}

function CheckboxTreeItem({
  describedById,
  isActive,
  lock,
  onFocus,
  onKeyDown,
  onToggleChecked,
  onToggleExpanded,
  reasonId,
  registerRef,
  reservesDisclosure,
  row,
  state,
}: {
  describedById: string | undefined;
  isActive: boolean;
  lock: CheckboxTreeLock | undefined;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onToggleChecked: () => void;
  onToggleExpanded: () => void;
  reasonId: string;
  registerRef: (element: HTMLDivElement | null) => void;
  reservesDisclosure: boolean;
  row: TreeRow;
  state: CheckboxTreeCheckState;
}) {
  const { node, tree } = row;
  // Named by its label alone: name-from-content would fold the reason into
  // the name and then `aria-describedby` would announce it a second time.
  const labelId = useId();
  const disabled = lock?.kind === "disabled";
  // A parent with nothing left to toggle beneath it is announced as
  // unavailable too, though it keeps full strength: it is not itself locked,
  // its children are, and they say why.
  const ariaDisabled = disabled || lock?.kind === "descendants";
  const hasReason = node.reason !== undefined && node.reason !== null;
  let ariaChecked: boolean | "mixed" = state === "checked";
  if (state === "mixed") {
    ariaChecked = "mixed";
  }
  return (
    <div
      {...treeRowAriaProps(tree)}
      aria-checked={ariaChecked}
      aria-describedby={describedById}
      aria-disabled={ariaDisabled ? true : undefined}
      aria-labelledby={labelId}
      className={cn(
        "rounded-sm px-1 py-0.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        // A locked row keeps no hover wash: it would promise a click that
        // does nothing.
        lock ? "cursor-default" : "cursor-pointer hover:bg-muted",
        disabled && "text-muted-foreground"
      )}
      data-readonly={lock?.kind === "readOnly" ? "" : undefined}
      data-slot="checkbox-tree-item"
      onClick={onToggleChecked}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      ref={registerRef}
      role="treeitem"
      tabIndex={isActive ? 0 : -1}
    >
      {/* The indent sits on an inner track, not the item, so it adds to the
          item's own inline padding instead of replacing it. */}
      <div
        className="flex min-w-0 items-start gap-density-cozy"
        style={buildTreeIndentStyle(tree.level)}
      >
        {reservesDisclosure ? (
          <TreeDisclosure onToggle={onToggleExpanded} tree={tree} />
        ) : null}
        {/* Inside a <form>, Radix renders a hidden input beside the checkbox
            and dispatches a bubbling click on it whenever `checked` changes.
            That click would reach the row and toggle it again, forever. A
            real pointer never lands on either child (both ignore pointer
            events), so any click aimed below this wrapper is that echo. */}
        <span
          className="flex h-icon-lg shrink-0 items-center"
          data-slot="checkbox-tree-check"
          onClick={(event) => {
            if (event.target !== event.currentTarget) {
              event.stopPropagation();
            }
          }}
        >
          <Checkbox
            aria-hidden="true"
            checked={toCheckboxValue(state)}
            className="pointer-events-none"
            disabled={disabled}
            tabIndex={-1}
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col justify-center py-0.5">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate" id={labelId}>
              {node.label}
            </span>
            {/* A read-only row is drawn at full strength, so without a mark
                it would look as clickable as its editable siblings. A lock
                inherited from an ancestor is marked too. */}
            {lock?.kind === "readOnly" ? (
              <LockIcon
                aria-hidden="true"
                className="size-icon-sm shrink-0 text-muted-foreground"
                data-slot="checkbox-tree-lock"
              />
            ) : null}
          </span>
          {hasReason ? (
            <span
              className={cn(
                "text-xs",
                // A disabled row's label is already muted; its reason steps
                // one further down so the two do not read as one grey block.
                disabled ? "text-muted-foreground/70" : "text-muted-foreground"
              )}
              id={reasonId}
            >
              {node.reason}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/**
 * Not a button: in the tree pattern the item itself is the one focus stop and
 * the arrow keys open it, so the chevron is a pointer target only. In a tree
 * that has any expandable row, a leaf reserves the same track so its checkbox
 * lines up with its siblings'.
 */
function TreeDisclosure({
  onToggle,
  tree,
}: {
  onToggle: () => void;
  tree: GridTreeRowMeta;
}) {
  if (!tree.hasChildren) {
    return (
      <span
        aria-hidden="true"
        className="size-icon-lg shrink-0 touch:size-tap-min"
        data-slot="checkbox-tree-disclosure-spacer"
      />
    );
  }
  const Icon = tree.isExpanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <span
      aria-hidden="true"
      // `touch:size-tap-min` matches the table tree lead: a thumb that misses
      // this target lands on the row, which toggles the check instead.
      className="flex size-icon-lg shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground touch:size-tap-min"
      data-slot="checkbox-tree-disclosure"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <Icon className="size-icon-sm" />
    </span>
  );
}
