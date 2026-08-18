"use client";

import type { RecoverableWasteEstimate } from "@repo/api/src/types/session-analytics";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Section } from "@repo/design-system/components/ui/layout/section";
import { SegmentedBar } from "@repo/design-system/components/ui/primitives/segmented-bar";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  formatCount,
  formatPercent,
  formatUsd,
  formatUsdRange,
  NO_VALUE,
} from "@/lib/analytics/format";
import { UnavailableValue } from "@/lib/analytics/unavailable";
import { WidgetState } from "./widget-state";

/**
 * The judgment half of the screen. Everything here is an estimate, and the
 * design says so three ways rather than trusting a caption to do it:
 *
 *   1. The headline is a RANGE. A point value reads as a measurement, and this
 *      is not one.
 *   2. The bar draws the uncertainty as its own segment, so the band between
 *      the low and high assumption is a visible part of the picture instead of
 *      being averaged away.
 *   3. The basis, the assumption, and what was deliberately EXCLUDED are all on
 *      screen, because an estimate a reader cannot audit is just a number with
 *      confidence attached.
 *
 * The excluded row matters most: outcome-unknown spend never enters the
 * estimate, because we cannot claim a session wasted money when we never
 * observed that it failed.
 *
 * The assumption is read off the response (`lowRate` / `highRate`) rather than
 * restated here, so the rate on screen is always the rate the number was built
 * with.
 */

const PERCENT = 100;

const UNAVAILABLE_REASON =
  "The session-spend read did not return for this range, so the recoverable share cannot be estimated.";

export function RecoverableWaste({
  state,
  waste,
}: {
  readonly state: WidgetState;
  readonly waste: RecoverableWasteEstimate | undefined;
}) {
  return (
    <Section
      actions={<Badge variant="outline">Estimate</Badge>}
      description="Not a measurement. How much of the error-outcome spend would not have been spent again if the failure had been prevented."
      title="Recoverable waste"
    >
      {renderEstimate({ state, waste })}
    </Section>
  );
}

function renderEstimate({
  state,
  waste,
}: {
  readonly state: WidgetState;
  readonly waste: RecoverableWasteEstimate | undefined;
}) {
  if (state === WidgetState.Loading) {
    return <Skeleton className="h-40 w-full rounded-md" />;
  }
  // The most tempting number on the page to fabricate. When the read behind it
  // does not land, the estimate settles as unavailable and says so. It never
  // falls back to $0, which on a waste screen reads as "nothing was wasted".
  if (!(state === WidgetState.Ready && waste)) {
    return <UnavailableValue reason={UNAVAILABLE_REASON} />;
  }
  return <ReadyEstimate waste={waste} />;
}

function ReadyEstimate({
  waste,
}: {
  readonly waste: RecoverableWasteEstimate;
}) {
  // Clamped at zero: a high estimate above the basis it is drawn from would be
  // a server-side contradiction, and a negative segment would make the bar
  // describe a composition that does not exist.
  const uncertaintyUsd = Math.max(0, waste.highUsd - waste.lowUsd);
  const unlikelyUsd = Math.max(0, waste.errorOutcomeUsd - waste.highUsd);
  const segments = [
    {
      colorClassName: "bg-chart-1",
      key: "likely",
      label: "Likely recoverable",
      value: Math.round(waste.lowUsd),
    },
    {
      // The band between the two assumptions, drawn rather than averaged into
      // a single confident number.
      colorClassName: "bg-chart-1/40",
      key: "uncertain",
      label: "Depends on the assumption",
      value: Math.round(uncertaintyUsd),
    },
    {
      colorClassName: "bg-muted-foreground/25",
      key: "unlikely",
      label: "Would have been re-spent anyway",
      value: Math.round(unlikelyUsd),
    },
  ];
  // The parts define the whole, so the bar cannot disagree with the segments
  // drawn inside it.
  const barTotal = segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <div className="space-y-5">
      <div>
        <div className="font-semibold text-3xl tabular-nums tracking-tight">
          {formatUsdRange(waste.lowUsd, waste.highUsd)}
        </div>
        <p className="text-muted-foreground text-sm">
          out of {formatUsd(waste.errorOutcomeUsd)} spent across{" "}
          {formatCount(waste.sessions)} sessions that ended with an error and
          produced no artifact
        </p>
      </div>
      <SegmentedBar segments={segments} total={barTotal} />
      <dl className="divide-y divide-border">
        <BasisRow
          term="Basis"
          value={`${formatCount(waste.sessions)} sessions that ended with an error and produced no artifact. Same predicate, window, and scope as the measured split above.`}
        />
        <BasisRow
          term="Assumption"
          value={`Between ${formatPercent(waste.lowRate * PERCENT)} and ${formatPercent(waste.highRate * PERCENT)} of that spend would not have been re-spent. The rest is context the run would have paid for regardless.`}
        />
        <BasisRow
          term="Excluded"
          value={`${formatUsd(waste.excludedUnknownUsd)} of outcome-unknown spend. We never observed that those sessions failed, so none of it is counted as waste.`}
        />
      </dl>
      <Alert>
        <AlertTitle>What would make this a measurement</AlertTitle>
        <AlertDescription>
          Recording, per failed session, whether the work was later redone and
          at what cost. Until that link exists, the range is the honest answer
          and the single number is not.
        </AlertDescription>
      </Alert>
    </div>
  );
}

function BasisRow({
  term,
  value,
}: {
  readonly term: string;
  readonly value: string;
}) {
  return (
    <div className="grid gap-1 py-2 first:pt-0 last:pb-0 sm:grid-cols-[8rem_1fr] sm:gap-4">
      <dt className="font-medium text-sm">{term}</dt>
      <dd className="text-muted-foreground text-sm">{value || NO_VALUE}</dd>
    </div>
  );
}
