"use client";

import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import type { Tone } from "@repo/design-system/components/ui/types";
import { Link } from "@repo/navigation/link";
import { ActivityIcon, Clock3Icon } from "lucide-react";
import { useAgentSessions } from "../../hooks/use-agent-sessions";
import { DegradedState } from "../shared/degraded-state";
import {
  type AgentSessionActivity,
  type AgentSessionActivityHrefItem,
  AgentSessionActivityStatus,
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
  // FEA-4051: surface-agnostic `@repo/navigation` `Link` (renders a real
  // anchor) drives the active adapter on both web (Next router) and the desktop
  // renderer (hash-store adapter). A raw `<a href>` was a dead click on desktop.
  // Mirrors FEA-4018's agents-table fix.
  const sessionHref = activity.sessionHref;
  const isNavigable = sessionHref !== null;
  const title = sessionHref ? (
    <Link className="font-medium hover:underline" href={sessionHref}>
      {activity.label}
    </Link>
  ) : (
    <span className="font-medium">{activity.label}</span>
  );

  return (
    // A navigable row gets a whole-box hover treatment so the padded card reads
    // as the target of its title link, instead of a bordered box where only the
    // name string is clickable. The `Link` in the title stays the real anchor
    // (accessible name + keyboard focus); this is a visual affordance only.
    <div
      className={
        isNavigable
          ? "rounded-md border p-4 transition-colors hover:bg-muted/40"
          : "rounded-md border p-4"
      }
    >
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {title}
            <ToneBadge
              label={activity.status}
              tone={activityStatusTone(activity.status)}
            />
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

const ACTIVITY_STATUS_TONE: Record<AgentSessionActivityStatus, Tone> = {
  [AgentSessionActivityStatus.Active]: "success",
  [AgentSessionActivityStatus.AwaitingInput]: "accent",
  // ISS-4586: terminal-not-failed reads muted, matching the SessionStatusBadge.
  // ISS-4654 (review, #4651): the Completed and Abandoned entries went with
  // their statuses. Abandoned was the last amber outcome in this slice — a
  // `warning` tone on a run nobody observed failing.
  [AgentSessionActivityStatus.Inactive]: "muted",
  [AgentSessionActivityStatus.Failed]: "danger",
  [AgentSessionActivityStatus.Updated]: "default",
};

/**
 * Tones each activity status so Failed reads as danger and a finished run reads
 * muted instead of every row sharing one flat secondary chip. Mirrors the tone
 * vocabulary `SessionStatusBadge` uses for the same session lifecycle.
 */
function activityStatusTone(status: AgentSessionActivityStatus): Tone {
  return ACTIVITY_STATUS_TONE[status];
}
