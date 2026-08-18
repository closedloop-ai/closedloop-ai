"use client";

import {
  type ActivityFeedActor,
  ActivityFeedActorKind,
} from "@repo/api/src/types/artifact-activity-feed";
import type { User } from "@repo/api/src/types/user";
import { UserLink } from "@repo/app/shared/components/user-link";
import {
  getInitials,
  getUserDisplayName,
} from "@repo/app/shared/lib/user-utils";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { Bot, Cog, User as UserIcon } from "lucide-react";
import {
  type ActivityDirectory,
  ActivityDirectoryStatus,
} from "./activity-directory";

/**
 * The row's ONE visual statement of actor kind: three distinct glyphs, never a
 * hue. Do not over-read the shapes, though — measured on the real render at
 * `size-3`, `Cog` survives as a spiky ring but `Bot` collapses into a rounded
 * blob, so Agent and System are told apart by silhouette WEIGHT and, decisively,
 * by the adjacent NAME. The glyph is texture; the word is the distinction. That
 * is why the name may never be dropped in favour of "the avatar says it".
 *
 * Decorative by design — `aria-hidden`, because the name text carries the same
 * fact to a screen reader and a labelled glyph would re-announce it.
 *
 * These sit in the DS Avatar's neutral `bg-muted` fallback rather than the
 * prototype's tinted `bg-chart-5/15` bot box, and NOT on a WCAG 1.4.1 argument —
 * the tinted box also carries a glyph and a name, so it is not colour-alone
 * either, and citing 1.4.1 here would be a cite that does not hold. The real
 * reasons are rail density (a tint on every non-human row puts colour back into
 * a list this change exists to calm) and that `chart-5` is a chart-palette token
 * being spent as a UI accent. The counter-argument — one rail should have one
 * avatar, and the sibling `LiveblocksDsComment` already uses `CommentAvatar` —
 * is real and unresolved; see the note on {@link ActivityActor}.
 */
const ACTOR_FALLBACK_ICON = {
  [ActivityFeedActorKind.Agent]: Bot,
  [ActivityFeedActorKind.System]: Cog,
  [ActivityFeedActorKind.Human]: UserIcon,
} as const;

/**
 * Resolve a human actor's id to its org-user record so the row can show a real
 * name + avatar. Agents / system actors are not org users, so they short-circuit
 * to null without touching the map.
 */
function resolveUser(
  actor: ActivityFeedActor,
  directory: ActivityDirectory<User>
): User | null {
  if (actor.kind !== ActivityFeedActorKind.Human || actor.id === null) {
    return null;
  }
  return directory.find(actor.id);
}

/**
 * The label for an actor we could not resolve to a profile.
 *
 * "Unknown user" is a claim — that we looked the id up and nobody is there —
 * so it is reserved for a settled directory. When the directory is unavailable
 * (the read failed, or the viewer can see no org users at all) the row says
 * only what it actually knows: a member of this org did this.
 */
function actorFallbackLabel(
  actor: ActivityFeedActor,
  status: ActivityDirectoryStatus
): string {
  if (actor.kind === ActivityFeedActorKind.Agent) {
    return "Agent";
  }
  if (actor.kind === ActivityFeedActorKind.System) {
    return "System";
  }
  return status === ActivityDirectoryStatus.Ready ? "Unknown user" : "Member";
}

/** A human actor whose directory has not settled names nobody meanwhile. */
function isAwaitingName(
  actor: ActivityFeedActor,
  status: ActivityDirectoryStatus
): boolean {
  return (
    actor.kind === ActivityFeedActorKind.Human &&
    actor.id !== null &&
    status === ActivityDirectoryStatus.Pending
  );
}

/**
 * Actor cell for an activity row: avatar + display name.
 *
 * A human actor resolves to its org-user profile (name, avatar, profile link).
 * Agents and the system have no profile to anchor on, so the avatar falls back
 * to a kind glyph and the name IS the kind word — the whole statement, once
 * (ISS-5767). All from design-system primitives — no hand-rolled avatar, no
 * per-instance sizing overrides.
 *
 * WHAT THIS DOES AND DOES NOT MATCH, stated precisely so the next reader does
 * not over-trust it. It adopts the prototypes' COUNT rule — one indicator, the
 * kind in words only where there is no profile, exactly as
 * `session-branch-comments/components/sessions-timeline.tsx` resolves its actor
 * name. It does NOT adopt the prototypes' avatar SHAPE: `document-comments/
 * components/comment-avatar.tsx` mirrors `@repo/app/shared/components/
 * comment-avatar`, a `rounded-[8px]` squircle with a tinted bot box, and the
 * sibling source in this same rail (`LiveblocksDsComment`) already renders it.
 * So one feed rail currently draws two different actor avatars. That is a real
 * remaining drift and it is deliberately NOT resolved here: `CommentAvatar`'s
 * `authorKind` is bot-or-human, which cannot tell Agent from System, so
 * adopting it as-is would collapse two kinds this row must keep apart. Picking
 * between "move the activity row onto a kind-aware CommentAvatar" and "make the
 * whole rail neutral" is a design call, not a de-clutter one.
 *
 * ISS-5972 graduated this UNGATED and deleted the pre-declutter kind badge
 * outright — Mike's ruling on the ticket was "we don't need feature flags on any
 * of this", so there is no flag-off branch left to keep it alive. The shape it
 * used to render is now a build failure everywhere, not just here:
 * `scripts/lint/rules/no-restated-actor-kind.ts` (`pnpm check:source-gates`)
 * fails any component that draws a kind glyph in an `AvatarFallback` AND a
 * badge restating that kind. That catches the spelling that regressed, not
 * every synonym — the gate's own docstring lists what it does NOT catch.
 */
export function ActivityActor({
  actor,
  directory,
}: Readonly<{
  actor: ActivityFeedActor;
  /**
   * The row's org-user directory, passed in rather than read here so the actor
   * cell and the change chips resolve against one lookup with one settled
   * state. They used to read the same query independently and disagree about
   * it: the chips showed a skeleton while the actor already said "Unknown
   * user", and neither noticed a failed read at all.
   */
  directory: ActivityDirectory<User>;
}>) {
  const user = resolveUser(actor, directory);
  const FallbackIcon = ACTOR_FALLBACK_ICON[actor.kind];

  const awaitingName = isAwaitingName(actor, directory.status);
  const displayName = user
    ? getUserDisplayName(user)
    : actorFallbackLabel(actor, directory.status);
  const initials = user ? getInitials(displayName) : "";

  if (awaitingName) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Skeleton className="size-6 shrink-0 rounded-full" />
        <Skeleton className="h-4 w-24" />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Avatar className="size-6">
        {/*
         * This `alt`, and the initials below, restate the NAME that the span
         * two nodes down already carries. Left alone deliberately: that is the
         * name axis, not the kind axis this gate covers, and `alt=""` is a
         * separate a11y call (ISS-6174).
         *
         * Whoever takes it: jsdom never loads the image, so no `<img>` exists
         * at unit level and an assertion on this `alt` passes vacuously either
         * way. `e2e/document-activity-actor-kind.spec.ts` is where it is
         * observable, and it pins today's behaviour.
         */}
        {user?.avatarUrl ? (
          <AvatarImage alt={displayName} src={user.avatarUrl} />
        ) : null}
        <AvatarFallback>
          {initials || <FallbackIcon aria-hidden className="size-3" />}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate font-medium text-foreground text-sm">
        {user ? (
          <UserLink
            className="text-foreground hover:underline"
            userId={user.id}
          >
            {displayName}
          </UserLink>
        ) : (
          displayName
        )}
      </span>
    </div>
  );
}
