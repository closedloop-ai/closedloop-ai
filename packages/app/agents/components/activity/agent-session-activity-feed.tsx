"use client";

import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { ActivityIcon, Clock3Icon } from "lucide-react";
import { useAgentSessions } from "../../hooks/use-agent-sessions";
import { DegradedState } from "../shared/degraded-state";
import {
  type AgentSessionActivity,
  type AgentSessionActivityHrefItem,
  projectAgentSessionActivities,
} from "./activity-projection";

const ACTIVITY_LIMIT = 50;

export type AgentSessionActivityFeedProps = {
  getSessionHref?: (item: AgentSessionActivityHrefItem) => string;
};

/**
 * Shared package-only activity feed derived from existing list rows. The feed
 * does not query detail or raw event endpoints.
 */
export function AgentSessionActivityFeed({
  getSessionHref,
}: Readonly<AgentSessionActivityFeedProps>) {
  const sessionsQuery = useAgentSessions({ limit: ACTIVITY_LIMIT, offset: 0 });
  const activities = projectAgentSessionActivities(
    sessionsQuery.data?.items ?? [],
    {
      getSessionHref: getSessionHref
        ? (_sessionId, item) => getSessionHref(item)
        : undefined,
    }
  );

  if (sessionsQuery.isLoading) {
    return <Skeleton className="h-[420px] w-full" />;
  }

  if (sessionsQuery.isError) {
    return <DegradedState message="Activity is temporarily unavailable." />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ActivityIcon className="h-4 w-4" />
          Session Activity
        </CardTitle>
        <CardDescription>
          Recent updates from synced agent sessions.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {activities.length === 0 ? (
          <EmptyState
            className="py-12"
            description="No synced session activity is available yet."
            icon={Clock3Icon}
            title="No activity"
          />
        ) : (
          <div className="space-y-3">
            {activities.map((activity) => (
              <ActivityRow activity={activity} key={activity.activityId} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityRow({
  activity,
}: Readonly<{
  activity: AgentSessionActivity;
}>) {
  const title = activity.sessionHref ? (
    <a className="font-medium hover:underline" href={activity.sessionHref}>
      {activity.label}
    </a>
  ) : (
    <span className="font-medium">{activity.label}</span>
  );

  return (
    <div className="rounded-md border p-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {title}
            <Badge variant="secondary">{activity.status}</Badge>
          </div>
          <p className="whitespace-pre-wrap text-muted-foreground text-sm">
            {activity.summary}
          </p>
        </div>
        <div className="shrink-0 text-muted-foreground text-sm">
          {activity.timestamp
            ? formatRelativeTime(activity.timestamp)
            : "Undated"}
        </div>
      </div>
      {activity.metadata.length > 0 ? (
        <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          {activity.metadata.map((entry) => (
            <div className="min-w-0" key={`${entry.label}:${entry.value}`}>
              <dt className="text-muted-foreground">{entry.label}</dt>
              <dd className="truncate font-medium">{entry.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
