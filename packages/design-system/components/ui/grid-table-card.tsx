"use client";

/**
 * The narrow-surface CARD half of the `GridTable` primitive (FEA-3865), plus the
 * shared empty-value sentinel both halves read.
 *
 * Split out of `grid-table.tsx` (ISS-5813) so that file could take the width
 * budget without growing: the grid path and the card path share only the column
 * descriptors and this sentinel, so they are two responsibilities, not one.
 * Every symbol here is re-exported from `grid-table.tsx`, so no consumer's
 * import path changes — the compatibility surface is deliberately unchanged.
 *
 * The `GridTableColumn` import is type-only and therefore erased, so this
 * module and `grid-table.tsx` re-exporting from it form no runtime cycle.
 */

import { isValidElement, type ReactNode } from "react";
import { Card, CardContent, CardHeader } from "./card";
import type { GridTableColumn } from "./grid-table";
import { cn } from "@closedloop-ai/design-system/lib/utils";

/**
 * The shared "this cell has no value" em-dash.
 *
 * ISS-5333 contrast: was `text-muted-foreground/50` — rgb(170,170,170) on
 * rgb(251,251,251), 2.24:1, under even the 3:1 non-text floor, while the muted
 * labels beside it sit near 6:1. The one glyph separating "no number" from
 * "zero" must not be the least visible thing in the row, so the `/50` is gone
 * and the dash renders at the full `--muted-foreground` token every other muted
 * label is already held to (WCAG 1.4.3, ≥4.5:1 in both themes).
 *
 * ISS-5333 alignment: `alignEnd` pushes the dash to the end of its cell with
 * `ml-auto` (the body cell is a flex row, so `text-right` is inert), so under a
 * right-aligned numeric column the dash sits below the digits it stands in for.
 * Opt-in and grid-only — position is not value, and the narrow card renders
 * inline beside its labels where a stretch to the far edge would orphan it.
 *
 * ISS-5009 (`title`): a bare em-dash says "no value" but not *why*, so a caller
 * that knows the reason passes it as hover/assistive text on the glyph itself.
 * Orthogonal to the two above — a cell may explain itself, align to the end, or
 * do both.
 */
export function GridEmptyValue({
  alignEnd,
  className,
  disabled,
  focusVisible,
  selected,
  title,
}: GridEmptyValueProps = {}) {
  // `data-slot` (the house convention across these primitives) is the stable
  // hook a consuming surface needs to re-sink the dash into its own type
  // scale. The `text-sm` default is sized for the grid this was written for;
  // panes that run at a different size scope a rule to this slot rather than
  // forking the component or threading a className through every call site.
  return (
    <span
      className={cn(
        "text-muted-foreground text-sm",
        alignEnd && "ml-auto",
        (disabled || focusVisible || selected) && "rounded-sm",
        disabled && "pointer-events-none opacity-50",
        focusVisible && "ring-2 ring-ring ring-inset",
        selected && "bg-primary/10 text-foreground",
        className
      )}
      aria-disabled={disabled ? true : undefined}
      data-cell-disabled={disabled ? true : undefined}
      data-cell-focus-visible={focusVisible ? true : undefined}
      data-cell-selected={selected ? true : undefined}
      data-slot="grid-empty-value"
      title={title}
    >
      {GRID_EMPTY_VALUE_GLYPH}
    </span>
  );
}

type GridEmptyValueProps = {
  alignEnd?: boolean;
  className?: string;
  disabled?: boolean;
  focusVisible?: boolean;
  selected?: boolean;
  title?: string;
};

/**
 * True when a cell value is the shared empty-value sentinel (`GridEmptyValue`)
 * or renders nothing (`null`/`undefined`). On the grid an em-dash reads as "no
 * value in this column"; stacked down a card, a run of "Model —", "PR —" lines
 * reads as a broken card, so the card builder drops these rows instead of
 * listing them (see `GridTableCard`).
 */
export function isEmptyCellValue(value: ReactNode): boolean {
  if (value == null) {
    return true;
  }
  return isValidElement(value) && value.type === GridEmptyValue;
}

