"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { DownloadIcon, ExternalLinkIcon } from "lucide-react";
import {
  installCount,
  type PackActivityEvent,
  type PackView,
} from "../lib/pack-view";
import type { PacksContext } from "../lib/packs-context";
import { UserPill } from "./pack-meta";

// The compact per-row action: local install on desktop, GitHub redirect on web.
const RecommendedAction = ({
  pack,
  context,
  onInstall,
}: {
  pack: PackView;
  context: PacksContext;
  onInstall?: (packId: string) => void;
}) => {
  if (context.capabilities.installLocally && onInstall) {
    return (
      <Button onClick={() => onInstall(pack.id)} size="sm" variant="outline">
        <DownloadIcon className="size-3.5" />
        <span className="sr-only">Install {pack.name}</span>
      </Button>
    );
  }
  if (pack.githubUrl) {
    return (
      <Button asChild size="sm" variant="outline">
        <a href={pack.githubUrl} rel="noreferrer" target="_blank">
          <ExternalLinkIcon className="size-3.5" />
          <span className="sr-only">Open {pack.name} on GitHub</span>
        </a>
      </Button>
    );
  }
  return null;
};

// Packs several teammates run that the current user has not installed yet,
// ranked by team adoption — the core "what is the rest of the team using" signal.
const RecommendedList = ({
  packs,
  context,
  onSelect,
  onInstall,
}: {
  packs: readonly PackView[];
  context: PacksContext;
  onSelect: (packId: string) => void;
  onInstall?: (packId: string) => void;
}) => (
  <Card>
    <CardHeader>
      <CardTitle className="text-base">Recommended for you</CardTitle>
      <CardDescription>
        Popular with your team, not yet in your setup.
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-1">
      {packs.map((pack) => (
        <div
          className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted/40"
          key={pack.id}
        >
          <button
            className="min-w-0 text-left"
            onClick={() => onSelect(pack.id)}
            type="button"
          >
            <div className="truncate font-medium text-sm">{pack.name}</div>
            <div className="text-muted-foreground text-xs">
              {installCount(pack)} teammates use this
            </div>
          </button>
          <RecommendedAction
            context={context}
            onInstall={onInstall}
            pack={pack}
          />
        </div>
      ))}
    </CardContent>
  </Card>
);

const ActivityList = ({
  events,
  onSelectPackId,
}: {
  events: readonly PackActivityEvent[];
  onSelectPackId: (packId: string) => void;
}) => (
  <Card>
    <CardHeader>
      <CardTitle className="text-base">Team activity</CardTitle>
      <CardDescription>Recent installs across your team.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {events.length === 0 ? (
        <p className="text-muted-foreground text-sm">No recent activity.</p>
      ) : (
        events.map((event) => (
          <div className="flex items-start gap-2 text-sm" key={event.id}>
            <UserPill user={event.user} />
            <p className="min-w-0">
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
          </div>
        ))
      )}
    </CardContent>
  </Card>
);

export const TeamRail = ({
  recommended,
  activity,
  context,
  onSelect,
  onInstall,
}: {
  recommended: readonly PackView[];
  activity: readonly PackActivityEvent[];
  context: PacksContext;
  onSelect: (packId: string) => void;
  onInstall?: (packId: string) => void;
}) => (
  <div className="space-y-4">
    {recommended.length > 0 ? (
      <RecommendedList
        context={context}
        onInstall={onInstall}
        onSelect={onSelect}
        packs={recommended}
      />
    ) : null}
    {context.capabilities.showActivity ? (
      <ActivityList events={activity} onSelectPackId={onSelect} />
    ) : null}
  </div>
);
