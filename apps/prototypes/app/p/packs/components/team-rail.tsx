"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import type { ActivityEvent } from "../mock";

const ActivityList = ({
  events,
  onSelectPackId,
}: {
  events: readonly ActivityEvent[];
  onSelectPackId: (packId: string) => void;
}) => (
  <Card>
    <CardHeader>
      <CardTitle className="text-base">Team activity</CardTitle>
    </CardHeader>
    <CardContent className="space-y-3">
      {events.map((event) => (
        <p className="text-sm" key={event.id}>
          <span className="font-medium">{event.user}</span>{" "}
          <span className="text-muted-foreground">{event.action}</span>{" "}
          <button
            className="font-medium hover:underline"
            onClick={() => onSelectPackId(event.packId)}
            type="button"
          >
            {event.packName}
          </button>
          <span className="block text-muted-foreground text-xs">
            {event.agoLabel}
          </span>
        </p>
      ))}
    </CardContent>
  </Card>
);

export const TeamRail = ({
  activity,
  onSelectPackId,
}: {
  activity: readonly ActivityEvent[];
  onSelectPackId: (packId: string) => void;
}) => (
  <div className="space-y-4">
    <ActivityList events={activity} onSelectPackId={onSelectPackId} />
  </div>
);
