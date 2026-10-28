"use client";

import type { WorkspaceMenuActor } from "@repo/api/src/types/workspace-menu";
import { DropdownMenuLabel } from "@repo/design-system/components/ui/dropdown-menu";
import { PersonAvatar } from "@repo/design-system/components/ui/person-avatar";

/**
 * The signed-in account row: the actor's avatar beside the address the menu
 * states them by.
 *
 * ONE component for BOTH of the places the menu can state that address — the
 * switcher submenu when it renders, and the menu body when it does not. The two
 * already read the same capability predicate to decide WHICH of them speaks
 * (`hasSwitcherSubmenu`); this keeps them from disagreeing about WHAT it looks
 * like once one does.
 *
 * ISS-11465: `actor.imageUrl` had no render site at all before this. Both host
 * adapters populated it — web from its Clerk hooks, desktop from
 * `GET /desktop/identity` — and the menu dropped it on the floor, so the user
 * avatar appeared nowhere on either surface. The ADDRESS is what identifies the
 * account; the avatar at this size reads as texture and never carries that
 * alone.
 */
export function WorkspaceMenuAccountLabel({
  actor,
}: {
  actor: WorkspaceMenuActor;
}) {
  const word = actor.email ?? actor.name ?? "Signed in";

  return (
    <DropdownMenuLabel className="flex items-center gap-2 font-normal text-muted-foreground">
      <PersonAvatar
        avatarUrl={actor.imageUrl}
        className="size-6 shrink-0 rounded-md"
        fallbackClassName="rounded-md text-[10px]"
        initials={word.charAt(0).toUpperCase()}
        name={word}
      />
      <span className="truncate">{word}</span>
    </DropdownMenuLabel>
  );
}