/**
 * One key/value line in a `GridTableCard` body. `label` is the column name; the
 * `value` is whatever the caller's cell renderer returns for that row (a chip, a
 * status badge, plain text). Skip a row entirely rather than passing an empty
 * value so the card body has no blank lines.
 */
export type GridTableCardField = {
  key: string;
  label: string;
  value: ReactNode;
};

/**
 * The card a `GridTable` renders per row on narrow surfaces (FEA-3865). The lead
 * cell becomes the card header (name + status); the remaining columns become a
 * two-column key/value body. Built on the shared `Card` so radius, border, and
 * background match every other card in the product — consumers supply only the
 * header content and the field list, never bespoke card chrome.
 *
 * Spacing rhythm (deliberate, defined once here): a mobile *list* card is denser
 * than a standalone content Card — `gap-3 py-4` with `px-4` on header/content,
 * vs the product's default `gap-6 py-6 px-6` — so a scrolled list of rows stays
 * scannable without wasting vertical space per row. This is THE canonical
 * mobile-list card: every table→card fallback composes it rather than hand-
 * rolling a divergent rhythm, so the density is picked once and can't drift.
 */
export function GridTableCard({
  header,
  fields,
}: {
  header: ReactNode;
  fields: readonly GridTableCardField[];
}) {
  // Drop fields whose cell renders empty (the em-dash sentinel or nothing): on a
  // card a stack of "Model —", "PR —" lines reads as broken, so a session/branch
  // missing its optional columns shows only the columns it actually has.
  const populatedFields = fields.filter(
    (field) => !isEmptyCellValue(field.value)
  );
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">{header}</CardHeader>
      {populatedFields.length > 0 ? (
        <CardContent className="px-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            {populatedFields.map((field) => (
              <div className="flex min-w-0 flex-col gap-0.5" key={field.key}>
                <dt className={CARD_FIELD_TERM_CLASS}>{field.label}</dt>
                <dd className={CARD_FIELD_VALUE_CLASS}>{field.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      ) : null}
    </Card>
  );
}

/**
 * Build a `GridTableCard`'s key/value body from the table's columns (FEA-3865).
 * Every table→card fallback derives its body identically: take the table's
 * columns, drop the ids the card promotes into its header (status + row
 * actions), then map each remaining column to a `{ key, label, value }` field
 * whose value comes from the table's own `renderCell` so the card and the grid
 * row never drift. Centralized here so this contract — and any future change to
 * it — lives once instead of being copy-pasted into each card component.
 *
 * ISS-5813: the card body is deliberately built from the columns the CALLER
 * declared, not from the grid's post-budget set. A collapsed column is a
 * statement about horizontal room, and a card has none to run out of — it
 * stacks — so the narrow surface keeps every value the wide one had to drop.
 */
export function buildGridTableCardFields<T>(
  columns: readonly GridTableColumn[],
  excludeIds: ReadonlySet<string>,
  renderCell: (columnId: string, item: T) => ReactNode,
  item: T
): GridTableCardField[] {
  return columns
    .filter((column) => !excludeIds.has(column.id))
    .map((column) => ({
      key: column.id,
      label: cardFieldLabel(column),
      value: renderCell(column.id, item),
    }));
}

/**
 * Build the label/value pairs a card promotes into its HEADER, in the order the
 * caller names them (ISS-5532). The inverse selection of
 * {@link buildGridTableCardFields}: that one takes what is left after the header
 * ids are removed, this one takes exactly those ids.
 *
 * `includeIds` is an ordered list rather than a set because the header is a
 * hand-composed line — the caller decides which attribute leads — where the body
 * follows the table's own column order. An id absent from `columns` is skipped,
 * so an attribute the grid dropped cannot resurface on the card.
 *
 * A caller whose empty state is produced INSIDE its cell component (rather than
 * returned as the shared sentinel) must omit that id here: `isEmptyCellValue`
 * matches on element type and cannot see through such a component.
 */
