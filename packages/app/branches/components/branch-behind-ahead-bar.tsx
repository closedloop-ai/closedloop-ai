"use client";

import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Behind/ahead magnitude pair (Epic B / B3), sized for the list's 120px column
 * and reused by the Epic D detail panel. Behind/ahead are a single gated pair
 * with NO v1 producer, so the `null` path — the empty-value affordance, never a
 * fabricated 0 — is the default rendered state today.
 */
export type BranchBehindAheadBarProps = {
  behind: number | null;
  ahead: number | null;
};

export function BranchBehindAheadBar({
  behind,
  ahead,
}: BranchBehindAheadBarProps): ReactNode {
  if (behind == null || ahead == null) {
    return <GridEmptyValue />;
  }
  return (
    <span className="flex items-center gap-2 font-mono text-muted-foreground text-xs">
      <span className="flex items-center">
        <ArrowDownIcon className="size-3" />
        {behind}
      </span>
      <span className="flex items-center">
        <ArrowUpIcon className="size-3" />
        {ahead}
      </span>
    </span>
  );
}
