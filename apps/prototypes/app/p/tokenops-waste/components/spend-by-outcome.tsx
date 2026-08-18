"use client";

import { Section } from "@repo/design-system/components/ui/layout/section";
import { SegmentedBar } from "@repo/design-system/components/ui/primitives/segmented-bar";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  DataState,
  formatSessions,
  formatUsd,
  formatUsdExact,
} from "@/lib/analytics/format";
import { SpendOutcome } from "@/lib/analytics/session-fixture";
import { outcomeRows, totalSpendUsd } from "../mock";

/**
 * The factual anchor of the screen, and the thing everything below is derived
 * from: period spend split by how the originating session ENDED.
 *
 * This is the tile ISS-4463 / PR #4282 landed, restated here so the estimate
 * that follows is visibly built on a measured number rather than appearing out
 * of nowhere. It is keyed on the session's terminal `endsWithError` and nothing
 * else, which is the same key the Lost-work screen uses, so the two can never
 * disagree about which sessions failed.
 *
 * "Outcome unknown" is its own bucket. `endsWithError` is nullable, and a null
 * genuinely means no outcome was ever recorded. Folding it into "Ended clean"
 * would overstate healthy spend; folding it into "Ended with error" would
 * invent waste that was never observed.
 */

/**
 * Outcome -> bar color. `Outcome unknown` takes `--chart-3`, the SAME token the
 * Lost-work screen gives its Unattributed class, because they are the same
 * sessions seen as dollars instead of hours. Clean spend is achromatic: it is
 * the denominator the other two are read against, so it recedes.
 */
const OUTCOME_BAR_CLASS: Record<SpendOutcome, string> = {
  [SpendOutcome.Clean]: "bg-muted-foreground/25",
  [SpendOutcome.Errored]: "bg-chart-1",
  [SpendOutcome.Unknown]: "bg-chart-3",
};

export function SpendByOutcome({
  dataState,
}: {
  readonly dataState: DataState;
}) {
  return (
    <Section
      description={`${formatUsd(totalSpendUsd)} of session spend in range, keyed on the session's terminal endsWithError. Measured, not estimated.`}
      title="Spend by session outcome"
    >
      {dataState === DataState.Loading ? (
        <Skeleton className="h-24 w-full rounded-md" />
      ) : (
        <div className="space-y-4">
          <SegmentedBar
            segments={outcomeRows.map((row) => ({
              colorClassName: OUTCOME_BAR_CLASS[row.outcome],
              key: row.outcome,
              label: row.label,
              value: Math.round(row.usd),
            }))}
            total={Math.round(totalSpendUsd)}
          />
          <dl className="divide-y divide-border">
            {outcomeRows.map((row) => (
              <div
                className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0"
                key={row.outcome}
              >
                <dt className="text-sm">{row.label}</dt>
                <dd className="flex shrink-0 items-baseline gap-3 tabular-nums">
                  <span className="text-muted-foreground text-xs">
                    {formatSessions(row.sessions)}
                  </span>
                  <span className="font-medium text-sm">
                    {formatUsdExact(row.usd)}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </Section>
  );
}
