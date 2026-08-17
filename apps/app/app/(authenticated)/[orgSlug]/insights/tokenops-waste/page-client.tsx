"use client";

import type {
  InsightsPeriod,
  InsightsScope,
} from "@repo/api/src/types/insights";
import { TokenOpsWidget } from "@repo/api/src/types/session-analytics";
import { useState } from "react";
import { useTokenOpsWasteInsights } from "@/hooks/queries/use-session-analytics";
import {
  AnalyticsPageHeader,
  DEFAULT_SESSION_ANALYTICS_PERIOD,
  DEFAULT_SESSION_ANALYTICS_SCOPE,
} from "@/lib/analytics/analytics-page-header";
import { ModelRightSizing } from "./components/model-right-sizing";
import { RecoverableWaste } from "./components/recoverable-waste";
import { SpendByOutcome } from "./components/spend-by-outcome";
import { resolveWidgetState } from "./components/widget-state";

/**
 * ISS-4988. The judgment half of the session-analytics pair: how much of the
 * error-outcome spend was actually recoverable, and whether the models are
 * sized for the work.
 *
 * The reading order is the argument. The measured split comes first, the
 * estimate built on it comes second, and the right-sizing verdicts come last,
 * so a reader always meets the fact before the judgment derived from it.
 *
 * Every number on this page is computed server-side and rendered here as it
 * arrives. Recomputing a rate, a verdict, or a total at the render site is how
 * two surfaces start disagreeing about the same population.
 */

export function TokenOpsWastePageClient() {
  const [period, setPeriod] = useState<InsightsPeriod>(
    DEFAULT_SESSION_ANALYTICS_PERIOD
  );
  const [scope, setScope] = useState<InsightsScope>(
    DEFAULT_SESSION_ANALYTICS_SCOPE
  );
  const query = useTokenOpsWasteInsights(period, scope);
  const data = query.data;
  const widgetStateFor = (widget: TokenOpsWidget) =>
    resolveWidgetState({
      isError: query.isError,
      isPending: query.isPending,
      unavailableWidgets: data?.unavailableWidgets,
      widget,
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <AnalyticsPageHeader
        onPeriodChange={setPeriod}
        onScopeChange={setScope}
        period={period}
        scope={scope}
        subtitle="What the period's spend bought, and what it wasted"
        title="TokenOps waste"
      />
      {/* Plain <div>, not <main>: the app shell's SidebarInset owns the page's
          single main landmark. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4">
          <SpendByOutcome
            outcomes={data?.outcomes}
            state={widgetStateFor(TokenOpsWidget.Outcomes)}
            totalSpendUsd={data?.totalSpendUsd}
          />
          <RecoverableWaste
            state={widgetStateFor(TokenOpsWidget.Waste)}
            waste={data?.waste}
          />
          <ModelRightSizing
            minGradedSessions={data?.minGradedSessions}
            models={data?.models}
            state={widgetStateFor(TokenOpsWidget.Models)}
          />
        </div>
      </div>
    </div>
  );
}
