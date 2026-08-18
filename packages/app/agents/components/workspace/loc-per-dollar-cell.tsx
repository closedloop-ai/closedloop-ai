"use client";

import {
  formatLocPerDollarColumn,
  KPI_NO_VALUE,
} from "@repo/app/shared/lib/format-utils";
import { cn } from "@repo/design-system/lib/utils";

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
 * `avgLocPerDollar`) and `detail-data.ts`, plus Branches and Packs. So on a
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
