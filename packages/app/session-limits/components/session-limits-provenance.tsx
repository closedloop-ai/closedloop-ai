import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import {
  formatAbsoluteDateTime,
  formatFetchedAtLabel,
  formatSourceLabel,
  toDateTimeAttribute,
} from "../lib/format";
import { selectSessionLimitStaleCaveat } from "../lib/freshness";
import type { SessionLimits } from "../types";

export type SessionLimitsProvenanceProps = {
  limits: Pick<SessionLimits, "source" | "fetchedAt">;
  now?: Date;
  /** Injectable time zone so tests are not hostage to the runner's TZ. */
  timeZone?: string;
};

/**
 * The detail drawer's provenance footer: how fresh the captured snapshot is
 * (`fetchedAt`, as a relative "N ago" label). The producer that captured it
 * (`source`) is secondary — it answers a question the user didn't ask ("where
 * did this number come from") — so it's tucked into a tooltip on the freshness
 * text rather than shown inline; the footer stays about "how current is this."
 *
 * Renders honestly around missing data (no lying UI): with no parseable
 * `fetchedAt`, it renders nothing rather than an empty footer.
 *
 * PRD-538 R6 added the absolute capture time beside the relative label. "3m ago"
 * is a duration and it silently drifts while the drawer sits open; the datetime
 * is the fact behind it, and it is what makes a stale snapshot readable as "the
 * figures are from THEN" rather than as a vague staleness. The desktop store
 * still drops a snapshot past its own hard cutoff, so what reaches here is
 * bounded — but bounded is not current, and anything past the display-freshness
 * horizon is labeled rather than presented as up-to-date.
 */
export function SessionLimitsProvenance({
  limits,
  now,
  timeZone,
}: SessionLimitsProvenanceProps) {
  const fetchedLabel = formatFetchedAtLabel(limits.fetchedAt, now);

  if (!fetchedLabel) {
    return null;
  }

  const sourceLabel = formatSourceLabel(limits.source);
  const absolute = formatAbsoluteDateTime(limits.fetchedAt, timeZone);
  const dateTime = toDateTimeAttribute(limits.fetchedAt);
  // Stale: the one shared "As of <datetime>" wording, matching the sidebar
  // caveat exactly — from the same selector, so "matching exactly" is enforced
  // rather than asserted in a comment. Current: the relative label leads, with
  // the datetime behind it as the fact the relative phrase is derived from.
  const stale = selectSessionLimitStaleCaveat(limits.fetchedAt, now, timeZone);
  const body = stale ? (
    <time dateTime={stale.dateTime}>{stale.label}</time>
  ) : (
    <>
      {`Updated ${fetchedLabel}`}
      {absolute ? (
        <>
          {" ("}
          <time dateTime={dateTime ?? undefined}>{absolute}</time>
          {")"}
        </>
      ) : null}
    </>
  );

  return (
    <div
      className="flex items-center border-border border-t pt-3"
      data-testid="session-limits-provenance"
    >
      {sourceLabel ? (
        <Tooltip>
          <TooltipTrigger className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1">
            {body}
          </TooltipTrigger>
          <TooltipContent>Source: {sourceLabel}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-[11px] text-muted-foreground">{body}</span>
      )}
    </div>
  );
}
