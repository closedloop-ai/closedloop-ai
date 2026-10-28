"use client";

// Grid Table Toolbar v2 promotion candidate, derived from the approved Generic
// Artifact prototype's list shell.

import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { GridTableListSurfaceMode } from "./grid-table-list-surface";
import { type FocusEvent, type ReactNode, useLayoutEffect, useRef } from "react";

/**
 * The layout shell every v2 grid-table toolbar composes (ISS-7051).
 *
 * It owns ONLY layout — no filter state, no column state, no data. The controls
 * are slots, because the three production surfaces that will use it
 * (Generic Artifact, Sessions, Branches) share a spine but genuinely differ in
 * what hangs off it: Sessions has group-by and a chip row and no saved views,
 * Branches has saved views and a read-source badge and no chip row, the
 * prototype has a layout toggle and an Add-field button. A props-per-control
 * component would have to grow a prop for each of those and a boolean for each
 * surface; slots let a surface pass what it has.
 *
 * The spine, left to right: `leading` (date range, filter) → `primary` →
 * `secondary` pushed right → `trailing`. Beneath the row, `activeFilters`.
 *
 * Two layout details here are load-bearing rather than cosmetic:
 *
 *  - `min-w-min` on the control row is a WRAP FLOOR. Without it a flex row in a
 *    narrow container will shrink its children below their intrinsic width
 *    instead of wrapping, so the controls clip rather than reflow. Sessions'
 *    toolbar has it (see its `BelowWrapFloor` story) and Branches' does not;
 *    this adopts it as the default because the Branches omission is accidental.
 *  - `compact` and `expanded` are separate slots rather than one slot styled
 *    responsively, because the narrow layout is not the wide layout rearranged.
 *    Existing callers use viewport CSS; a measured list surface supplies mode
 *    to mount only its active slot.
 *    The prototype folds Sort + Grouping + Summary cards + Show/hide columns
 *    into ONE menu below `md` — a different control, not a smaller one.
 */
export function GridTableToolbar({
  activeFilters,
  className,
  compact,
  expanded,
  leading,
  mode,
  primary,
  trailing,
}: {
  /**
   * Full-width row beneath the controls, for the removable active-filter chips
   * (`ActiveFiltersBar`). Render nothing when no filter is active — an empty
   * chip row still costs vertical space on every list in the product.
   */
  activeFilters?: ReactNode;
  className?: string;
  /**
   * Right cluster below the `md` breakpoint. Typically ONE folded menu
   * (`TableCompactViewMenu`) rather than the `expanded` controls shrunk down.
   */
  compact?: ReactNode;
  /** Right cluster at `md` and above — the sort / group / options / views menus. */
  expanded?: ReactNode;
  /** Left of the row: the date-range control and the filter popover. */
  leading?: ReactNode;
  /** When supplied, render only the slot selected by the measured list surface. */
  mode?: GridTableListSurfaceMode;
  /**
   * Between `leading` and the right cluster, at every width. Use for a control
   * that must stay visible when the row folds (a scope switcher) — anything in
   * `expanded` disappears below `md`. No shipped surface fills it today; ISS-8633
   * retired the layout toggle that was this slot's original occupant.
   */
  primary?: ReactNode;
  /** After both clusters, at every width — typically the primary page action. */
  trailing?: ReactNode;
}) {
  const compactRef = useRef<HTMLDivElement>(null);
  const expandedRef = useRef<HTMLDivElement>(null);
  const focusedSlot = useRef<GridTableListSurfaceMode | null>(null);
  const slotFocusGeneration = useRef(0);
  const previousMode = useRef(mode);

  useLayoutEffect(() => {
    if (
      mode &&
      previousMode.current &&
      mode !== previousMode.current &&
      focusedSlot.current === previousMode.current &&
      globalThis.document.activeElement === globalThis.document.body
    ) {
      const incoming = mode === "compact" ? compactRef.current : expandedRef.current;
      incoming
        ?.querySelector<HTMLElement>("button:not(:disabled), [role='combobox'], a[href]")
        ?.focus();
    }
    previousMode.current = mode;
  }, [mode]);

  const onSlotBlur = (
    event: FocusEvent<HTMLDivElement>,
    slot: GridTableListSurfaceMode
  ) => {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    if (event.relatedTarget) {
      focusedSlot.current = null;
      return;
    }
    const generation = slotFocusGeneration.current;
    globalThis.queueMicrotask(() => {
      if (slotFocusGeneration.current === generation && focusedSlot.current === slot) {
        focusedSlot.current = null;
      }
    });
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex min-w-min flex-wrap items-center gap-2">
        {leading}
        {primary}
        {expanded && mode !== "compact" ? (
          // ISS-10361 (tamsinb review): the two slots hold the SAME controls at
          // two widths, so both are in the DOM at once and a page- or
          // container-level query for one of them is ambiguous rather than
          // wrong-looking — `getByRole("button", { name: "Options" })` resolves
          // two whenever the surface wires no sort/group cluster. These name
          // which width a query means. `data-slot` because that is how this
          // catalog already labels a composite's parts.
          <div
            className={cn(
              "ml-auto flex-wrap items-center justify-end gap-2",
              mode ? "flex" : "hidden md:flex"
            )}
            data-slot={GRID_TABLE_TOOLBAR_EXPANDED_SLOT}
            onBlurCapture={(event) => onSlotBlur(event, "expanded")}
            onFocusCapture={() => {
              slotFocusGeneration.current += 1;
              focusedSlot.current = "expanded";
            }}
            ref={expandedRef}
          >
            {expanded}
          </div>
        ) : null}
        {compact && mode !== "expanded" ? (
          <div
            className={cn(
              "ml-auto flex-wrap items-center justify-end gap-2",
              mode ? "flex" : "flex md:hidden"
            )}
            data-slot={GRID_TABLE_TOOLBAR_COMPACT_SLOT}
            onBlurCapture={(event) => onSlotBlur(event, "compact")}
            onFocusCapture={() => {
              slotFocusGeneration.current += 1;
              focusedSlot.current = "compact";
            }}
            ref={compactRef}
          >
            {compact}
          </div>
        ) : null}
        {trailing}
      </div>
      {activeFilters}
    </div>
  );
}

/** The wide cluster, shown at `md` and above. @see GridTableToolbar */
export const GRID_TABLE_TOOLBAR_EXPANDED_SLOT = "grid-table-toolbar-expanded";

/** The narrow fold, shown below `md`. @see GridTableToolbar */
export const GRID_TABLE_TOOLBAR_COMPACT_SLOT = "grid-table-toolbar-compact";
