"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./experimental/tooltip";

export const artifactPeople = [
  "Andrew Eye",
  "Parker Byrd",
  "Sam Chen",
  "Jordan Lee",
] as const;
const PERSON_NAME_PARTS_PATTERN = /\s+/;

export function personInitials(name: string) {
  return name
    .split(PERSON_NAME_PARTS_PATTERN)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function ArtifactPeopleStack({ names }: { names: readonly string[] }) {
  const uniqueNames = [...new Set(names)];
  const visibleNames = uniqueNames.slice(0, 4);
  const overflowCount = uniqueNames.length - visibleNames.length;
  if (uniqueNames.length === 0) {
    return null;
  }
  return (
    <div className="flex items-center -space-x-1.5">
      <span className="sr-only">Collaborators: {uniqueNames.join(", ")}</span>
      {visibleNames.map((name) => (
        <Tooltip delayDuration={150} key={name}>
          <TooltipTrigger asChild>
            <Avatar
              aria-label={name}
              className="size-7 cursor-default border-2 border-background"
            >
              <AvatarFallback className="bg-primary/15 text-[10px] text-primary">
                {personInitials(name)}
              </AvatarFallback>
            </Avatar>
          </TooltipTrigger>
          <TooltipContent align="center" side="bottom">
            {name}
          </TooltipContent>
        </Tooltip>
      ))}
      {overflowCount > 0 ? (
        <Tooltip delayDuration={150}>
          <TooltipTrigger asChild>
            <span className="ml-2 cursor-default text-muted-foreground text-xs">
              +{overflowCount}
            </span>
          </TooltipTrigger>
          <TooltipContent>{uniqueNames.slice(4).join(", ")}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
