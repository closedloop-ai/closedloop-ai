"use client";

import type { AgentComponent } from "@repo/api/src/types/agent-component";
import {
  formatLocPerDollarColumn,
  KPI_NO_VALUE,
} from "@repo/app/shared/lib/format-utils";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

/**
 * The LOC/$ table cell for the Agents inventory's Metric column.
 *
 * Lifted out of `lib/component-meta.tsx` (review cid 3701349992): this is a
 * props-in/markup-out presentational cell whose whole reason to exist is a set
 * of VISUAL states — the `—` for an unavailable value, `< 0.01` instead of a
 * false `0.00`, `tabular-nums` plus right-alignment
 * so a sorted column's decimals actually line up. Storybook only scans component
 * directories, so a canvas for those states means the cell living here rather
 * than under `lib/` (precedent:
 * `components/detail/session-loc-per-dollar-property.stories.tsx`).
 */

/**
 * ISS-4866: the Metric COLUMN's LOC/$ cell.
 *
 * ISS-5366 retired `agents-loc-per-dollar-display` to its enabled state, so this
 * is the only LOC/$ cell the Agents COLUMN renders: the adaptive
 * `LocPerDollarValue` component it used to alternate with is deleted. The column
 * commits to one decimal count so a sorted column can be scanned, and a real
 * sub-threshold value reads `< 0.01` rather than a false `0.00`.
 *
 * ISS-5475: a real value renders in the DEFAULT foreground — there are no tone
 * classes here any more. The removed classifier graded every figure
 * emerald/amber/rose off an unmeasured 4.1 baseline that no real catalog row
 * (~1–3) reached, so the column read as a solid stripe of red. The unavailable
 * value keeps its `—`.
 *
 * ISS-5366 (review cid 3737914548): the retirement is true of the COLUMN and
 * only of the column. The adaptive FORMATTER is not retired and is not going
 * away — `formatLocPerDollar` still renders LOC/$ on the same screen one level
 * up, at `agents-grouped-list.tsx` (the group summary card, over
 * `locPerDollar`) and `detail-data.ts`, plus Branches and Packs. So on a
 * group holding a single subagent at 0.0088, the card reads `0.0088` and the one
 * row it summarizes reads `< 0.01`. Neither string is false, but the summary is
 * more precise than its population.
 *
 * The split is deliberate, not drift. `< 0.01` exists because a fixed-2dp COLUMN
 * would otherwise print a false `0.00`, and the fixed precision exists so a
 * sorted column's decimal points line up — neither pressure applies to a single
 * KPI card, which has no column to line up with and can afford significant
 * digits. Read it as "one cell shape per column", never as "the adaptive path is
 * gone".
 *
 * The `—` branch below is Storybook-only in practice: the Agents table never
 * reaches this component with a `null`, because `agents-table.tsx` returns the
 * SHARED `GridEmptyValue` sentinel first (`isEmptyCellValue` identifies an empty
 * cell by element TYPE, and the narrow card drops empty rows on that test). The
 * branch stays so the cell is total over its own prop type and the canvas can
 * show the state — but production's Metric dash is owned by the table, not here.
 *
 * `alignEnd` is what makes that precision pay (review cid 3701359134): one fixed
 * decimal count plus `tabular-nums` gives every digit the same advance width,
 * but LEFT-aligned, `1,234.00` / `12.34` / `0.88` still land their decimal point
 * in three different places. `ml-auto` (not `text-right`) is the lever, because
 * the grid body cell is a flex row — and it is opt-in per mount site: the grid
 * row wants it, the narrow card renders this value inline beside the Type chip
 * where a stretch to the far edge would just orphan it.
 */
export const LocPerDollarColumnValue = ({
  value,
  alignEnd,
}: {
  value: number | null;
  alignEnd?: boolean;
}) => {
  if (value === null) {
    return (
      <span className={cn("text-muted-foreground", alignEnd && "ml-auto")}>
        {KPI_NO_VALUE}
      </span>
    );
  }
  return (
    <span className={cn("tabular-nums", alignEnd && "ml-auto")}>
      {formatLocPerDollarColumn(value)}
    </span>
  );
};

/**
 * The Metric COLUMN's cell — the value above plus the unavailable branch the
 * grid actually takes.
 *
 * NOT driven by `metricMode`, despite the prop of that name still threading
 * through `AgentsTable`'s props. ISS-4667 removed the inverted $/KLOC mode and
 * ISS-4866 removed the picker that selected between the survivors; ISS-5366 then
 * retired that gate, so the mode is no longer settable from any surface. The
 * prop and its persisted view dimension are left in place deliberately (a saved
 * view still carries them, and the ISS-4667 legacy-value migration still maps
 * them), but nothing here reads one.
 *
 * ISS-5532: lifted out of `agents-table.tsx`, which this ticket otherwise grew.
 * It belongs beside {@link LocPerDollarColumnValue} rather than in the table:
 * this pair IS the LOC/$ cell, and the note above about the dash being "owned by
 * the table, not here" was describing exactly this component sitting a file
 * away. One module now owns the column's whole cell shape.
 */
export const MetricCell = ({
  component,
  alignEnd,
}: {
  component: AgentComponent;
  /**
   * True on the grid row, where the polished column right-aligns so its one
   * fixed precision actually lines the decimals up. False/absent on the narrow
   * card, which renders this value inline beside the Type chip.
   */
  alignEnd?: boolean;
}): ReactNode => {
  const value = component.locPerDollar;
  // ISS-5333: every arm of this cell honors `alignEnd` — the null branch returns
  // BEFORE the value render, and leaving it unaligned once produced a left-flush
  // dash under right-flush numbers. Header, real values, and the unavailable
  // dash move together or not at all.
  if (value === null) {
    // The unavailable dash follows the column's alignment, same as `NumberCell`.
    // Deliberately still the SHARED `GridEmptyValue` sentinel and not
    // `<LocPerDollarColumnValue value={null} />` (which the ticket suggested):
    // `isEmptyCellValue` identifies an empty cell by element TYPE, and the
    // narrow card drops empty body rows on that test — returning a different
    // component here would grow every card a literal "Metric —" line.
    //
    // ISS-5475: that emptiness is NOT observable from the cell's call site.
    // `renderCell` hands back `<MetricCell …>` and this sentinel appears only
    // once the component renders, so `isEmptyCellValue` on the returned node
    // reports non-empty for a null row. `AgentCard`'s header, which does need to
    // know, reads `locPerDollar` directly rather than testing the node.
    return <GridEmptyValue alignEnd={alignEnd} />;
  }
  // ISS-4866: no `metricMode` switch. ISS-4667 removed the inverted $/KLOC mode,
  // leaving a two-arm switch whose arms returned the identical node — a per-mode
  // transform that no longer transformed. The metric has ONE unit and ONE
  // orientation (LOC/$, higher is better) on every surface; when a second mode
  // earns a different computation it brings its own branch back, along with the
  // picker this ticket also retires.
  return <LocPerDollarColumnValue alignEnd={alignEnd} value={value} />;
};
