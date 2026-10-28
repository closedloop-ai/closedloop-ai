"use client";

import { cn } from "@closedloop-ai/design-system/lib/utils";
import { PlusIcon } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import {
  TABLE_BULK_ACTION_BUTTON_CLASS_NAME,
  TableBulkActionButton,
} from "./table-bulk-action-bar";

/**
 * What a bulk action may do to the selection it just acted on. Handed to every
 * handler so an action added by a host can finish the interaction without
 * knowing which layer owns the selected rows.
 *
 * `retain` narrows rather than clears: a batch of independent per-row mutations
 * can partly succeed, and the reader must be left holding exactly the rows that
 * still need doing.
 */
export type TableBulkSelectionControls = {
  clear: () => void;
  /** Changes for reader/reset work, not an action removing its own completed rows. */
  getGeneration?: () => number;
  /** Reports per-row settlement when the descriptor owns the mutation response. */
  reportResult?: (result: TableBulkActionResult) => void;
  retain: (rowIds: readonly string[]) => void;
};

export type TableBulkActionContext = {
  rowIds: readonly string[];
  selection: TableBulkSelectionControls;
  /** Route a custom picker's choice through its active descriptor handler. */
  selectOption: (option: TableBulkActionOption) => Promise<boolean>;
};

export type TableBulkActionOption = {
  /** Replaces the rendered row body; `label` stays the name and match key. */
  content?: ReactNode;
  id: string;
  label: string;
};

/**
 * A picker's search field, as one value. Atomic on purpose: a placeholder is
 * not an accessible name, so a descriptor that could supply one without the
 * other could ship a textbox no screen reader can announce.
 */
export type TableBulkPickerSearch = {
  label: string;
  placeholder: string;
};

/**
 * Ruled 2026-09-16 (ISS-10161): non-destructive actions are undoable,
 * destructive ones are not.
 */
export const TableBulkActionUndo = {
  Supported: "supported",
  /** Withheld on purpose — confirmed before it runs, not reversed after. */
  Unsupported: "unsupported",
  /** A gap someone should close. Never collapse into `Unsupported`. */
  NotImplemented: "not_implemented",
} as const;
export type TableBulkActionUndo =
  (typeof TableBulkActionUndo)[keyof typeof TableBulkActionUndo];

type TableBulkActionBase = {
  /** Allows a remaining single-row selection to retry a partial batch. */
  canRetrySelection?: (
    rowIds: readonly string[],
    selection?: TableBulkSelectionControls
  ) => boolean;
  /** Shared hosts report selection/lifetime changes even while the rail is hidden. */
  onLifecycle?: (event: TableBulkActionLifecycleEvent) => void;
  icon: ReactNode;
  id: string;
  /**
   * This action's OWN mutation is in flight — not "the host cannot offer it".
   * An unavailable action is left out of the list entirely rather than rendered
   * dead (PRD-695 principle 6).
   */
  isPending?: boolean;
  /** The control's accessible name. */
  label: string;
  undo: TableBulkActionUndo;
  /**
   * Chrome for THIS action, for a host whose bulk bar is not the rail. Omitted,
   * the rail's own control renders it.
   */
  render?: (context: TableBulkActionContext) => ReactNode;
};

export type TableBulkCommandDescriptor = TableBulkActionBase & {
  kind: "command";
  onSelect: (
    rowIds: readonly string[],
    selection: TableBulkSelectionControls
  ) => void;
  pressed?: boolean;
};

export type TableBulkPickerDescriptor = TableBulkActionBase & {
  createOptionLabel?: (query: string) => string;
  emptyLabel: string;
  kind: "picker";
  /**
   * Resolving `true` means the action landed, which is what closes the picker.
   * A rejection is the same answer as `false` here: this component decides
   * whether to stay open, and only the descriptor knows how to report a domain
   * failure to the reader.
   */
  onCreateOption?: (
    query: string,
    rowIds: readonly string[],
    selection: TableBulkSelectionControls
  ) => Promise<boolean> | boolean;
  /** @see onCreateOption for what the resolved value means. */
  onSelect: (
    rowIds: readonly string[],
    option: TableBulkActionOption,
    selection: TableBulkSelectionControls
  ) => Promise<boolean> | boolean;
  options: readonly TableBulkActionOption[];
  /** Supplied, the picker grows a search field. Omitted, it has none. */
  search?: TableBulkPickerSearch;
};

/**
 * One bulk operation, as data. A surface takes an ORDERED list of these and the
 * rail renders them, so adding an operation is one more entry rather than a
 * change to this package or to the surface that hosts the bar.
 *
 * Deliberately domain-free: ids and labels are strings, the icon is a node, and
 * a handler is given the SELECTED ROW IDS. Nothing here can name a favourite, a
 * session, or a document.
 */
