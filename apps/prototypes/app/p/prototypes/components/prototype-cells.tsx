"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { MessageSquareIcon } from "lucide-react";
import { PrototypeStatus, prototypeStatusLabel } from "@/lib/registry";
import type { Person, PrototypeRow } from "../mock";

export function PrototypeStatusChip({
  status,
}: {
  status: PrototypeRow["status"];
}) {
  let variant: "warning" | "success" | "info" | "muted" = "muted";
  if (status === PrototypeStatus.ReadyForReview) {
    variant = "warning";
  } else if (status === PrototypeStatus.HandedOff) {
    variant = "success";
  } else if (status === PrototypeStatus.InProgress) {
    variant = "info";
  }
  return (
    <Chip variant={variant}>
      <span className="size-1.5 rounded-full bg-current" />
      {prototypeStatusLabel[status]}
    </Chip>
  );
}

export function OwnerCell({ person }: { person: Person }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <PersonAvatar person={person} />
      <span className="truncate text-sm" title={person.name}>
        {person.name}
      </span>
    </span>
  );
}

export function CollaboratorsCell({ people }: { people: Person[] }) {
  const visiblePeople = people.slice(0, 3);
  const hiddenPeople = people.slice(3);

  return (
    <span className="flex items-center -space-x-1.5">
      {visiblePeople.map((person) => (
        <Tooltip key={person.id}>
          <TooltipTrigger asChild>
            <button
              aria-label={person.name}
              className="rounded-full ring-2 ring-background"
              type="button"
            >
              <PersonAvatar person={person} />
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
              className="flex size-5 items-center justify-center rounded-full bg-muted text-muted-foreground text-xs ring-2 ring-background"
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

export function TagsCell({ tags }: { tags: string[] }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      {tags.slice(0, 2).map((tag) => (
        <Chip className="max-w-24" key={tag} variant="muted">
          <span className="truncate">{tag}</span>
        </Chip>
      ))}
      {tags.length > 2 ? (
        <span className="text-muted-foreground text-xs">
          +{tags.length - 2}
        </span>
      ) : null}
    </span>
  );
}

export function OpenCommentsCell({ count }: { count: number }) {
  return (
    <Chip className="gap-1" variant="muted">
      <MessageSquareIcon aria-hidden className="size-3" />
      {count}
    </Chip>
  );
}

export function UpdatedCell({ item }: { item: PrototypeRow }) {
  return (
    <span className="truncate text-muted-foreground text-xs">
      {item.updated}
    </span>
  );
}

function PersonAvatar({ person }: { person: Person }) {
  return (
    <Avatar className="size-5 shrink-0">
      <AvatarFallback className="bg-muted text-muted-foreground text-xs">
        {person.initials}
      </AvatarFallback>
    </Avatar>
  );
}
