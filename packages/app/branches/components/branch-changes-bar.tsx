"use client";

import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import type { ReactNode } from "react";

/**
 * Additions/deletions changes bar (Epic B / B3), sized for the list's 130px
 * column and reused by the Epic D detail panel. additions/deletions come from
 * enrichment columns that are NULL until FEA-1899 populates them, so the `null`
 * path renders the empty-value affordance — never a fabricated +0/−0.
 *
 * The design-system `SegmentedBar` carries a multi-column legend that overflows
 * a table cell, so this composes a compact inline proportion bar instead.
 */
export type BranchChangesBarProps = {
  additions: number | null;
  deletions: number | null;
};

export function BranchChangesBar({
  additions,
  deletions,
}: BranchChangesBarProps): ReactNode {
  if (additions == null || deletions == null) {
    return <GridEmptyValue />;
  }
  const total = additions + deletions;
  const additionsPct = total > 0 ? (additions / total) * 100 : 0;
  const deletionsPct = total > 0 ? (deletions / total) * 100 : 0;
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-2 font-mono text-xs tabular-nums">
        <span className="text-emerald-600 dark:text-emerald-400">
          +{additions}
        </span>
        <span className="text-rose-600 dark:text-rose-400">−{deletions}</span>
      </span>
      <span className="flex h-1 w-full overflow-hidden rounded-full bg-muted/50">
        <span
          className="bg-emerald-500"
          style={{ width: `${additionsPct}%` }}
        />
        <span className="bg-rose-500" style={{ width: `${deletionsPct}%` }} />
      </span>
    </span>
  );
}
