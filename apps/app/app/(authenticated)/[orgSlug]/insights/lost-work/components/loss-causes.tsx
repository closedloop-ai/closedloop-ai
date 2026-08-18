"use client";

import type { LostWorkCauseRow } from "@repo/api/src/types/session-analytics";
import { Section } from "@repo/design-system/components/ui/layout/section";
import { RankedBar } from "@repo/design-system/components/ui/primitives/ranked-bar";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  formatHours,
  formatSessions,
  minutesToHours,
  toPercent,
} from "@/lib/analytics/format";
import { WidgetUnavailable } from "@/lib/analytics/unavailable";

/**
 * What the loss came from, kept in two separate columns under two separate
 * headings. Merging them into one ranked list would put "usage limit" and
 * "abandoned mid-run" on the same axis, which is exactly the misattribution
 * this screen is built to prevent.
 *
 * Each column is ranked against ITS OWN class total, so a percentage here reads
 * as "share of systemic loss" or "share of coachable loss" and never as a share
 * of one merged failure number.
 */

export const SYSTEMIC_CAUSES_UNAVAILABLE_REASON =
  "The throttle-source rollup did not load for this range, so platform causes are unavailable rather than absent.";

export const BEHAVIORAL_CAUSES_UNAVAILABLE_REASON =
  "The behavioral-cause rollup did not load for this range, so coachable causes are unavailable rather than absent.";

const SKELETON_BAR_COUNT = 3;

/**
 * Said out loud whenever a column's percentages are ranked against the rows on
 * screen instead of the class total.
 *
 * The two denominators mean different things — "share of systemic loss" vs
 * "share of the causes listed here" — and the fallback set always sums to 100%,
 * which is exactly what makes it look complete when it is not. Swapping the
 * basis silently is the same defect as a fabricated zero: the number is not
 * wrong, it is answering a different question than the reader thinks.
 */
export const CAUSE_FALLBACK_BASIS_NOTE =
  "Shares are of the causes listed here — the class total did not load, so they do not reconcile with the totals above.";

type LossCausesProps = {
  readonly loading: boolean;
  /** `null` when that column's rollup settled without a value. */
  readonly systemicCauses: readonly LostWorkCauseRow[] | null;
  readonly behavioralCauses: readonly LostWorkCauseRow[] | null;
  /** Class totals from the totals rollup, or `null` when it did not load. */
  readonly systemicClassMinutes: number | null;
  readonly behavioralClassMinutes: number | null;
};

export function LossCauses({
  loading,
  systemicCauses,
  behavioralCauses,
  systemicClassMinutes,
  behavioralClassMinutes,
}: LossCausesProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section
        description="Platform-caused. Nothing here belongs on a person's record."
        title="Systemic causes"
      >
        <CauseList
          classMinutes={systemicClassMinutes}
          loading={loading}
          rows={systemicCauses}
          unavailableReason={SYSTEMIC_CAUSES_UNAVAILABLE_REASON}
        />
      </Section>
      <Section
        description="Coachable. This is what a one-to-one is actually about."
        title="Behavioral patterns"
      >
        <CauseList
          classMinutes={behavioralClassMinutes}
          loading={loading}
          rows={behavioralCauses}
          unavailableReason={BEHAVIORAL_CAUSES_UNAVAILABLE_REASON}
        />
      </Section>
    </div>
  );
}

function CauseList({
  rows,
  classMinutes,
  loading,
  unavailableReason,
}: {
  readonly rows: readonly LostWorkCauseRow[] | null;
  readonly classMinutes: number | null;
  readonly loading: boolean;
  readonly unavailableReason: string;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: SKELETON_BAR_COUNT }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder bars
          <Skeleton className="h-20 w-full rounded-xl" key={index} />
        ))}
      </div>
    );
  }
  if (!rows) {
    return <WidgetUnavailable reason={unavailableReason} />;
  }
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No loss of this kind was recorded in range.
      </p>
    );
  }
  const denominator = resolveDenominator(rows, classMinutes);
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <RankedBar
          description={formatSessions(row.sessions)}
          key={row.key}
          label={row.label}
          percent={toPercent(row.minutes, denominator)}
          value={formatHours(minutesToHours(row.minutes))}
        />
      ))}
      {classMinutes === null ? (
        <p className="text-muted-foreground text-xs">
          {CAUSE_FALLBACK_BASIS_NOTE}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The class total this column is ranked against. Prefer the totals rollup so a
 * share here reconciles with the strip at the top of the screen; when that
 * rollup did not load, fall back to the sum of the rows on screen so the
 * percentages still add up to what the reader can see rather than to a
 * denominator that is not there.
 *
 * The fallback is DISCLOSED at the render site ({@link CAUSE_FALLBACK_BASIS_NOTE}),
 * because the two denominators answer different questions and the fallback set
 * always sums to 100%. A silent swap leaves every percentage in the column
 * meaning something other than what the section heading claims.
 */
function resolveDenominator(
  rows: readonly LostWorkCauseRow[],
  classMinutes: number | null
): number {
  if (classMinutes !== null) {
    return classMinutes;
  }
  return rows.reduce((sum, row) => sum + row.minutes, 0);
}
