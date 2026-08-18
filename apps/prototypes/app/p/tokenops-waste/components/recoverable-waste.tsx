"use client";

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
  DataState,
  formatCount,
  formatPercent,
  formatUsd,
  formatUsdRange,
  NO_VALUE,
} from "@/lib/analytics/format";
import { RECOVERY_HIGH_RATE, RECOVERY_LOW_RATE, wasteEstimate } from "../mock";

/**
 * The judgment half of ISS-4463, which was scoped out of the factual tiles on
 * purpose. Everything here is an estimate, and the design says so three ways
 * rather than trusting a caption to do it:
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
 */

const PERCENT = 100;

export function RecoverableWaste({
  dataState,
}: {
  readonly dataState: DataState;
}) {
  const loading = dataState === DataState.Loading;
  const unavailable = dataState === DataState.Degraded;
  const uncertaintyUsd = wasteEstimate.highUsd - wasteEstimate.lowUsd;
  const unlikelyUsd = wasteEstimate.errorOutcomeUsd - wasteEstimate.highUsd;

  return (
    <Section
      actions={<Badge variant="outline">Estimate</Badge>}
      description="Not a measurement. How much of the error-outcome spend would not have been spent again if the failure had been prevented."
      title="Recoverable waste"
    >
      {renderEstimate({ loading, unavailable, uncertaintyUsd, unlikelyUsd })}
    </Section>
  );
}

function renderEstimate({
  loading,
  unavailable,
  uncertaintyUsd,
  unlikelyUsd,
}: {
  readonly loading: boolean;
  readonly unavailable: boolean;
  readonly uncertaintyUsd: number;
  readonly unlikelyUsd: number;
}) {
  if (loading) {
    return <Skeleton className="h-40 w-full rounded-md" />;
  }
  if (unavailable) {
    // The most tempting number on the page to fabricate. When the artifact
    // linkage behind it does not load, the estimate settles as unavailable and
    // says which read failed. It never falls back to $0, which on a waste
    // screen would read as "nothing was wasted".
    return (
      <div className="space-y-2">
        <div className="font-normal text-3xl text-muted-foreground tracking-tight">
          {NO_VALUE}
        </div>
        <p className="text-muted-foreground text-sm">
          The artifact-linkage read did not return for this range, so the
          recoverable share cannot be estimated. The measured spend above is
          unaffected.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <div>
        <div className="font-semibold text-3xl tabular-nums tracking-tight">
          {formatUsdRange(wasteEstimate.lowUsd, wasteEstimate.highUsd)}
        </div>
        <p className="text-muted-foreground text-sm">
          out of {formatUsd(wasteEstimate.errorOutcomeUsd)} spent across{" "}
          {formatCount(wasteEstimate.sessions)} sessions that ended with an
          error and produced no artifact
        </p>
      </div>
      <SegmentedBar
        segments={[
          {
            colorClassName: "bg-chart-1",
            key: "likely",
            label: "Likely recoverable",
            value: Math.round(wasteEstimate.lowUsd),
          },
          {
            // The band between the two assumptions, drawn rather than
            // averaged into a single confident number.
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
        ]}
        total={Math.round(wasteEstimate.errorOutcomeUsd)}
      />
      <dl className="divide-y divide-border">
        <BasisRow
          term="Basis"
          value={`${formatCount(wasteEstimate.sessions)} sessions where endsWithError is true and no artifact was produced. Same predicate, window, and scope as the measured tiles above.`}
        />
        <BasisRow
          term="Assumption"
          value={`Between ${formatPercent(RECOVERY_LOW_RATE * PERCENT)} and ${formatPercent(RECOVERY_HIGH_RATE * PERCENT)} of that spend would not have been re-spent. The rest is context the run would have paid for regardless.`}
        />
        <BasisRow
          term="Excluded"
          value={`${formatUsd(wasteEstimate.excludedUnknownUsd)} of outcome-unknown spend. We never observed that those sessions failed, so none of it is counted as waste.`}
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
