"use client";

import {
  formatDate,
  formatDateTimeOrFallback,
  formatMonthDayTime,
  formatTime,
} from "@repo/app/shared/lib/date-utils";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

/**
 * One entry on the Activity tab's timeline (ISS-12330), read left to right as
 * who, what, when (Nerys, 2026-10-09):
 *
 * avatar on the timeline's line · **Actor** [badge] · phrase · context · time
 *
 * The avatar is the row's anchor: a person's photo or initials, the cog for
 * System, the robot for an agent (`ActivityActorAvatar` with `kindGlyph`).
 * GitHub's pull-request timeline is the inspiration, not the source: every
 * surface, colour and size here is a design-system token.
 *
 * Presentational only. The container (`ActivityCard` with `layout="timeline"`)
 * resolves the actor and words the phrase through the adapter; nothing here
 * fetches or decides copy.
 */
export function ActivityEntry({
  avatar,
  actor,
  badge,
  children,
  suffix,
  createdAt,
  now,
  detail,
  attachments,
  className,
}: Readonly<{
  /** The actor's avatar (`ActivityActorAvatar`), drawn on the line. */
  avatar: ReactNode;
  /** The actor's name (`ActivityActorName`). */
  actor: ReactNode;
  /** A badge beside the name, e.g. the API-key badge on an agent row. */
  badge?: ReactNode;
  /** The action phrase (`ActivityParts`). */
  children: ReactNode;
  /** Muted context after the phrase: "bulk update", "from desktop sync". */
  suffix?: string;
  createdAt: Date;
  /** The clock relative times are measured against; stories pin it. */
  now?: Date | number;
  /**
   * FUTURE SLOT, unused in V1: an expandable body under the line (the V2
   * "expanded detail" card in `Future (Not For Build)`). Documented so
   * the extension point is known; no V1 row passes it.
   */
  detail?: ReactNode;
  /**
   * FUTURE SLOT, unused in V1: files or previews attached to the change.
   * Documented so the extension point is known; no V1 row passes it.
   */
  attachments?: ReactNode;
  className?: string;
}>) {
  return (
    <ActivityEntryRow
      actor={
        <>
          {actor}
          {badge ? <> {badge}</> : null}
        </>
      }
      avatar={avatar}
      below={
        detail || attachments ? (
          <>
            {detail ? <div>{detail}</div> : null}
            {attachments ? <div className="mt-1">{attachments}</div> : null}
          </>
        ) : undefined
      }
      className={className}
      time={<ActivityTime createdAt={createdAt} now={now} />}
    >
      <p className="text-muted-foreground text-sm leading-6">
        {children}
        {/*
         * Each "· x" is one unbreakable unit, so a wrapped row never starts
         * a line with a bare separator.
         */}
        {suffix ? (
          <>
            {" "}
            <span className="whitespace-nowrap">· {suffix}</span>
          </>
        ) : null}
      </p>
    </ActivityEntryRow>
  );
}

/**
 * The timeline's columns, shared by every row kind and the loading skeleton:
 * the avatar on the line, who (a fixed column, so actions start at one edge),
 * what, and when straight after it. Each row is its own grid, so the what
 * column is only as wide as its phrase (up to the room left) and the time
 * follows the action rather than drifting to the far edge of a wide tab.
 * `below` (a comment's card) sits under the action, outside the time's line.
 *
 * Below `sm`: the avatar on the line, then the name with the time at the end
 * of the first line, the action under them, then `below`.
 *
 * DOM order is who, what, when (the reading order); the `{" "}` between cells
 * is for copied text and assistive tech, since a grid never renders
 * whitespace between its items.
 *
 * The row is the `<li>`'s only child; the line is drawn by the avatar column,
 * which spans the row's full height (`group/entry` on the `<li>` hides the
 * part above the first avatar and below the last).
 */
