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
  title,
}: { alignEnd?: boolean; title?: string } = {}) {
  return (
    // `data-slot` (the house convention across these primitives) is the stable
    // hook a consuming surface needs to re-sink the dash into its own type
    // scale. The `text-sm` default is sized for the grid this was written for;
    // panes that run at a different size scope a rule to this slot rather than
    // forking the component or threading a className through every call site.
    <span
      className={cn("text-muted-foreground text-sm", alignEnd && "ml-auto")}
      data-slot="grid-empty-value"
      title={title}
    >
      —
    </span>
  );
}

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
                <dt className="text-muted-foreground text-xs">{field.label}</dt>
                <dd className="flex min-w-0 items-center text-sm">
                  {field.value}
                </dd>
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
      // A label-less column the caller did not exclude gets its card `dt` term
      // from `cardLabel` — a real, human-visible label the caller opts into for
      // the card body — NOT from `ariaLabel`. The accessible name (e.g.
      // "Actions") names a grid track for assistive tech, and on the narrow card
      // (no header row to read against) that term does no work as a visible dt,
      // so a column that wants into the card body picks a genuine label instead.
      // Omitted `cardLabel` ⇒ a blank term rather than borrowed chrome (ISS-4672).
      label: column.label || (column.cardLabel ?? ""),
      value: renderCell(column.id, item),
    }));
}
