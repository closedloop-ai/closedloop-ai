"use client";

import { FIRST_COLUMN_INDEX } from "@closedloop-ai/design-system/lib/grid-table-aria";
import { GRID_NAV_CELL_ROLE } from "@closedloop-ai/design-system/lib/grid-table-navigation";
import {
  type GridTableAfterRowContextValue,
  useGridTableAfterRow,
} from "@closedloop-ai/design-system/lib/grid-table-v2-after-row";
import { LEAD_CELL_COLUMN_KEY } from "@closedloop-ai/design-system/lib/grid-table-v2-rows";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Input } from "./input";

export function TableInlineCreateRow({
  active,
  gridTemplateColumns,
  label,
  onActivate,
  onCancel,
  onCommit,
  placeholder = "Name",
}: {
  active: boolean;
  gridTemplateColumns: string;
  label: string;
  onActivate: () => void;
  onCancel: () => void;
  onCommit: (title: string) => void | Promise<unknown>;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const [isPending, setIsPending] = useState(false);
  // Null when this row is not inside a `GridTableV2` body, such as a standalone
  // story. A `role="row"` with no owning grid is the same orphan in the
  // accessibility tree that the roles exist to fix, so the roles are published
  // only where a grid actually owns this node.
  const grid = useGridTableAfterRow();

  useEffect(() => {
    if (active) {
      inputRef.current?.focus();
    } else {
      setDraft("");
    }
  }, [active]);

  const commit = async () => {
    const title = draft.trim();
    if (!title || pending.current) {
      return;
    }
    pending.current = true;
    setIsPending(true);
    try {
      await onCommit(title);
      setDraft("");
      globalThis.requestAnimationFrame(() => inputRef.current?.focus());
    } catch {
      // The host owns failure feedback. Keep the draft for its retry path.
    } finally {
      pending.current = false;
      setIsPending(false);
    }
  };

  return (
    <div
      aria-rowindex={grid?.ariaRowIndex}
      className={cn(
        "grid h-11 items-center border-b bg-background",
        grid?.isNarrowList ? "w-full min-w-0" : "min-w-fit"
      )}
      data-grid-row={grid ? "" : undefined}
      data-grid-row-id={grid?.rowId}
      data-inline-create-row=""
      role={grid ? "row" : undefined}
      style={{
        gridTemplateColumns: grid?.gridTemplateColumns ?? gridTemplateColumns,
      }}
    >
      {grid?.isNarrowList ? null : <div aria-hidden />}
      <div
        className="flex h-full min-w-0 items-center pr-3 pl-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        {...buildContentCellProps(grid)}
      >
        {active ? (
          <Input
            aria-label={`${label} name`}
            aria-busy={isPending}
            readOnly={isPending}
            className="h-8 w-full"
            onBlur={() => {
              if (!draft.trim()) {
                onCancel();
              }
            }}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setDraft("");
                onCancel();
              }
            }}
            placeholder={placeholder}
            ref={inputRef}
            value={draft}
          />
        ) : (
          <button
            className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-muted-foreground text-sm hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onActivate}
            type="button"
          >
            <PlusIcon className="size-3.5" />
            {label}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * `aria-colindex` of the wide affordance. Its empty leading track puts content
 * in the second track; narrow mode removes that spacer and uses the grid's
 * identity column instead.
 */
const CONTENT_COLUMN_INDEX = FIRST_COLUMN_INDEX + 1;

/**
 * The affordance's cell — the row's ONLY cell. The empty track before it stays
 * the `aria-hidden` presentational div it has always been rather than becoming
 * a second `gridcell`: it holds nothing, so making it navigable would buy a
 * keyboard stop that announces "blank" and offers no way forward. This is what
 * the grid's own section-header row does with the tracks it does not fill.
 *
 * No `aria-colspan` either: the cell paints in one track, and claiming the data
 * columns it does not cover would announce a shape the screen does not have.
 */
function buildContentCellProps(grid: GridTableAfterRowContextValue | null) {
  if (!grid) {
    return {};
  }
  return {
    "aria-colindex": grid.isNarrowList
      ? FIRST_COLUMN_INDEX
      : CONTENT_COLUMN_INDEX,
    role: GRID_NAV_CELL_ROLE,
    ...grid.getCellProps(LEAD_CELL_COLUMN_KEY),
  } as const;
}
