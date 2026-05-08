"use client";

import type { ActivityItem } from "@repo/api/src/types/activity";
import { ExternalLinkIcon } from "lucide-react";
import { UserLink } from "@/components/user-link";

type OverviewActivityProps = {
  activities: ActivityItem[];
};

export function OverviewActivity({ activities }: OverviewActivityProps) {
  return (
    <div className="space-y-3">
      <h3 className="font-medium text-lg">Activity</h3>
      {activities.length === 0 ? (
        <p className="text-muted-foreground text-sm">No activity yet.</p>
      ) : (
        <div className="space-y-2">
          {activities.map((activity) => (
            <p className="text-sm" key={activity.id}>
              {activity.actor ? (
                <UserLink
                  className="font-medium hover:underline"
                  userId={activity.actor.id}
                >
                  {activity.actor.name}
                </UserLink>
              ) : null}{" "}
              {(activity.type === "GITHUB_PR_CREATED" ||
                activity.type === "GITHUB_PR_MERGED") &&
              activity.metadata?.prUrl ? (
                <a
                  className="text-primary hover:underline"
                  href={activity.metadata.prUrl as string}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {activity.description}{" "}
                  <ExternalLinkIcon className="ml-1 inline h-3 w-3" />
                </a>
              ) : (
                <span className="text-muted-foreground">
                  {activity.description}
                </span>
              )}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
