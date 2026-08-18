import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { ActivityHeatmap } from "@repo/design-system/components/ui/primitives/activity-heatmap";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import {
  heatmapWeeks,
  modelUsagePoints,
  modelUsageSeries,
  prTrendPoints,
  prTrendSeries,
} from "../mock";

export const TourInsights = () => (
  <>
    <InsightCard
      description="Each agent run and human input on this machine"
      target="activity"
      title="Event activity"
    >
      <ActivityHeatmap label="Event activity" weeks={heatmapWeeks} />
    </InsightCard>
    <InsightCard
      description="Model spend over time"
      target="models"
      title="Model spend over time"
    >
      <div className="h-80">
        <TimeSeriesAreaChart
          points={modelUsagePoints}
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
        <TimeSeriesAreaChart points={prTrendPoints} series={prTrendSeries} />
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
  children: React.ReactNode;
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
