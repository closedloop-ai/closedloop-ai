"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Share2Icon } from "lucide-react";
import type { PersonProfile } from "../mock";

// Profile identity block: avatar, name, title/org, and a share affordance. The
// range control used to live here, but it only ever drove the Headlines
// section below, so it moved down into that section's own header (#4285
// review) — this block is now range-agnostic lifetime identity. Used at the
// top of the in-app profile page.

export function ProfileHeader({
  person,
  onShare,
}: {
  person: PersonProfile;
  onShare: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-center gap-4">
        <Avatar className="size-16">
          <AvatarFallback className="font-semibold text-lg">
            {person.initials}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 space-y-1">
          <h1 className="truncate font-semibold text-2xl tracking-tight">
            {person.name}
          </h1>
          <p className="text-muted-foreground text-sm">{person.title}</p>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Badge variant="muted">@{person.handle}</Badge>
            <span className="text-muted-foreground text-xs">
              {person.joinedLabel}
            </span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onShare} variant="outline">
          <Share2Icon aria-hidden="true" />
          Share profile
        </Button>
      </div>
    </div>
  );
}
