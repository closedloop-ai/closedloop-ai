"use client";

import { Alert, AlertDescription } from "@repo/design-system/components/ui/alert";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { useDashboardStats } from "@/hooks/queries/use-dashboard-stats";
import { StatCard } from "./stat-card";

export function DashboardStatsGrid() {
  const {
    data: stats,
    isLoading,
    error,
  } = useDashboardStats({
    placeholderData: (previousData) => previousData,
  });

  // Loading state with skeleton grid
  if (isLoading && !stats) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-[200px]" />
        ))}
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Failed to load dashboard statistics</AlertDescription>
      </Alert>
    );
  }

  // No data fallback
  if (!stats) {
    return null;
  }

  // Main render: responsive grid with 7 StatCard instances
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {/* 1. PRDs */}
      <StatCard value={stats.prds.count} label="PRDs" trendData={stats.prds.trend} />

      {/* 2. Issues */}
      <StatCard value={stats.issues.count} label="Issues" trendData={stats.issues.trend} />

      {/* 3. Implementation Plans */}
      <StatCard
        value={stats.plans.count}
        label="Implementation Plans"
        trendData={stats.plans.trend}
      />

      {/* 4. Landed Code */}
      <StatCard
        value={stats.landedCode.count}
        label="Landed Code"
        trendData={stats.landedCode.trend}
      />

      {/* 5. Agentic Workflows */}
      <StatCard
        value={stats.agenticWorkflows.count}
        label="Agentic Workflows"
        trendData={stats.agenticWorkflows.trend}
      />

      {/* 6. Agents/Skills/Plugins (placeholder) */}
      <StatCard
        value={stats.agentsCount ?? 0}
        label="Agents, Skills & Plugins"
        trendData={[]}
        comingSoon={true}
      />

      {/* 7. Active Leaderboards (placeholder) */}
      <StatCard
        value={stats.leaderboardsCount ?? 0}
        label="Active Leaderboards"
        trendData={[]}
        comingSoon={true}
      />
    </div>
  );
}
