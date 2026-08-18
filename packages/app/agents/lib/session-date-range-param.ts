import { DATE_RANGES, type DateRange } from "../../shared/lib/format-utils";

/**
 * ISS-5355 — the Sessions listing's date window, as a URL param.
 *
 * The window used to live ONLY in per-viewer saved view state
 * (`useSessionsViewState`), which made every inbound link to Sessions
 * under-specified: the sender picked the rows, the recipient's saved range then
 * silently re-picked them. A count rendered elsewhere and the listing it links
 * to could therefore disagree with nothing on screen explaining why.
 *
 * Carrying it here makes a Sessions link fully self-describing. The param is
 * OPTIONAL: absent means "use the viewer's saved range", exactly as before, so
 * every existing link and bookmark keeps its behaviour.
 *
 * Deliberately a lightweight module (no zod, no hook): it is imported by
 * bundle-sensitive surfaces such as the project-detail strip, which must be able
 * to name the window without pulling the view-state hook into its bundle.
 */
export const SESSION_DATE_RANGE_PARAM = "range";

/**
 * The `?range=` value as a canonical {@link DateRange}, or `null` when the param
 * is absent or carries a value outside the contract. `null` is "the viewer's
 * saved range decides" — an unrecognised value must never narrow or widen the
 * listing on its own.
 */
export function parseSessionDateRangeParam(
  value: string | null | undefined
): DateRange | null {
  if (value == null) {
    return null;
  }
  const match = DATE_RANGES.find((range) => range === value);
  return match ?? null;
}
