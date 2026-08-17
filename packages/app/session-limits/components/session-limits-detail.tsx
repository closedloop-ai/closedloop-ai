import { formatCreditSummary } from "../lib/format";
import { SessionLimitWindowLabel } from "../lib/window-labels";
import type { RateLimit, SessionLimits } from "../types";
import { LimitBar } from "./limit-bar";
import { SessionLimitsProvenance } from "./session-limits-provenance";

export type SessionLimitsDetailProps = {
  limits: SessionLimits;
  now?: Date;
  /** Injectable time zone so tests are not hostage to the runner's TZ. */
  timeZone?: string;
};

type Row = { title: string; limit: RateLimit; subtext?: string | null };

/**
 * The rich, read-only detail view behind the sidebar bars: every available
 * window (session, week-all, week-by-model) plus extra-usage credits. Purely
 * presentational — no controls, no mutation.
 */
export function SessionLimitsDetail({
  limits,
  now,
  timeZone,
}: SessionLimitsDetailProps) {
  const rows: Row[] = [];
  if (limits.fiveHour) {
    rows.push({
      title: SessionLimitWindowLabel.FiveHour,
      limit: limits.fiveHour,
    });
  }
  if (limits.sevenDay) {
    rows.push({
      title: SessionLimitWindowLabel.SevenDay,
      limit: limits.sevenDay,
    });
  }
  if (limits.sevenDaySonnet) {
    rows.push({
      title: SessionLimitWindowLabel.SevenDaySonnet,
      limit: limits.sevenDaySonnet,
    });
  }
  if (limits.sevenDayOpus) {
    rows.push({
      title: SessionLimitWindowLabel.SevenDayOpus,
      limit: limits.sevenDayOpus,
    });
  }

  const extra = limits.extraUsage;
  if (extra?.isEnabled && extra.utilization !== null) {
    rows.push({
      title: SessionLimitWindowLabel.ExtraUsage,
      limit: { utilization: extra.utilization, resetsAt: null },
      subtext: formatCreditSummary(extra.usedCreditsUsd, extra.monthlyLimitUsd),
    });
  }

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" data-testid="limits-empty">
        Session limits are available on Claude subscription plans.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="session-limits-detail">
      {rows.map((row) => (
        <LimitBar
          key={row.title}
          limit={row.limit}
          now={now}
          showResetDateTime
          subtext={row.subtext}
          timeZone={timeZone}
          title={row.title}
        />
      ))}
      <SessionLimitsProvenance limits={limits} now={now} timeZone={timeZone} />
    </div>
  );
}
