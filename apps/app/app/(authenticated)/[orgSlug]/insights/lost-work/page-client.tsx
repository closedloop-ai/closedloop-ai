"use client";

import type {
  InsightsPeriod,
  InsightsScope,
} from "@repo/api/src/types/insights";
import {
  LossClass,
  type LostWorkInsightsResponse,
  LostWorkWidget,
} from "@repo/api/src/types/session-analytics";
import { useState } from "react";
import { useLostWorkInsights } from "@/hooks/queries/use-session-analytics";
import {
  AnalyticsPageHeader,
  DEFAULT_SESSION_ANALYTICS_PERIOD,
  DEFAULT_SESSION_ANALYTICS_SCOPE,
} from "@/lib/analytics/analytics-page-header";
import { LossAttribution } from "./components/loss-attribution";
import { LossByPerson } from "./components/loss-by-person";
import { LossCauses } from "./components/loss-causes";
import { LossTrend } from "./components/loss-trend";
import { LostSessionsTable } from "./components/lost-sessions-table";

/**
 * ISS-4987. Wall-clock lost to sessions that produced nothing, sliceable by
 * person and cause, with systemic loss held apart from coachable loss
 * everywhere it appears.
 *
 * Reading order is deliberate: what was lost and who could have prevented it,
 * then whether it is getting worse, then who, then why, then the runs
 * themselves. A manager should be able to stop after the first block.
 *
 * Three states are never conflated. `isPending` is the skeleton; a widget key
 * in `unavailableWidgets` (or a failed read) is a dash with a reason; a real
 * `0` is a measurement and renders as one. On a screen whose subject is
 * failure, a fabricated zero reads as "no problem here".
 */

export function LostWorkPageClient() {
  const [period, setPeriod] = useState<InsightsPeriod>(
    DEFAULT_SESSION_ANALYTICS_PERIOD
  );
  const [scope, setScope] = useState<InsightsScope>(
    DEFAULT_SESSION_ANALYTICS_SCOPE
  );
  const query = useLostWorkInsights(period, scope);

  const loading = query.isPending;
  const data = query.data ?? null;
  const totals = readWidget(
    data,
    LostWorkWidget.Totals,
    (value) => value.totals
  );
  const trend = readWidget(data, LostWorkWidget.Trend, (value) => value.trend);
  const people = readWidget(
    data,
    LostWorkWidget.People,
    (value) => value.people
  );
  const systemicCauses = readWidget(
    data,
    LostWorkWidget.SystemicCauses,
    (value) => value.systemicCauses
  );
  const behavioralCauses = readWidget(
    data,
    LostWorkWidget.BehavioralCauses,
    (value) => value.behavioralCauses
  );
  const lostSessions = readWidget(
    data,
    LostWorkWidget.LostSessions,
    (value) => value.lostSessions
  );

  return (
    // plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate).
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <AnalyticsPageHeader
        onPeriodChange={setPeriod}
        onScopeChange={setScope}
        period={period}
        scope={scope}
        subtitle="Time spent on sessions that produced nothing"
        title="Lost work"
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
          <LossAttribution loading={loading} totals={totals} />
          <LossTrend loading={loading} trend={trend} />
          <LossByPerson loading={loading} people={people} />
          <LossCauses
            behavioralCauses={behavioralCauses}
            behavioralClassMinutes={
              totals?.minutesByClass[LossClass.Actionable] ?? null
            }
            loading={loading}
            systemicCauses={systemicCauses}
            systemicClassMinutes={
              totals?.minutesByClass[LossClass.Systemic] ?? null
            }
          />
          <LostSessionsTable
            loading={loading}
            sessions={lostSessions}
            totalLostSessions={countLostSessions(totals)}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * One rollup, or `null` when it settled without a value.
 *
 * A widget is unavailable when the response listed its key, or when the read
 * itself failed and there is no response at all. Both are SETTLED states the
 * surface renders as a dash with a reason, never as a zero and never as a
 * skeleton that never resolves.
 */
function readWidget<TValue>(
  response: LostWorkInsightsResponse | null,
  widget: LostWorkWidget,
  select: (value: LostWorkInsightsResponse) => TValue
): TValue | null {
  if (!response || response.unavailableWidgets.includes(widget)) {
    return null;
  }
  return select(response);
}

/**
 * Every lost session in range, summed from the class counts so the sessions
 * table's caption reconciles with the strip at the top of the screen instead of
 * counting only the rows the server chose to send.
 */
function countLostSessions(
  totals: LostWorkInsightsResponse["totals"] | null
): number | null {
  if (!totals) {
    return null;
  }
  return (
    totals.sessionsByClass[LossClass.Actionable] +
    totals.sessionsByClass[LossClass.Systemic] +
    totals.sessionsByClass[LossClass.Unattributed]
  );
}
