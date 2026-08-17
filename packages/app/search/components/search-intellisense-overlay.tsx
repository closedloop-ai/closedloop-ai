"use client";

import { Chip } from "@repo/design-system/components/ui/chip";
import { Loader2Icon } from "lucide-react";
import type {
  IntellisenseRow,
  IntellisenseView,
} from "../hooks/use-search-intellisense";
import { IntellisenseMode } from "../lib/search-intellisense";

/**
 * FEA-3930 Slice 5, the presentational overlay for the inline filter
 * intellisense. Renders the active surface's rows (filter keys / enum values /
 * org members) as the ARIA listbox popup attached to the search combobox input.
 * The owning input keeps `role="combobox"` + `aria-activedescendant`; this
 * listbox is reached via that, not as a tab stop, matching the existing FTS
 * typeahead dropdown wiring. Loading/error/empty states are honest so the
 * async member/project fetches never leave the overlay lying about its state.
 */

type SearchIntellisenseOverlayProps = {
  view: IntellisenseView;
  /** Index of the keyboard-highlighted row, or -1 when none. */
  activeIndex: number;
  /** Stable id for the listbox, wired to the input via `aria-controls`. */
  listboxId: string;
  /** Build the per-option DOM id for `aria-activedescendant`. */
  optionId: (index: number) => string;
  /** Commit the row at `index` (mouse click). */
  onSelect: (index: number) => void;
};

const MODE_HEADINGS: Record<IntellisenseView["mode"], string | null> = {
  [IntellisenseMode.FilterKeys]: "Filters",
  [IntellisenseMode.StaticValues]: "Values",
  [IntellisenseMode.DynamicValues]: "Projects",
  [IntellisenseMode.Members]: "People",
  [IntellisenseMode.FreeText]: null,
};

export function SearchIntellisenseOverlay({
  view,
  activeIndex,
  listboxId,
  optionId,
  onSelect,
}: SearchIntellisenseOverlayProps) {
  const heading = MODE_HEADINGS[view.mode];

  return (
    <div className="absolute inset-x-2 top-full z-50 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-md">
      {view.isLoading && view.rows.length === 0 ? (
        <div className="flex items-center justify-center py-4">
          <Loader2Icon
            aria-label="Loading suggestions"
            className="size-4 animate-spin text-muted-foreground"
          />
        </div>
      ) : null}

      {view.isError ? (
        <p className="px-3 py-3 text-muted-foreground text-xs">
          Something went wrong loading suggestions. Try again.
        </p>
      ) : null}

      {!(view.isLoading || view.isError) && view.rows.length === 0 ? (
        <p className="px-3 py-3 text-muted-foreground text-xs">No matches</p>
      ) : null}

      {view.rows.length > 0 ? (
        <ul
          aria-label={heading ?? "Suggestions"}
          className="max-h-80 overflow-auto py-1"
          id={listboxId}
          // The owning input carries role="combobox" + aria-controls to this id;
          // interactivity stays on that input via aria-activedescendant, so this
          // ARIA listbox popup is intentional.
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: intentional ARIA combobox listbox popup, see note above.
          role="listbox"
        >
          {view.rows.map((row, index) => (
            <IntellisenseOption
              activeId={optionId(index)}
              isActive={index === activeIndex}
              key={rowKey(row)}
              onSelect={() => onSelect(index)}
              row={row}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function IntellisenseOption({
  row,
  activeId,
  isActive,
  onSelect,
}: Readonly<{
  row: IntellisenseRow;
  activeId: string;
  isActive: boolean;
  onSelect: () => void;
}>) {
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: DOM focus stays on the combobox input; this option is reached via aria-activedescendant, not a tab stop.
    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the option role is the required ARIA listbox child; the row's interactivity is the inner button, focus stays on the combobox input.
    <li aria-selected={isActive} id={activeId} role="option">
      <button
        className={
          isActive
            ? "flex w-full items-center bg-muted px-3 py-2 text-left focus-visible:outline-none"
            : "flex w-full items-center px-3 py-2 text-left hover:bg-muted focus-visible:outline-none"
        }
        // Commit on mousedown (before the input blur closes the overlay) so the
        // click always lands on the intended row.
        onMouseDown={(event) => {
          event.preventDefault();
          onSelect();
        }}
        tabIndex={-1}
        type="button"
      >
        <OptionBody row={row} />
      </button>
    </li>
  );
}

function OptionBody({ row }: Readonly<{ row: IntellisenseRow }>) {
  if (row.kind === "key") {
    return (
      <span className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground text-sm">
          {row.suggestion.meta.label}
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {row.suggestion.operators.join(" ")}
        </span>
      </span>
    );
  }

  if (row.kind === "member" || row.kind === "dynamic-value") {
    return (
      <span className="flex flex-col">
        <span className="truncate font-medium text-foreground text-sm">
          {row.option.label}
        </span>
        {row.option.detail ? (
          <span className="truncate text-muted-foreground text-xs">
            {row.option.detail}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <Chip size="sm" variant="muted">
      {row.value}
    </Chip>
  );
}

function rowKey(row: IntellisenseRow): string {
  if (row.kind === "key") {
    return `key:${row.suggestion.meta.key}`;
  }
  if (row.kind === "member") {
    return `member:${row.option.value}`;
  }
  if (row.kind === "dynamic-value") {
    return `dynamic:${row.option.value}`;
  }
  return `value:${row.value}`;
}
