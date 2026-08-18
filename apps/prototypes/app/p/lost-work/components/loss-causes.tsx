"use client";

import { Section } from "@repo/design-system/components/ui/layout/section";
import { RankedBar } from "@repo/design-system/components/ui/primitives/ranked-bar";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  DataState,
  formatHours,
  formatSessions,
  NO_VALUE,
} from "@/lib/analytics/format";
import {
  LossClass,
  minutesToHours,
  toPercent,
} from "@/lib/analytics/session-fixture";
import {
  behavioralCauses,
  type CauseRow,
  lossTotals,
  systemicCauses,
} from "../mock";

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

const SKELETON_BAR_COUNT = 3;

export function LossCauses({ dataState }: { readonly dataState: DataState }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section
        description="Platform-caused. Nothing here belongs on a person's record."
        title="Systemic causes"
      >
        <CauseList
          // The systemic breakdown reads the throttle-source rollup, which is
          // its own precomputed widget. When that read settles without a value
          // the panel says so, rather than rendering an empty list that would
          // read as "no platform failures".
          available={dataState !== DataState.Degraded}
          dataState={dataState}
          rows={systemicCauses}
          totalMinutes={lossTotals.minutesByClass[LossClass.Systemic]}
          unavailableReason="Throttle-source rollup did not load for this range."
        />
      </Section>
      <Section
        description="Coachable. This is what a one-to-one is actually about."
        title="Behavioral patterns"
      >
        <CauseList
          available
          dataState={dataState}
          rows={behavioralCauses}
          totalMinutes={lossTotals.minutesByClass[LossClass.Actionable]}
        />
      </Section>
    </div>
  );
}

function CauseList({
  rows,
  totalMinutes,
  dataState,
  available,
  unavailableReason,
}: {
  readonly rows: readonly CauseRow[];
  readonly totalMinutes: number;
  readonly dataState: DataState;
  readonly available: boolean;
  readonly unavailableReason?: string;
}) {
  if (dataState === DataState.Loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: SKELETON_BAR_COUNT }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder bars
          <Skeleton className="h-20 w-full rounded-xl" key={index} />
        ))}
      </div>
    );
  }
  if (!available) {
    return (
      <p className="text-muted-foreground text-sm">
        <span className="mr-2">{NO_VALUE}</span>
        {unavailableReason}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <RankedBar
          description={formatSessions(row.sessions)}
          key={row.key}
          label={row.label}
          percent={toPercent(row.minutes, totalMinutes)}
          value={formatHours(minutesToHours(row.minutes))}
        />
      ))}
    </div>
  );
}
