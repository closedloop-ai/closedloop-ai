"use client";

import {
  type ActivityFeedActor,
  ActivityFeedActorKind,
} from "@repo/api/src/types/artifact-activity-feed";
import type { User } from "@repo/api/src/types/user";
import { ActivityInlineSkeleton } from "@repo/app/documents/components/artifact-activity/activity-parts";
import { UserLink } from "@repo/app/shared/components/user-link";
import { getInitials } from "@repo/app/shared/lib/user-utils";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Badge } from "@repo/design-system/components/ui/badge";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { Bot, Cog, User as UserIcon } from "lucide-react";
import {
  type ActivityActorDescription,
  resolveActivityActor,
} from "./activity-formatting";
import type { ActivityDirectory } from "./activity-types";

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
 * Actor cell for an activity row: avatar + display name.
 *
 * A human actor resolves to its org-user profile (name, avatar, profile link).
 * The system has no profile to anchor on, so its avatar falls back to a kind
 * glyph and the name IS the kind word — the whole statement, once (ISS-5767).
 * An agent row is an API-key write, and the feed's actor id is the KEY OWNER's
 * user id (ISS-10994), so it resolves to the owner's avatar and name plus an
 * "API" badge (Nerys, 2026-10-07): it must never read as the owner's own edit.
 * The badge shows only beside a RESOLVED owner. An agent whose owner cannot be
 * resolved reads "Agent" with the robot glyph and no badge: the badge there
 * would state the machine kind a third time.
 * "API" names the channel, not the actor kind. All from design-system primitives — no hand-rolled avatar, no
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
 * outright — Marisol's ruling on the ticket was "we don't need feature flags on any
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
  const resolved = resolveActivityActor(actor, directory);

  if (resolved.pending) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Skeleton className="size-6 shrink-0 rounded-full" />
        <Skeleton className="h-4 w-24" />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <ActivityActorAvatar actor={resolved} />
      <ActivityActorName actor={resolved} />
      {actor.kind === ActivityFeedActorKind.Agent && resolved.user !== null ? (
        <ActivityApiBadge />
      ) : null}
    </div>
  );
}

/**
 * The actor's avatar alone, 24px everywhere it is drawn (the rail card and the
 * Activity tab's timeline). Same ISS-5955 rule everywhere: the image is
 * unnamed because the row always states the name in text.
 *
 * `kindGlyph` is the Activity tab's rule (Nerys, 2026-10-09): a person is
 * their photo, or their initials without one; System is the cog and an agent
 * is the robot, even when the agent's API key resolves to an owner with a
 * photo. The rail card leaves it off and keeps showing the key owner's
 * picture on an agent row.
 */
export function ActivityActorAvatar({
  actor,
  kindGlyph = false,
  className,
}: Readonly<{
  actor: ActivityActorDescription;
  /** Draw the kind's glyph for every non-person actor (the timeline look). */
  kindGlyph?: boolean;
  className?: string;
}>) {
  if (actor.pending) {
    return (
      <ActivityInlineSkeleton
        className={cn("size-6 shrink-0 rounded-full", className)}
      />
    );
  }
  const FallbackIcon = ACTOR_FALLBACK_ICON[actor.kind];
  const person =
    kindGlyph && actor.kind !== ActivityFeedActorKind.Human ? null : actor.user;
  const initials = person && actor.name ? getInitials(actor.name) : "";
  // Stays hand-rolled (ISS-12343): the fallback is a NODE, not a string —
  // initials or the actor-kind glyph — and `PersonAvatar` types `initials` as
  // a string. The ISS-5955 and ISS-6174 rulings below ride on that glyph.
  return (
    <Avatar className={cn("size-6", className)}>
      {/*
       * ISS-5955: empty, because the name in the same row is the SAME string —
       * naming the image made a screen reader announce the person twice on
       * every human row (WCAG 1.1.1 / H67). Already the house pattern:
       * `member-row`, `members-tab-content`, `loop-usage-tables`,
       * `branch-comment-card` and `approved-branches-table` all do this. It is
       * NOT a blanket rule for avatars: ISS-7746 gave
       * `shared/components/assignee-avatar.tsx` an accessible name because on
       * most of its consumers it is the ONLY statement of identity. Safe here
       * because every row that draws this avatar also draws
       * {@link ActivityActorName}; the coverage is in
       * `__tests__/sources/activity-actor-name-announcement.test.tsx`.
       *
       * ISS-8972: `AvatarImage` itself is always mounted, `src` possibly
       * undefined — see table-cell-list-primitives.tsx's ReferenceChip for why
       * (a conditionally-unmounted AvatarImage leaves Radix's Avatar context
       * believing a since-removed picture is still "loaded", hiding the
       * fallback forever).
       */}
      <AvatarImage alt="" src={person?.avatarUrl ?? undefined} />
      {/*
       * The glyph is `aria-hidden` and the initials beside it are NOT, which
       * looks arbitrary and is not. Both are rulings, not oversights: the
       * glyph restates the KIND the name already carries (ISS-5767), while
       * "DR" is a derived abbreviation rather than the name, so ISS-5955 left
       * it alone. Hiding it was the other half of ISS-6174, which was
       * canceled — so a screen reader on a photo-less human row still gets
       * "D R" before the link. Reopen that, do not quietly fold it in here.
       */}
      {/*
       * Initials sized for the 24px activity avatar; the DS fallback's own
       * text size is for larger avatars and crowds the edge here.
       */}
      {/*
       * On the timeline (`kindGlyph`) the initials are hidden too: the name is
       * announced right beside the avatar, so "E C Emily Carter" would say the
       * person twice (ISS-12330). The rail card keeps ISS-6174's behaviour.
       */}
      <AvatarFallback
        aria-hidden={kindGlyph || undefined}
        className="font-medium text-[10px]"
      >
        {initials || <FallbackIcon aria-hidden className="size-3" />}
      </AvatarFallback>
    </Avatar>
  );
}

/** The actor's name: a profile link for a person, the kind word otherwise. */
export function ActivityActorName({
  actor,
  className,
}: Readonly<{ actor: ActivityActorDescription; className?: string }>) {
  if (actor.pending || actor.name === null) {
    // Inline: the name sits inside the row's sentence (a `<p>`).
    return <ActivityInlineSkeleton className={cn("h-4 w-24", className)} />;
  }
  return (
    <span
      className={cn(
        "min-w-0 truncate font-medium text-foreground text-sm",
        className
      )}
    >
      {actor.user ? (
        <UserLink
          className={cn(
            "rounded-sm text-foreground hover:underline",
            CHIP_FOCUS_RING_CLASS
          )}
          userId={actor.user.id}
        >
          {actor.name}
        </UserLink>
      ) : (
        actor.name
      )}
    </span>
  );
}

/**
 * The API-key badge on an agent row (Nerys, 2026-10-07). It states the
 * CHANNEL the change came through; the person beside it is the key owner,
 * and it is drawn only when that owner is resolved.
 */
export function ActivityApiBadge() {
  return (
    <Badge className="shrink-0" variant="muted">
      API
    </Badge>
  );
}
