/**
 * ISS-6241: the live maintenance step's position in its OWN population, stated
 * once for both surfaces that render it — the first-launch splash's Compute
 * checklist and the startup-readiness panel's Session views step.
 *
 * Design review: it was hand-rolled in both places and had already drifted
 * (`ml-auto` against `justify-between`, `items-center` against `items-baseline`)
 * before the change even landed. One unit, so the treatment cannot fork again.
 *
 * It sits NEXT TO its label, not flushed to the container edge: pushed right, the
 * number's distance from the label it describes is a function of window width
 * (measured at over 1,100px on the splash at 1440), and it lands on the same
 * right rail as the import's own transcript count — a different population read
 * as the same series.
 *
 * SESSIONS, not transcripts: the rebuild's population is the stale SESSION rows
 * it re-derives, which is not the source-file population the import counts (one
 * OpenCode source is a whole `opencode.db` holding many sessions). Naming it
 * after the import's noun would be the ISS-5281 conflation one stage later.
 *
 * `tabular-nums` so a per-session tick cannot reflow the row. No `shrink-0`: if
 * something has to give at a narrow width it is this supporting number, never
 * the step label it supports.
 */
export const SessionPopulationCount = ({
  processed,
  total,
}: {
  processed: number;
  total: number;
}) => (
  <span className="text-muted-foreground text-xs tabular-nums">
    {`${processed.toLocaleString()} of ${total.toLocaleString()} sessions`}
  </span>
);
