"use client";

import { formatRelativeTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import { Chip } from "@repo/design-system/components/ui/chip";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import type { ActivityChange } from "./activity-formatting";

/**
 * One Asana-style activity row, presentation only. Header: the actor slot +
 * relative timestamp. Body: a plain-language action headline, then an optional
 * before→after pair rendered as two chips joined by an arrow. Built entirely
 * from design-system primitives + tokens — no hand-rolled surfaces.
 *
 * Split out of `ActivityCard` so the row's presentational contract (chip
 * truncation, the pending skeleton's reserved geometry, the conditional arrow,
 * the struck-through "before" side) is mountable without a query provider and
 * can be pinned in Storybook. The container owns every lookup; nothing here
 * fetches.
 */
export function ActivityCardView({
  actor,
  createdAt,
  headline,
  change,
  pending,
}: Readonly<{
  actor: ReactNode;
  createdAt: Date;
  headline: string;
  change: ActivityChange;
  /** A directory lookup this row's values depend on has not settled yet. */
  pending: boolean;
}>) {
  const hasChange = change.before !== null || change.after !== null;

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        {actor}
        <time
          className="shrink-0 text-muted-foreground text-xs"
          dateTime={createdAt.toISOString()}
        >
          {formatRelativeTimeOrFallback(createdAt)}
        </time>
      </div>
      <p className="mt-2 text-foreground text-sm">{headline}</p>
      {hasChange ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <ChangeValue pending={pending} replaced value={change.before} />
          {change.before !== null && change.after !== null ? (
            <ArrowRight
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground"
            />
          ) : null}
          <ChangeValue pending={pending} value={change.after} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One side of a before→after pair. `replaced` is the struck-through "before"
 * side; the plain one is the value that now applies.
 *
 * A long value (a renamed title) is truncated inside the pill so the cut
 * carries an ellipsis instead of slicing mid-word — the full string stays in
 * the DOM, so assistive tech and copy still get all of it, and `title` puts it
 * behind a hover for sighted pointer users, who otherwise see two identical
 * "Add sess…" pills either side of an arrow and learn nothing from the row.
 */
function ChangeValue({
  value,
  replaced = false,
  pending,
}: Readonly<{ value: string | null; replaced?: boolean; pending: boolean }>) {
  if (value === null) {
    return null;
  }
  if (pending) {
    // Reserve the chip's real geometry so the row does not reflow when the
    // name arrives.
    return <Skeleton className="h-5 w-24 rounded-full" />;
  }
  return (
    <Chip
      className={replaced ? "line-through" : undefined}
      size="sm"
      variant={replaced ? "muted" : "accent"}
    >
      <span className="min-w-0 truncate" title={value}>
        {value}
      </span>
    </Chip>
  );
}
