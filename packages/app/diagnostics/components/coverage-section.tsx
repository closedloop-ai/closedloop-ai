"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { formatCurrency } from "@repo/design-system/components/ui/utils";
import type {
  ActivityCoverageAxis,
  ActivityCoverageAxisLabels,
  ActivityCoverageCell,
  ActivityCoverageData,
} from "../lib/diagnostics-payload";

type CoverageSectionProps = {
  /**
   * ISS-6758. `undefined` is a THIRD state, not a spelling of empty: the read
   * could not run (an older payload, or a store this read failed on), and
   * rendering that as 0% coverage over 0 sessions would state a measured result
   * where there is none.
   */
  coverage: ActivityCoverageData | undefined;
  /**
   * ISS-10004. Supplied by the host, because the axis keys are its own metric
   * module's `CohortAxis` vocabulary and only that producer's suite can keep a
   * label map honest — see {@link ActivityCoverageAxisLabels}. An unlabelled
   * axis falls back to its raw key rather than being dropped: a missing heading
   * is a labelling bug, and hiding the column would silently narrow the read.
   */
  axisLabels: ActivityCoverageAxisLabels;
};

const TITLE_ID = "activity-coverage-title";

function axisLabel(labels: ActivityCoverageAxisLabels, axis: string): string {
  return labels[axis] ?? axis;
}

/**
 * `formatCurrency` stops at 2 decimals, so a sub-cent cohort would render "$0.00"
 * beside a live percentage — a ratio over a basis the screen shows as empty, in
 * exactly the thin cohorts this tab exists to surface. Say the amount is below a
 * cent instead of rounding it to nothing.
 */
function formatSpend(usd: number): string {
  if (usd > 0 && usd < 0.005) {
    return "<$0.01";
  }
  return formatCurrency(usd);
}

/** "1 session" / "4 sessions" — a bare count next to "not counted" reads wrong. */
function sessions(count: number): string {
  return `${count} session${count === 1 ? "" : "s"}`;
}

function formatCoverage(cell: ActivityCoverageCell): string {
  // A cell with no spend has no ratio to report. `coverage` is guarded to 0
  // there, and 0% would read as "nothing was attributed" — a measured failure —
  // rather than "there was nothing to attribute".
  if (cell.totalSpendUsd === 0) {
    return "—";
  }
  return `${(cell.coverage * 100).toFixed(1)}%`;
}

function CoverageRows({
  axis,
  axisLabels,
}: Readonly<{
  axis: ActivityCoverageAxis;
  axisLabels: ActivityCoverageAxisLabels;
}>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{axisLabel(axisLabels, axis.axis)}</TableHead>
          <TableHead className="text-right">Coverage</TableHead>
          <TableHead className="text-right">Covered</TableHead>
          <TableHead className="text-right">Total</TableHead>
          <TableHead className="text-right">Low / Med / High</TableHead>
          <TableHead className="text-right">Sessions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {axis.buckets.map(({ bucket, cell }) => (
          <TableRow key={bucket}>
            <TableCell className="font-mono text-xs">
              {bucket}
              {cell.lowSample && (
                <Badge className="ml-2" variant="outline">
                  Low sample
                </Badge>
              )}
            </TableCell>
            <TableCell className="text-right font-medium">
              {formatCoverage(cell)}
            </TableCell>
            <TableCell className="text-right">
              {formatSpend(cell.coveredSpendUsd)}
            </TableCell>
            <TableCell className="text-right">
              {formatSpend(cell.totalSpendUsd)}
            </TableCell>
            <TableCell className="text-right font-mono text-xs">
              {formatSpend(cell.spendLowConfUsd)} /{" "}
              {formatSpend(cell.spendMediumConfUsd)} /{" "}
              {formatSpend(cell.spendHighConfUsd)}
            </TableCell>
            <TableCell className="text-right">{cell.sessionCount}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function CoverageSection({
  axisLabels,
  coverage,
}: CoverageSectionProps) {
  if (!coverage) {
    return (
      <Alert aria-labelledby={TITLE_ID} variant="warning">
        <AlertTitle id={TITLE_ID}>Coverage unavailable</AlertTitle>
        <AlertDescription>
          This build could not read the activity-coverage rollup, so no coverage
          figure can be shown. This is not a measurement of zero coverage.
        </AlertDescription>
      </Alert>
    );
  }

  const { overall } = coverage;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <div className="font-bold text-2xl">
                {formatCoverage(overall)}
              </div>
              <div className="text-[var(--muted-foreground)] text-sm">
                Overall coverage
                {/* The overall cell carries the same low-sample rule as every
                    other cell. Uncaveated, a one-session install reads its
                    headline as a trustworthy measurement while the row below —
                    the same session — is badged thin. */}
                {overall.lowSample && (
                  <Badge className="ml-2" variant="outline">
                    Low sample
                  </Badge>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <div className="font-bold text-2xl">
                {formatSpend(overall.totalSpendUsd)}
              </div>
              <div className="text-[var(--muted-foreground)] text-sm">
                Total spend measured
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-center">
              <div className="font-bold text-2xl">{overall.sessionCount}</div>
              <div className="text-[var(--muted-foreground)] text-sm">
                {/* "counted", not "rolled up": off-formula rows ARE rolled up and
                    are excluded from this number, which would contradict the
                    alerts below saying how many were left out. */}
                Sessions counted
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {coverage.staleSessionCount > 0 && (
        <Alert variant="info">
          <AlertTitle>
            {sessions(coverage.staleSessionCount)} not counted yet
          </AlertTitle>
          <AlertDescription>
            Their coverage was computed under an older formula, so counting them
            here would mix two. They are re-derived on the next app start.
          </AlertDescription>
        </Alert>
      )}

      {coverage.unrecognizedFormulaSessionCount > 0 && (
        <Alert variant="warning">
          <AlertTitle>
            {sessions(coverage.unrecognizedFormulaSessionCount)} not counted
          </AlertTitle>
          <AlertDescription>
            A newer version of this app measured them with a formula this one
            does not have, and it will not recompute them. They stay out of the
            figures above until you update.
          </AlertDescription>
        </Alert>
      )}

      {overall.sessionCount === 0 ? (
        <p className="py-8 text-center text-[var(--muted-foreground)] text-sm">
          {coverage.staleSessionCount +
            coverage.unrecognizedFormulaSessionCount >
          0
            ? "Every rolled-up session is on a different formula version, so there is nothing to slice yet."
            : "No session has been rolled up yet, so there is nothing to slice."}
        </p>
      ) : (
        coverage.axes.map((axis) => (
          <Card key={axis.axis}>
            <CardHeader>
              <CardTitle>
                Coverage by {axisLabel(axisLabels, axis.axis)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CoverageRows axis={axis} axisLabels={axisLabels} />
            </CardContent>
          </Card>
        ))
      )}

      <p className="text-[var(--muted-foreground)] text-xs">
        Coverage is the share of spend the classifier attributed to a confident,
        real activity — spend in an <code>other</code> or <code>idle</code>{" "}
        segment, in a low-confidence segment, or in a turn no segment covers is
        counted in the total but never as covered. The low / medium / high split
        bins only the spend that landed inside a segment, so it does not add up
        to the total wherever a session had uncovered turns.
      </p>
    </div>
  );
}
