"use client";

import type { DashboardStats } from "@repo/api/src/types/dashboard";
import { DashboardStatCards } from "@/app/(authenticated)/components/dashboard-stat-cards";

type Props = {
  stats: DashboardStats;
};

export function PublicDashboardStatsGrid({ stats }: Props) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <DashboardStatCards stats={stats} />
    </div>
  );
}
