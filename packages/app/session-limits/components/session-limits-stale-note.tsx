import { selectSessionLimitStaleCaveat } from "../lib/freshness";

export type SessionLimitsStaleNoteProps = {
  /** The snapshot's capture time (ISO-8601), or null when unknown. */
  fetchedAt: string | null;
  now?: Date;
  /** Injectable time zone so tests are not hostage to the runner's TZ. */
  timeZone?: string;
};

/**
 * The "these figures are from a moment ago, not from now" caveat (PRD-538 R6).
 *
 * A snapshot that stopped refreshing still holds real numbers, so blanking it
 * would throw away good data — but presenting it unlabeled would assert a
 * currency it does not have. Dating it to its capture time is the honest third
 * option, and it is a distinct state from loading (no data yet) and from a
 * measured 0% (current data that happens to be zero).
 *
 * Renders nothing while the snapshot is current, or when there is no capture
 * time to date it to — claiming staleness without a timestamp would be its own
 * invention.
 *
 * The wording comes from {@link selectSessionLimitStaleCaveat}, shared with the
 * drawer's provenance footer and with the trigger button's accessible name so
 * the same fact is not phrased two different ways in three places. It states the
 * age and stops there: "not updating" described the mechanism rather than the
 * consequence and read like an error to act on.
 *
 * Not italic — nothing else in this slice is, so it read as a typographic
 * exception rather than as emphasis. `font-medium` in its place, because
 * dropping the italic alone would leave this indistinguishable from the per-bar
 * "Resets …" lines it sits under, and it is not a per-bar detail: it qualifies
 * every figure above it. Its separation from those lines is the trigger's own
 * `gap-2`, so this element declares no margin of its own — previously, being an
 * inline `<time>` after a block sibling in a non-flex button, it butted straight
 * against the last reset line at zero gap while the bars sat on an 8px rhythm.
 */
export function SessionLimitsStaleNote({
  fetchedAt,
  now,
  timeZone,
}: SessionLimitsStaleNoteProps) {
  const caveat = selectSessionLimitStaleCaveat(fetchedAt, now, timeZone);
  if (!caveat) {
    return null;
  }

  return (
    <time
      className="font-medium text-[11px] text-muted-foreground"
      data-testid="session-limits-stale-note"
      dateTime={caveat.dateTime}
    >
      {caveat.label}
    </time>
  );
}
