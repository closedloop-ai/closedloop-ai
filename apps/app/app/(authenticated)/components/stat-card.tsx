"use client";

import { memo, useMemo } from "react";
import { Area, AreaChart } from "recharts";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Card } from "@repo/design-system/components/ui/card";
import { ChartContainer } from "@repo/design-system/components/ui/chart";
import { cn } from "@repo/design-system/lib/utils";

interface StatCardProps {
  value: number;
  label: string;
  trendData: Array<{ date: string; count: number }>;
  comingSoon?: boolean;
}

export const StatCard = memo(
  ({ value, label, trendData, comingSoon }: StatCardProps) => {
    // Transform trendData for Recharts consumption
    const chartData = useMemo(() => {
      return trendData.map((item) => ({
        date: item.date,
        count: item.count,
      }));
    }, [trendData]);

    // Generate unique gradient ID based on label
    const gradientId = `gradient-${label.replace(/\s+/g, "-").toLowerCase()}`;

    return (
      <Card
        className={cn(
          "relative",
          comingSoon && "opacity-60"
        )}
        style={{
          background: "linear-gradient(to bottom right, hsl(var(--card)), hsl(var(--muted)))",
        }}
      >
        <div className="p-6">
          {/* Main stat display */}
          <div className="text-4xl font-bold">{value.toLocaleString()}</div>

          {/* Label */}
          <p className="text-sm text-muted-foreground mt-1">{label}</p>

          {/* Sparkline chart */}
          {chartData.length > 0 && (
            <div className="mt-4 h-[50px]" aria-label={`${label} trend over last 2 weeks`}>
              <ChartContainer
                config={{
                  count: {
                    label: "Count",
                    color: "hsl(var(--primary))",
                  },
                }}
              >
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.8} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.1} />
                    </linearGradient>
                  </defs>
                  <Area
                    type="monotone"
                    dataKey="count"
                    stroke="hsl(var(--primary))"
                    fill={`url(#${gradientId})`}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ChartContainer>
            </div>
          )}

          {/* Coming Soon badge */}
          {comingSoon && (
            <Badge variant="secondary" className="mt-2">
              Coming Soon
            </Badge>
          )}
        </div>
      </Card>
    );
  }
);

StatCard.displayName = "StatCard";
