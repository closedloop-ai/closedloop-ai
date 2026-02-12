"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
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
        {["s1", "s2", "s3", "s4", "s5", "s6", "s7"].map((key) => (
          <Skeleton className="h-[200px]" key={key} />
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
      <StatCard
        label="PRDs"
        trendData={stats.prds.trend}
        value={stats.prds.count}
      />

      {/* 2. Issues */}
      <StatCard
        label="Issues"
        trendData={stats.issues.trend}
        value={stats.issues.count}
      />

      {/* 3. Implementation Plans */}
      <StatCard
        label="Implementation Plans"
        trendData={stats.plans.trend}
        value={stats.plans.count}
      />

      {/* 4. Landed Code */}
      <StatCard
        label="Landed Code"
        trendData={stats.landedCode.trend}
        value={stats.landedCode.count}
      />

      {/* 5. Agentic Workflows */}
      <StatCard
        label="Agentic Workflows"
        trendData={stats.agenticWorkflows.trend}
        value={stats.agenticWorkflows.count}
      />

      {/* 6. Agents/Skills/Plugins (placeholder) */}
      <StatCard
        comingSoon={true}
        label="Agents, Skills & Plugins"
        trendData={[]}
        value={stats.agentsCount ?? 0}
      />

      {/* 7. Active Leaderboards (placeholder) */}
      <StatCard
        comingSoon={true}
        label="Active Leaderboards"
        trendData={[]}
        value={stats.leaderboardsCount ?? 0}
      />
    </div>
  );
}