export function ActivityEntryRow({
  avatar,
  actor,
  time,
  children,
  below,
  className,
}: Readonly<{
  avatar: ReactNode;
  actor: ReactNode;
  time: ReactNode;
  children: ReactNode;
  /** Content under the action, e.g. a comment's card. */
  below?: ReactNode;
  className?: string;
}>) {
  return (
    <div
      className={cn(
        "grid grid-cols-[24px_minmax(0,1fr)_max-content] gap-x-3 py-3 text-sm leading-6",
        "sm:grid-cols-[24px_minmax(0,11rem)_minmax(0,max-content)_max-content]",
        className
      )}
    >
      <ActivityEntryAvatarColumn>{avatar}</ActivityEntryAvatarColumn>
      <div className="col-start-2 row-start-1 min-w-0 truncate font-medium text-foreground">
        {actor}
      </div>{" "}
      <div className="col-span-2 col-start-2 row-start-2 min-w-0 sm:col-span-1 sm:col-start-3 sm:row-start-1">
        {children}
      </div>{" "}
      <div className="col-start-3 row-start-1 whitespace-nowrap text-muted-foreground tabular-nums sm:col-start-4 sm:pl-2">
        {time}
      </div>
      {below ? (
        <div className="col-span-2 col-start-2 row-start-3 mt-2 min-w-0 sm:col-start-3 sm:row-start-2">
          {below}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The line and the row's avatar on it (Nerys, 2026-10-09: the avatars took
 * the dots' place). The line is the zinc-100 primitive (Figma Primitives,
 * Tailwind's zinc-100, #f4f4f5; zinc-800 in dark) through the avatar column's
 * centre. The column stretches over the row's padding (`-my-3`) so the line is
 * continuous from row to row; the 24px avatar sits on the first text line
 * (12px padding, 24px line height) above the line, which runs into its top
 * and out of its bottom. The first row draws no line above its avatar and the
 * last none below.
 */
function ActivityEntryAvatarColumn({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <div
      className={cn(
        "relative col-start-1 row-span-3 row-start-1 -my-3 sm:row-span-2",
        "before:absolute before:top-0 before:left-[11px] before:h-3 before:w-0.5 before:bg-zinc-100 group-first/entry:before:hidden dark:before:bg-zinc-800",
        "after:absolute after:top-9 after:bottom-0 after:left-[11px] after:w-0.5 after:bg-zinc-100 group-last/entry:after:hidden dark:after:bg-zinc-800"
      )}
    >
      <div className="absolute top-3 left-0 z-10 flex size-6">{children}</div>
    </div>
  );
}

/**
 * When it happened, as an exact time (Nerys, 2026-10-08): "Oct 8, 10:32",
 * 24-hour, in the viewer's timezone, so the time column lines up and every
 * row says exactly when. A row from another year than `now` carries its year
 * ("Oct 8, 2025, 10:32"). The full timestamp is in a tooltip that keyboard
 * focus opens too, so it is not hover-only.
 */
export function ActivityTime({
  createdAt,
  now,
}: Readonly<{ createdAt: Date; now?: Date | number }>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          className={cn("whitespace-nowrap rounded-sm", CHIP_FOCUS_RING_CLASS)}
          dateTime={toIsoOrUndefined(createdAt)}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the full timestamp lives in a tooltip, which keyboard users reach by focusing the time
          tabIndex={0}
        >
          <ActivityDateTime label={formatActivityTime(createdAt, now)} />
        </time>
      </TooltipTrigger>
      <TooltipContent>{formatDateTimeOrFallback(createdAt)}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The date in the foreground's semibold and the time in the row's regular
 * muted text (Nerys, 2026-10-08), so the day reads first when scanning down.
 * Split at the label's last comma: "Oct 8" + "10:32", or "Oct 8, 2025" +
 * "10:32". A fallback label with no time stays as one run of text.
 */
function ActivityDateTime({ label }: Readonly<{ label: string }>) {
  const split = label.lastIndexOf(", ");
  if (split < 0) {
    return <>{label}</>;
  }
  return (
    <>
      <span className="font-semibold text-foreground">
        {label.slice(0, split)}
      </span>
      , {label.slice(split + 2)}
    </>
  );
}

/** "Oct 8, 10:32"; with the year when it is not `now`'s ("Oct 8, 2025, 10:32"). */
export function formatActivityTime(
  createdAt: Date,
  now: Date | number = Date.now()
): string {
  if (Number.isNaN(createdAt.getTime())) {
    return formatDateTimeOrFallback(createdAt);
  }
  const sameYear = createdAt.getFullYear() === new Date(now).getFullYear();
  return sameYear
    ? formatMonthDayTime(createdAt, { hour12: false })
    : `${formatDate(createdAt)}, ${formatTime(createdAt, { hour12: false })}`;
}

function toIsoOrUndefined(date: Date): string | undefined {
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
