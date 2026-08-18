import { formatTime } from "@repo/app/shared/lib/date-utils";

/**
 * Format a session-timeline marker timestamp for display.
 *
 * Accepts `unknown` on purpose: the values reaching it come off a synced detail
 * payload (`marker.t`, `throttle.t0`, `source.observedAt`, `event.createdAt`,
 * `item.t`), which is JSON from a peer repo on its own release cadence. A field
 * that arrives missing, numeric, or as an unparseable string degrades to the
 * original text (or an empty label) rather than throwing inside a render.
 *
 * ISS-5566: lifted out of `agent-session-detail-view.tsx` so the extracted
 * bucket-synthesis module can label its buckets from the SAME formatter the
 * view's markers use, instead of the two drifting apart.
 */
export function formatMarkerTime(value: unknown): string {
  if (value instanceof Date) {
    return formatTime(value, { includeSeconds: true });
  }
  if (typeof value !== "string") {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return formatTime(date, { includeSeconds: true });
}
