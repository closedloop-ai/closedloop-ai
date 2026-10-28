"use client";

import { getInitials } from "@repo/app/shared/lib/user-utils";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import {
  PERSON_AVATAR_PRIMARY_FALLBACK_CLASS_NAME,
  PersonAvatar,
} from "@repo/design-system/components/ui/person-avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";

const VISIBLE_COLLABORATORS = 3;

export type CollaboratorPerson = {
  /**
   * What IDENTITY means here, and never the name: two different users called
   * "Alex Smith" collapsed into one avatar — and one short count — when a stack
   * deduped on the display name (whitlockk review, PR #8461). Callers build it from
   * the provider-scoped person key.
   */
  key: string;
  name: string;
  avatarUrl?: string;
};

/** The Branches list's Collaborators cell, lifted out so any surface can mount it. */
export function Collaborators({
  people,
}: {
  people: readonly CollaboratorPerson[];
}) {
  // One human reported by two sources is one avatar and counts once. Both the
  // rendered stack and the `+N` read this, so they cannot disagree about how
  // many people there are (ISS-12273, operator ruling 2026-10-08).
  const unique = [
    ...new Map(people.map((person) => [person.key, person])).values(),
  ];
  if (unique.length === 0) {
    return <GridEmptyValue />;
  }
  const visible = unique.slice(0, VISIBLE_COLLABORATORS);
  const overflow = unique.slice(VISIBLE_COLLABORATORS);
  return (
    <span
      aria-label={nameList(unique)}
      className="flex items-center -space-x-0.5"
      role="img"
    >
      {visible.map((person) => {
        // The name on hover, for the reader who can see the avatar but does not
        // recognise it (whitlockk review, PR #8621). The accessibility tree already
        // carries every name on the wrapper, so the avatar stays decorative and
        // nothing is announced twice.
        return (
          <Tooltip delayDuration={150} key={person.key}>
            <TooltipTrigger asChild>
              <PersonAvatar
                avatarUrl={person.avatarUrl}
                className={`${COLLABORATOR_AVATAR_SIZE_CLASS_NAME} cursor-default ring-2 ring-background`}
                decorative
                fallbackClassName={`${PERSON_AVATAR_PRIMARY_FALLBACK_CLASS_NAME} font-medium`}
                initials={getInitials(person.name)}
                name={person.name}
              />
            </TooltipTrigger>
            <TooltipContent align="center" side="bottom">
              {person.name}
            </TooltipContent>
          </Tooltip>
        );
      })}
      {/* `+N` is the only place the hidden people are reachable at all, so it
          names them rather than just counting them.

          `relative`, and never a z-index (ISS-12307). Static would hide the chip
          under the `relative` avatar it overlaps, and the chip must stay below
          the sticky grid header's `z-10`. `z-index: auto` does both. */}
      {overflow.length > 0 ? (
        <Tooltip delayDuration={150}>
          <TooltipTrigger asChild>
            <span
              aria-hidden
              className="relative flex size-6 cursor-default items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground ring-2 ring-background"
            >
              +{overflow.length}
            </span>
          </TooltipTrigger>
          <TooltipContent align="center" side="bottom">
            {nameList(overflow)}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  );
}

/**
 * A fixture's people, where the display name is the only identity there is.
 *
 * Only for a design-reference or story fixture. A production caller builds the
 * key from the provider-qualified person key, because the name is NOT identity
 * (PR #8461) — the two Alex Smiths this widget must keep apart would collapse
 * if a real surface routed through here.
 */
export function collaboratorsFromNames(
  names: readonly string[]
): CollaboratorPerson[] {
  return names.map((name) => ({ key: name, name }));
}

function nameList(people: readonly CollaboratorPerson[]): string {
  return people.map((person) => person.name).join(", ");
}

/**
 * The Collaborators stack's avatar size on every mount: the Branches grid, the
 * Branch and Session headers, and Details. Details Owner and Created by follow
 * it so one person reads the same beside this stack (ISS-12494), so changing it
 * resizes those rows on every Details tab too.
 */
export const COLLABORATOR_AVATAR_SIZE_CLASS_NAME = "size-6";
