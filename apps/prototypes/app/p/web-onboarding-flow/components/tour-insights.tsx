import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { ActivityHeatmap } from "@repo/design-system/components/ui/primitives/activity-heatmap";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import type { ReactNode } from "react";
import {
  buildHeatmapWeeks,
  type DashboardScope,
  modelUsagePointsFor,
  modelUsageSeries,
  prTrendPointsFor,
  prTrendSeries,
  type RangeKey,
} from "../mock";

type TourInsightsProps = {
  range: RangeKey;
  scope: DashboardScope;
};

// All three charts read the same range + scope the KPI row does, so the picker
// drives the whole dashboard rather than half of it.
export const TourInsights = ({ range, scope }: TourInsightsProps) => (
  <>
    <InsightCard
      description="Each agent run and human input across your workspace"
      target="activity"
      title="Event activity"
    >
      <ActivityHeatmap
        label="Event activity"
        weeks={buildHeatmapWeeks(range, scope)}
      />
    </InsightCard>
    <InsightCard
      description="Model spend over time"
      target="models"
      title="Model spend over time"
    >
      <div className="h-80">
        <TimeSeriesAreaChart
          points={modelUsagePointsFor(range, scope)}
          series={modelUsageSeries}
          valueFormatter={formatCurrency}
        />
      </div>
    </InsightCard>
    <InsightCard
      description="PRs merged over time"
      target="prs"
      title="PR throughput"
    >
      <div className="h-72">
        <TimeSeriesAreaChart
          points={prTrendPointsFor(range, scope)}
          series={prTrendSeries}
        />
      </div>
    </InsightCard>
  </>
);

const InsightCard = ({
  children,
  description,
  target,
  title,
}: {
  children: ReactNode;
  description: string;
  target: string;
  title: string;
}) => (
  <Card data-tour={target}>
    <CardHeader>
      <CardTitle className="text-base">{title}</CardTitle>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
    <CardContent>{children}</CardContent>
  </Card>
);

const formatCurrency = (value: number) => `$${value.toLocaleString("en-US")}`;
