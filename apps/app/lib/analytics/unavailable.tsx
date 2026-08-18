import { NO_VALUE } from "@/lib/analytics/format";

/**
 * The settled-unavailable state, shared by BOTH session-analytics screens
 * (ISS-4987 lost work, ISS-4988 TokenOps waste).
 *
 * "Settled unavailable" means the server listed the rollup's key in
 * `unavailableWidgets`, or its read failed. It is deliberately not the same
 * thing as loading, and emphatically not the same thing as zero: on screens
 * whose entire subject is failure, a fabricated `0` reads as "no problem here",
 * which is the worst thing either surface could say.
 *
 * Both variants share that contract — the em dash is `aria-hidden`, because on
 * its own it is read out as punctuation or skipped entirely, so the REASON
 * sentence is what carries the meaning for a screen reader. They differ only in
 * geometry, which is why there are two rather than one with a variant prop:
 * {@link UnavailableValue} stands in for a metric TILE's value and reserves
 * that slot's size, while {@link WidgetUnavailable} is an inline line of body
 * copy where a section's content would have been. Living in one module rather
 * than one copy per route directory is what keeps the two from drifting apart.
 */

/**
 * Tile-body variant: occupies a metric card's value slot, so the card keeps its
 * geometry instead of collapsing when the number never arrived.
 */
export function UnavailableValue({ reason }: { readonly reason: string }) {
  return (
    <div className="space-y-2">
      <div
        aria-hidden="true"
        className="font-normal text-3xl text-muted-foreground tracking-tight"
      >
        {NO_VALUE}
      </div>
      <p className="text-muted-foreground text-sm">{reason}</p>
    </div>
  );
}

/**
 * Inline variant: one quiet line where a section's content would have been.
 * Never a perpetual skeleton — a skeleton that never resolves claims the data
 * is still coming when it has already settled.
 */
export function WidgetUnavailable({ reason }: { readonly reason: string }) {
  return (
    <p className="text-muted-foreground text-sm">
      <span aria-hidden="true" className="mr-2">
        {NO_VALUE}
      </span>
      {reason}
    </p>
  );
}