export type TableBulkActionDescriptor =
  | TableBulkCommandDescriptor
  | TableBulkPickerDescriptor;

/**
 * Renders the descriptors into a bulk bar's `actions` slot.
 *
 * `rowIds` is the selection, handed down; no action re-derives it. That is what
 * makes a bulk operation over a tree act on exactly the rows the grid painted
 * and the reader could see — a collapsed parent's hidden descendants are not in
 * the selection, so they are not in `rowIds`.
 */
export function TableBulkActions({
  actions,
  rowIds,
  selection,
}: {
  actions: readonly TableBulkActionDescriptor[];
  rowIds: readonly string[];
  selection: TableBulkSelectionControls;
}) {
  return (
    <>
      {actions.map((action) => (
        <Fragment key={action.id}>
          {action.render
            ? action.render({
                rowIds,
                selection,
                selectOption: (option) =>
                  Promise.resolve(
                    action.kind === "picker"
                      ? action.onSelect(rowIds, option, selection)
                      : false
                  ),
              })
            : renderRailBulkAction(action, rowIds, selection)}
        </Fragment>
      ))}
    </>
  );
}

function renderRailBulkAction(
  action: TableBulkActionDescriptor,
  rowIds: readonly string[],
  selection: TableBulkSelectionControls
): ReactNode {
  if (action.kind === "command") {
    return (
      <TableBulkActionButton
        disabled={action.isPending}
        label={action.label}
        onClick={() => action.onSelect(rowIds, selection)}
        pressed={action.pressed}
      >
        {action.icon}
      </TableBulkActionButton>
    );
  }
  return (
    <TableBulkActionPicker
      action={action}
      rowIds={rowIds}
      selection={selection}
    />
  );
}

function TableBulkActionPicker({
  action,
  rowIds,
  selection,
}: {
  action: TableBulkPickerDescriptor;
  rowIds: readonly string[];
  selection: TableBulkSelectionControls;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const matchingOptions = action.options.filter((option) =>
    option.label.toLowerCase().includes(normalizedQuery)
  );
  const canCreate = canCreateBulkOption(action, normalizedQuery);

  const settle = (applied: boolean) => {
    if (!applied) {
      return;
    }
    setOpen(false);
    setQuery("");
  };
  const choose = (option: TableBulkActionOption) => {
    settleWhenApplied(action.onSelect(rowIds, option, selection), settle);
  };
  const create = () => {
    settleWhenApplied(
      action.onCreateOption?.(query.trim(), rowIds, selection) ?? false,
      settle
    );
  };

  return (
    <Popover
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setQuery("");
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <button
          aria-label={action.label}
          className={TABLE_BULK_ACTION_BUTTON_CLASS_NAME}
          disabled={action.isPending}
          type="button"
        >
          {action.icon}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-64 p-2">
        {action.search ? (
          <Input
            aria-label={action.search.label}
            className="h-8"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={action.search.placeholder}
            value={query}
          />
        ) : null}
        <div
          className={cn("max-h-56 overflow-y-auto", action.search && "mt-2")}
        >
          {matchingOptions.map((option) => (
            <button
              aria-label={option.label}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              key={option.id}
              onClick={() => choose(option)}
              type="button"
            >
              {option.content ?? option.label}
            </button>
          ))}
          {canCreate ? (
            <button
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={create}
              type="button"
            >
              <PlusIcon className="size-4" />
              {action.createOptionLabel?.(query.trim())}
            </button>
          ) : null}
          {matchingOptions.length === 0 && !canCreate ? (
            <p className="px-2 py-3 text-muted-foreground text-sm">
              {action.emptyLabel}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function canCreateBulkOption(
  action: TableBulkPickerDescriptor,
  normalizedQuery: string
): boolean {
  // `createOptionLabel` is what NAMES the row, so a descriptor that omits it
  // gets no row rather than an icon-only button with no accessible name.
  if (
    !(action.onCreateOption && action.createOptionLabel) ||
    normalizedQuery.length === 0
  ) {
    return false;
  }
  return !action.options.some(
    (option) => option.label.toLowerCase() === normalizedQuery
  );
}

function settleWhenApplied(
  result: Promise<boolean> | boolean,
  settle: (applied: boolean) => void
) {
  Promise.resolve(result).then(settle, () => settle(false));
}

/** UI lifetime is independent of an already submitted command or mutation cache. */
export const TableBulkActionLifecycle = {
  Selection: "selection",
  Dispose: "dispose",
} as const;

export type TableBulkActionLifecycleEvent = {
  kind: (typeof TableBulkActionLifecycle)[keyof typeof TableBulkActionLifecycle];
  rowIds: readonly string[];
  selection: TableBulkSelectionControls;
};

/** Per-row settlement reported by a descriptor that owns its mutation response. */
export type TableBulkActionResult = {
  appliedIds: readonly string[];
  failedIds: readonly string[];
};
