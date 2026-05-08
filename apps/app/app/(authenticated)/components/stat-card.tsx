"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Card } from "@repo/design-system/components/ui/card";
import { cn } from "@repo/design-system/lib/utils";
import dynamic from "next/dynamic";
import { memo, useMemo } from "react";

const StatSparkline = dynamic(
  () => import("./stat-sparkline").then((mod) => mod.StatSparkline),
  { ssr: false }
);

type StatCardProps = {
  value: number;
  label: string;
  trendData: Array<{ date: string; count: number }>;
  comingSoon?: boolean;
};

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
        className={cn("relative overflow-hidden", comingSoon && "opacity-60")}
        style={{
          background:
            "linear-gradient(to bottom right, hsl(var(--card)), hsl(var(--muted)))",
        }}
      >
        <div className="p-6">
          {/* Main stat display */}
          <div className="font-bold text-4xl">{value.toLocaleString()}</div>

          {/* Label */}
          <p className="mt-1 text-muted-foreground text-sm">{label}</p>

          {/* Sparkline chart */}
          {chartData.length > 0 && (
            <div
              aria-label={`${label} trend over last 2 weeks`}
              className="mt-4 h-[50px]"
              role="img"
            >
              <StatSparkline chartData={chartData} gradientId={gradientId} />
            </div>
          )}

          {/* Coming Soon badge */}
          {comingSoon && (
            <Badge className="mt-2" variant="secondary">
              Coming Soon
            </Badge>
          )}
        </div>
      </Card>
    );
  }
);

StatCard.displayName = "StatCard";
