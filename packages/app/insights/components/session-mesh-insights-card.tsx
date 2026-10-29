"use client";

import type { SessionMeshInsights } from "@repo/api/src/types/session-mesh";
// Reuse the existing session-data unavailable treatment across Insights shells.
import { DegradedState } from "@repo/app/agents/components/shared/degraded-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { OverviewMetric } from "./overview/overview-metric";

const UNKNOWN = "—";

/**
 * Delivery, engagement and value are THREE facts and this card keeps them three
 * (ISS-11435).
 *
 * The card's own footer has always promised "Missing attribution is unknown,
 * never zero", and it honored that for the two savings estimates while rendering
 * `useful`, `conflictsResolved` and `acknowledged` through `String(...)` — so an
 * absent signal read as a confident `0`. In production that made the shipped card
 * say "4,061 delivered, nothing useful, 133 min of overhead" about a feature
 * whose value signal had no producer at all. Every count that depends on an
 * opt-in or version-dependent producer now renders `—` when nothing was recorded,
 * and every one of them states its denominator, because "0 useful" and "0 judged
 * of 4,061 delivered" are different sentences and only the second is true.
 *
 * No cost-per-value ratio is rendered, deliberately: overhead is emitted
 * automatically and every value rating is opt-in, so any such ratio is
 * structurally biased toward cost until the value side has a live producer.
 */
export function SessionMeshInsightsCard({
  data,
  isError,
  isLoading,
}: Readonly<{
  data?: SessionMeshInsights;
  isError: boolean;
  isLoading: boolean;
}>) {
  if (isLoading) {
    return <Skeleton className="h-44 w-full" />;
  }
  if (isError || !data) {
    return (
      <DegradedState message="Session Mesh reporting is temporarily unavailable." />
    );
  }
  const { deliveries } = data;
  const judged = deliveries.judged;
  /** A non-zero `judged` is the only evidence that any value producer fired. */
  const judgementObserved = (judged ?? 0) > 0;
  return (
    <Card>
      <CardHeader className="px-4 sm:px-6">
        <CardTitle className="font-semibold text-xl tracking-tight">
          Session Mesh
        </CardTitle>
        <CardDescription>
          Coordination outcomes for{" "}
          {data.scope?.kind === "org" ? "your organization" : "this user"}.
          Reporting window: {formatWindow(data.window)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <OverviewMetric
            detail={`${deliveries.attempted} attempted`}
            label="Delivered"
            value={deliveries.delivered.toLocaleString()}
          />
          <OverviewMetric
            detail={`${countSentence(deliveries.acknowledged, deliveries.delivered, "engaged", "delivered")}; observed edit or sibling-message tool use, or an explicit acknowledgement`}
            label="Engaged"
            value={reportedCount(deliveries.acknowledged)}
          />
          <OverviewMetric
            detail={countSentence(
              judged,
              deliveries.delivered,
              "judged",
              "delivered"
            )}
            label="Judged"
            value={reportedCount(judged)}
          />
          <OverviewMetric
            detail={countSentence(
              deliveries.useful,
              judged,
              "useful",
              "judged"
            )}
            label="Useful"
            value={reportedCount(deliveries.useful, judgementObserved)}
          />
          <OverviewMetric
            detail={countSentence(
              deliveries.notUseful,
              judged,
              "not useful",
              "judged"
            )}
            label="Not useful"
            value={reportedCount(deliveries.notUseful, judgementObserved)}
          />
          <OverviewMetric
            detail={countSentence(
              deliveries.cantTell,
              judged,
              "can't tell",
              "judged"
            )}
            label="Can't tell"
            value={reportedCount(deliveries.cantTell, judgementObserved)}
          />
          <OverviewMetric
            detail={countSentence(
              deliveries.conflictsResolved,
              deliveries.delivered,
              "reported",
              "delivered"
            )}
            label="Conflicts resolved"
            value={reportedCount(deliveries.conflictsResolved)}
          />
          <OverviewMetric
            detail={countSentence(
              deliveries.recipientActions,
              deliveries.delivered,
              "held, refused or dismissed",
              "delivered"
            )}
            label="Recipient actions"
            value={reportedCount(deliveries.recipientActions)}
          />
          <OverviewMetric
            detail="measured background-wall time"
            label="Coordination overhead"
            value={formatMinutes(data.coordinationOverheadMs)}
          />
          <OverviewMetric
            detail="estimated, explicitly attributed"
            label="Estimated cost saved"
            value={
              data.estimatedCostSavedUsd === null
                ? UNKNOWN
                : `$${data.estimatedCostSavedUsd.toFixed(2)}`
            }
          />
          <OverviewMetric
            detail="explicitly attributed"
            label="Estimated time saved"
            value={
              data.estimatedTimeSavedMinutes === null
                ? UNKNOWN
                : `${Math.round(data.estimatedTimeSavedMinutes)} min`
            }
          />
          <OverviewMetric
            detail={`${data.participation.eligible} eligible`}
            label="Active sessions"
            value={data.participation.active.toLocaleString()}
          />
          <OverviewMetric
            detail="mean request to reply"
            label="Response time"
            value={formatMinutes(data.requestResponseLatencyMs)}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          {data.provenance.notes.join(" ")}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * A count whose producer is opt-in or version-dependent.
 *
 * `undefined` is a server that does not report this signal at all; `0` is a
 * signal with no recorded events. NEITHER is a measured zero-value outcome, so
 * both render as unknown and the denominator sentence carries what is actually
 * known.
 */
function reportedCount(
  value: number | undefined,
  producerObserved?: boolean
): string {
  if (value === undefined) {
    return UNKNOWN;
  }
  // A ZERO IS UNKNOWN ONLY WHILE ITS OWN PRODUCER IS SILENT. A non-zero `judged`
  // proves the value producer fired, so `0 not useful of 10 judged` is a MEASURED
  // outcome and rendering it as unknown would delete a computed value — this
  // card's own defect, inverted. Nothing proves the engagement or
  // conflict-resolved producers fired, so their zero stays unknown: a delivered
  // count is not evidence about a different producer.
  if (value === 0 && !producerObserved) {
    return UNKNOWN;
  }
  return value.toLocaleString();
}

/** "0 judged of 4,061 delivered" — never a bare "0". */
function countSentence(
  value: number | undefined,
  total: number | undefined,
  noun: string,
  totalNoun: string
): string {
  // The denominator is never dropped. An absent total says so, because a bare
  // "0 useful" is the exact sentence this card exists to stop rendering.
  const of =
    total === undefined
      ? ` of an unreported ${totalNoun} count`
      : ` of ${total.toLocaleString()} ${totalNoun}`;
  if (value === undefined) {
    return `not reported by this server${of}`;
  }
  return `${value.toLocaleString()} ${noun}${of}`;
}

function formatMinutes(value: number | null) {
  if (value === null) {
    return UNKNOWN;
  }
  if (value < 60_000) {
    return "<1 min";
  }
  return `${Math.round(value / 60_000)} min`;
}
function formatWindow(window: SessionMeshInsights["window"]) {
  const from = new Date(window.from);
  const to = new Date(window.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return UNKNOWN;
  }
  return `${from.toLocaleDateString()} – ${to.toLocaleDateString()}`;
}
