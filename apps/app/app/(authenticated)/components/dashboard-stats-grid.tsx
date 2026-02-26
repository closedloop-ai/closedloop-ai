"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { useDashboardStats } from "@/hooks/queries/use-dashboard-stats";
import { DashboardStatCards } from "./dashboard-stat-cards";
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
    const skeletonKeys = [
      "skeleton-prds",
      "skeleton-issues",
      "skeleton-plans",
      "skeleton-landed-code",
      "skeleton-agentic-workflows",
      "skeleton-agents-skills-plugins",
      "skeleton-leaderboards",
    ] as const;

    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {skeletonKeys.map((key) => (
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
      <DashboardStatCards stats={stats} />

      {/* Agents/Skills/Plugins (placeholder) */}
      <StatCard
        comingSoon={true}
        label="Agents, Skills & Plugins"
        trendData={[]}
        value={stats.agentsCount ?? 0}
      />

      {/* Active Leaderboards (placeholder) */}
      <StatCard
        comingSoon={true}
        label="Active Leaderboards"
        trendData={[]}
        value={stats.leaderboardsCount ?? 0}
      />
    </div>
  );
}
