"use client";

import {
  INSIGHTS_PERIOD_OPTIONS,
  INSIGHTS_SCOPE_OPTIONS,
  InsightsPeriod,
  InsightsScope,
} from "@repo/api/src/types/insights";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";

/**
 * The header both session-analytics screens wear: title, one-line subtitle, and
 * the scope + period controls.
 *
 * ONE component rather than a copy per route. Two sibling screens that hand-roll
 * the same control drift immediately — these two shipped with their scope
 * dropdown in opposite orders, which a reader notices without being able to say
 * why. The scope list is FILTERED from the canonical `INSIGHTS_SCOPE_OPTIONS`
 * rather than re-listed, so its order is the app's order by construction and a
 * scope added there can never be silently missed here.
 */

const PERIOD_LABELS: Record<InsightsPeriod, string> = {
  [InsightsPeriod.Week]: "7 days",
  [InsightsPeriod.Month]: "30 days",
  [InsightsPeriod.Quarter]: "90 days",
  [InsightsPeriod.All]: "All time",
};

const SCOPE_LABELS: Record<InsightsScope, string> = {
  [InsightsScope.Me]: "Me",
  [InsightsScope.Org]: "Organization",
  [InsightsScope.Team]: "Team",
};

/**
 * The scopes these two reads actually honor, in the canonical order.
 *
 * `InsightsScope.Team` needs a team id neither route takes, and a fully-styled
 * control that silently ignores the choice is worse than not offering it.
 */
export const SESSION_ANALYTICS_SCOPES: readonly InsightsScope[] =
  INSIGHTS_SCOPE_OPTIONS.filter((scope) => scope !== InsightsScope.Team);

export const DEFAULT_SESSION_ANALYTICS_PERIOD: InsightsPeriod =
  InsightsPeriod.Month;
export const DEFAULT_SESSION_ANALYTICS_SCOPE: InsightsScope = InsightsScope.Org;

type AnalyticsPageHeaderProps = {
  readonly title: string;
  readonly subtitle: string;
  readonly scope: InsightsScope;
  readonly onScopeChange: (scope: InsightsScope) => void;
  readonly period: InsightsPeriod;
  readonly onPeriodChange: (period: InsightsPeriod) => void;
};

export function AnalyticsPageHeader({
  title,
  subtitle,
  scope,
  onScopeChange,
  period,
  onPeriodChange,
}: AnalyticsPageHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
      <div className="min-w-0">
        <h1 className="font-medium text-sm">{title}</h1>
        <p className="truncate text-muted-foreground text-xs">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Select
          onValueChange={(value) => onScopeChange(value as InsightsScope)}
          value={scope}
        >
          <SelectTrigger aria-label="Scope" className="h-8 w-36" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SESSION_ANALYTICS_SCOPES.map((option) => (
              <SelectItem key={option} value={option}>
                {SCOPE_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          onValueChange={(value) => onPeriodChange(value as InsightsPeriod)}
          value={period}
        >
          <SelectTrigger
            aria-label="Time period"
            className="h-8 w-28"
            size="sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INSIGHTS_PERIOD_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {PERIOD_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
