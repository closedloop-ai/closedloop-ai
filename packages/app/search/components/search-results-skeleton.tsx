"use client";

import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { Loader2Icon } from "lucide-react";

/**
 * Loading rows on the result-row rhythm, so the layout does not jump when hits
 * land. The spinner is what assistive tech hears; the bars are decorative.
 *
 * One module because both result surfaces render it while the
 * `portable-search-surface` flag is mid-rollout, and a loading rhythm that
 * drifts between the two branches is the divergence the shared surface exists
 * to end. The LABEL differs per surface, so it is the prop.
 */
export function SearchResultsSkeleton({
  loadingLabel,
}: Readonly<{ loadingLabel: string }>) {
  return (
    <>
      <Loader2Icon aria-label={loadingLabel} className="sr-only" />
      <ul aria-hidden="true" className="flex flex-col divide-y divide-border">
        {SKELETON_ROWS.map((row) => (
          <li className="flex gap-3 px-2 py-3" key={row}>
            <Skeleton className="mt-0.5 size-4 shrink-0 rounded-sm" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-32" />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

const SKELETON_ROWS = [0, 1, 2, 3, 4];
