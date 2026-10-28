"use client";

import type { ReactNode } from "react";

/**
 * One labelled fact in the Branch detail's "Checks & review" box. Shared so the
 * live and measured checks statements state themselves in the same shape rather
 * than each re-declaring the row's markup (ISS-8241).
 */
export function BranchPrStatusRow({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}
