"use client";

import {
  Avatar,
  AvatarFallback,
  avatarInitial,
} from "@repo/design-system/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import type { Person } from "../mock";
export function AvatarLabel({ person }: { person: Person }) {
  return (
    <Avatar className="size-7">
      <AvatarFallback className={cn("text-[10px]", person.color)}>
        {avatarInitial(person.initials)}
      </AvatarFallback>
    </Avatar>
  );
}

export function PersonLabel({ person }: { person: Person }) {
  return (
    <span className="flex items-center gap-2 text-sm">
      <AvatarLabel person={person} />
      <span className="truncate">{person.name}</span>
    </span>
  );
}

export function AvatarStack({
  people,
  compact = false,
  maxVisible = people.length,
  wrap = false,
}: {
  people: Person[];
  compact?: boolean;
  maxVisible?: number;
  wrap?: boolean;
}) {
  const visiblePeople = people.slice(0, maxVisible);
  const hiddenPeople = people.slice(maxVisible);

  return (
    <span
      className={cn(
        "flex",
        wrap ? "max-w-32 flex-wrap gap-1.5" : "-space-x-1.5"
      )}
    >
      {visiblePeople.map((person) => (
        <Tooltip key={person.id}>
          <TooltipTrigger asChild>
            <button
              aria-label={person.name}
              className="rounded-full ring-2 ring-background"
              type="button"
            >
              <Avatar className={compact ? "size-5" : "size-7"}>
                <AvatarFallback className={cn("text-xs", person.color)}>
                  {avatarInitial(person.initials)}
                </AvatarFallback>
              </Avatar>
            </button>
          </TooltipTrigger>
          <TooltipContent>{person.name}</TooltipContent>
        </Tooltip>
      ))}
      {hiddenPeople.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={hiddenPeople.map((person) => person.name).join(", ")}
              className={cn(
                "flex items-center justify-center rounded-full bg-muted text-muted-foreground ring-2 ring-background",
                compact ? "size-5 text-xs" : "size-7 text-xs"
              )}
              type="button"
            >
              +{hiddenPeople.length}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {hiddenPeople.map((person) => person.name).join(", ")}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}