export function buildGridTableCardHeaderFields<T>(
  columns: readonly GridTableColumn[],
  includeIds: readonly string[],
  renderCell: (columnId: string, item: T) => ReactNode,
  item: T
): GridTableCardField[] {
  return includeIds
    .map((id) => columns.find((column) => column.id === id))
    .filter((column) => column !== undefined)
    .map((column) => ({
      key: column.id,
      label: cardFieldLabel(column),
      value: renderCell(column.id, item),
    }));
}

/**
 * The headline attributes a `GridTableCard` shows under its name lead, as an
 * inline definition list (ISS-5532).
 *
 * A card has no column header row, so a value promoted into the header arrives
 * with nothing naming it: the Agents card opened `Tool —`, a type word and a
 * dash, with nothing saying what the dash was the absence of. Every promoted
 * value is therefore paired with its own column's label, in the SAME `dt`/`dd`
 * relationship the card body already uses — so the pairing is announced to
 * assistive tech (WCAG 1.3.1 Info and Relationships) and not merely implied by
 * proximity, and so the label can never drift from the grid header that names
 * the same column.
 *
 * Empty values drop with their label, for the reason the body drops them: a
 * labelled dash still says less than nothing here, because the header is the
 * first line of the card. Renders nothing at all when that leaves no pairs.
 *
 * The `dd` carries no size of its own, unlike the body's. A promoted value
 * inherits the card header's scale, which is what keeps it PROMOTED — sinking it
 * to the body's `text-sm` measured as a 16px→13px drop on the Agents metric,
 * turning the one foreground number in the header into another body field that
 * happened to sit above the divider (design review, 2026-08-23). The term is
 * shared with the body, because a label must read the same wherever it appears;
 * the value deliberately is not.
 *
 * A field with no label drops too — the one place this deliberately DIFFERS from
 * the body. The body tolerates a blank term (ISS-4672: no borrowed chrome), but
 * naming is this component's entire job, so a `<dt></dt><dd>value</dd>` here
 * would ship the exact anonymous value ISS-5532 exists to remove, and ship it
 * announced as a term/value pair, which is worse than the state before it.
 */
export function GridTableCardHeaderFields({
  fields,
}: {
  fields: readonly GridTableCardField[];
}) {
  const populatedFields = fields.filter(
    (field) => field.label !== "" && !isEmptyCellValue(field.value)
  );
  if (populatedFields.length === 0) {
    return null;
  }
  return (
    <dl className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
      {populatedFields.map((field) => (
        <div className="flex min-w-0 items-center gap-1.5" key={field.key}>
          <dt className={CARD_FIELD_TERM_CLASS}>{field.label}</dt>
          <dd className="flex min-w-0 items-center">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A column's card `dt` term. A label-less column gets it from `cardLabel` — a
 * real, human-visible label the caller opts into for the card — NOT from
 * `ariaLabel`. The accessible name (e.g. "Actions") names a grid track for
 * assistive tech, and on the narrow card (no header row to read against) that
 * term does no work as a visible dt, so a column that wants a card term picks a
 * genuine label instead. Omitted `cardLabel` ⇒ a blank term rather than borrowed
 * chrome (ISS-4672).
 *
 * ONE function, called by both builders: the body term and the header term must
 * not resolve the same column's name two different ways, which is the very drift
 * `GridTableCardHeaderFields` claims to prevent.
 */
function cardFieldLabel(column: GridTableColumn): string {
  return column.label || (column.cardLabel ?? "");
}

/**
 * The TERM treatment, shared by the card body and its header pairs so one label
 * cannot read two ways depending on where it sits. The value class is BODY-ONLY
 * — see `GridTableCardHeaderFields` for why a promoted value must not be sunk to
 * it.
 */
const CARD_FIELD_TERM_CLASS = "text-muted-foreground text-xs";
const CARD_FIELD_VALUE_CLASS = "flex min-w-0 items-center text-sm";

export const GRID_EMPTY_VALUE_GLYPH = "—";
