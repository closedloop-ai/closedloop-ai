"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { use } from "react";
import { usePublicDashboard } from "@/hooks/queries/use-public-dashboard";
import { PublicDashboardStatsGrid } from "./components/public-dashboard-stats-grid";

type Props = {
  params: Promise<{ token: string }>;
};

export default function PublicDashboardPage({ params }: Props) {
  const { token } = use(params);
  const { data, isLoading, error } = usePublicDashboard(token);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl p-8">
        <Skeleton className="mb-8 h-10 w-64" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 5 }, (_, i) => `skeleton-${i}`).map((key) => (
            <Skeleton className="h-[200px]" key={key} />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-6xl p-8">
        <Alert variant="destructive">
          <AlertDescription>
            This dashboard link is invalid or has been revoked.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl p-8">
      <h1 className="mb-8 font-bold text-3xl">{data.organizationName}</h1>
      <section>
        <h2 className="mb-4 font-bold text-2xl">Overview</h2>
        <PublicDashboardStatsGrid stats={data.stats} />
      </section>
    </div>
  );
}
