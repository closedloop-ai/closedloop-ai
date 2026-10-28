"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { XIcon } from "lucide-react";

/**
 * The thin result-context strip: an honest count (`N`/`N+` while a cursor
 * remains) plus a Clear action, announced to assistive tech via `aria-live` so
 * a screen reader hears the count change on re-query.
 *
 * ISS-10345 moved this out of the Web host
 * (`apps/app/app/(authenticated)/[orgSlug]/search/components/search-results.tsx`)
 * and into the portable surface unchanged, so the prototype's demo host renders
 * the SAME strip the shipped page does rather than a second, drifting copy of
 * its sentence. The `+` is the whole point of the contract: the page knows how
 * many rows it has LOADED and not how many the corpus holds, so any host that
 * still has a cursor says `N+` and no host may assert a total it cannot
 * compute.
 */
export function SearchResultCountStrip({
  query,
  loadedCount,
  hasMore,
  isLoading,
  onClear,
}: Readonly<{
  query: string;
  loadedCount: number;
  hasMore: boolean;
  isLoading: boolean;
  onClear: () => void;
}>) {
  const countLabel = hasMore ? `${loadedCount}+` : String(loadedCount);
  const resultNoun = loadedCount === 1 && !hasMore ? "result" : "results";
  const text = isLoading
    ? `Searching for "${query}"…`
    : `${countLabel} ${resultNoun} for "${query}"`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-border border-b pb-2">
      <p className="text-muted-foreground text-sm">{text}</p>
      <span aria-live="polite" className="sr-only">
        {text}
      </span>
      <Button
        aria-label="Clear search"
        onClick={onClear}
        size="sm"
        type="button"
        variant="outline"
      >
        <XIcon className="size-3.5" />
        Clear
      </Button>
    </div>
  );
}
