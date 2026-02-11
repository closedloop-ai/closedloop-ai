"use client";

import type { ActivityItem } from "@repo/api/src/types/activity";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { formatDistanceToNow } from "date-fns";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useState } from "react";

type ActivityPanelProps = {
  activities: ActivityItem[];
};

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function formatActivityTimestamp(timestamp: Date | string): string {
  try {
    const date =
      typeof timestamp === "string" ? new Date(timestamp) : timestamp;
    return formatDistanceToNow(date, { addSuffix: true });
  } catch {
    return typeof timestamp === "string"
      ? timestamp
      : timestamp.toLocaleDateString();
  }
}

export function ActivityPanel({ activities }: ActivityPanelProps) {
  const [isOpen, setIsOpen] = useState(true);

  if (activities.length === 0) {
    return (
      <Collapsible onOpenChange={setIsOpen} open={isOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg p-3 font-medium text-sm transition-colors hover:bg-accent">
          <span>Activity</span>
          {isOpen ? (
            <ChevronUpIcon className="h-4 w-4" />
          ) : (
            <ChevronDownIcon className="h-4 w-4" />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent className="px-3 pb-3">
          <p className="text-muted-foreground text-sm">No activity yet.</p>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <Collapsible onOpenChange={setIsOpen} open={isOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg p-3 font-medium text-sm transition-colors hover:bg-accent">
        <span>Activity</span>
        {isOpen ? (
          <ChevronUpIcon className="h-4 w-4" />
        ) : (
          <ChevronDownIcon className="h-4 w-4" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 px-3 pb-3">
        {activities.map((activity) => (
          <div className="flex gap-3" key={activity.id}>
            {activity.actor ? (
              <Avatar className="h-8 w-8 shrink-0">
                {activity.actor.avatarUrl ? (
                  <AvatarImage
                    alt={activity.actor.name}
                    src={activity.actor.avatarUrl}
                  />
                ) : null}
                <AvatarFallback className="text-xs">
                  {getInitials(activity.actor.name)}
                </AvatarFallback>
              </Avatar>
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="text-sm">
                {activity.actor ? (
                  <span className="font-medium">{activity.actor.name} </span>
                ) : null}
                <span className="text-muted-foreground">
                  {activity.description}
                </span>
              </p>
              <p className="mt-0.5 text-muted-foreground text-xs">
                {formatActivityTimestamp(activity.timestamp)}
              </p>
            </div>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
