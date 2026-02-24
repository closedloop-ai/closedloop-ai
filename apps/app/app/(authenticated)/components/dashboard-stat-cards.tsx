"use client";

import type { DashboardStats } from "@repo/api/src/types/dashboard";
import { StatCard } from "./stat-card";

type Props = {
  stats: DashboardStats;
};

export function DashboardStatCards({ stats }: Props) {
  return (
    <>
      <StatCard
        label="PRDs"
        trendData={stats.prds.trend}
        value={stats.prds.count}
      />
      <StatCard
        label="Issues"
        trendData={stats.issues.trend}
        value={stats.issues.count}
      />
      <StatCard
        label="Implementation Plans"
        trendData={stats.plans.trend}
        value={stats.plans.count}
      />
      <StatCard
        label="Landed Code"
        trendData={stats.landedCode.trend}
        value={stats.landedCode.count}
      />
      <StatCard
        label="Agentic Workflows"
        trendData={stats.agenticWorkflows.trend}
        value={stats.agenticWorkflows.count}
      />
    </>
  );
}
