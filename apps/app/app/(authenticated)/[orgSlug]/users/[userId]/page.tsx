"use client";

import type { User, UserProfileStats } from "@repo/api/src/types/user";
import {
  formatNumber,
  formatTokenCount,
} from "@repo/app/shared/lib/format-utils";
import { useUser, useUserStats } from "@repo/app/users/hooks/use-users";
import { Alert, AlertTitle } from "@repo/design-system/components/ui/alert";
import { Card } from "@repo/design-system/components/ui/card";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import dynamic from "next/dynamic";
import { use } from "react";
import { Header } from "../../../components/header";
import { DocumentsByTypeChart } from "./components/documents-by-type-chart";
import { UserProfileHeader } from "./components/user-profile-header";

const ContributionHeatmap = dynamic(
  () =>
    import("./components/contribution-heatmap").then(
      (mod) => mod.ContributionHeatmap
    ),
  { ssr: false }
);

type PageProps = {
  params: Promise<{ orgSlug: string; userId: string }>;
};

const SKELETON_KEYS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];

export default function UserProfilePage({ params }: PageProps) {
  const { orgSlug, userId } = use(params);
  const { data: user, isLoading: userLoading } = useUser(userId);
  const { data: stats, isLoading: statsLoading } = useUserStats(userId);

  const fullName = user
    ? [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email
    : "User";

  return (
    <>
      <Header
        breadcrumbs={[
          { label: "Users", href: `/${orgSlug}` },
          { label: fullName },
        ]}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
        {/* Profile Header */}
        <ProfileHeaderSection isLoading={userLoading} user={user ?? null} />

        {/* Stats Grid */}
        <StatsSection isLoading={statsLoading} stats={stats ?? null} />
      </div>
    </>
  );
}

function ProfileHeaderSection({
  isLoading,
  user,
}: {
  isLoading: boolean;
  user: User | null;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-4">
        <Skeleton className="h-16 w-16 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
    );
  }
  if (user) {
    return <UserProfileHeader user={user} />;
  }
  return (
    <Alert variant="error">
      <AlertTitle>User not found</AlertTitle>
    </Alert>
  );
}

function StatsSection({
  isLoading,
  stats,
}: {
  isLoading: boolean;
  stats: UserProfileStats | null;
}) {
  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {SKELETON_KEYS.map((key) => (
          <Skeleton className="h-24" key={key} />
        ))}
      </div>
    );
  }
  if (!stats) {
    return null;
  }
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <StatTile label="Artifacts Created" value={stats.totalDocuments} />
        <StatTile label="PRs Landed" value={stats.totalPRsLanded} />
        <StatTile label="Comments" value={stats.totalComments} />
        <StatTile label="Loops Initiated" value={stats.totalLoops} />
        <StatTile label="Avg Loop Concurrency" value={stats.avgConcurrency} />
        <StatTile
          label="Input Tokens"
          value={formatTokenCount(stats.totalTokensInput)}
        />
        <StatTile
          label="Output Tokens"
          value={formatTokenCount(stats.totalTokensOutput)}
        />
        <StatTile
          label="Estimated Cost"
          value={`$${stats.totalEstimatedCost.toFixed(2)}`}
        />
      </div>

      {/* Contribution Heatmap */}
      <section className="space-y-4">
        <h2 className="font-semibold text-xl">Contributions</h2>
        <Card className="overflow-hidden p-4">
          <ContributionHeatmap data={stats.contributionHeatmap} />
        </Card>
      </section>

      {/* Artifacts by Type */}
      <section className="space-y-4">
        <h2 className="font-semibold text-xl">Artifacts by Type</h2>
        <Card className="p-4">
          <DocumentsByTypeChart data={stats.documentsByType} />
        </Card>
      </section>
    </>
  );
}

function StatTile({ label, value }: { label: string; value: string | number }) {
  const display = typeof value === "string" ? value : formatNumber(value);
  return (
    <Card
      className="p-6"
      style={{
        background:
          "linear-gradient(to bottom right, hsl(var(--card)), hsl(var(--muted)))",
      }}
    >
      <div className="font-bold text-4xl">{display}</div>
      <p className="mt-1 text-muted-foreground text-sm">{label}</p>
    </Card>
  );
}
