"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useCopyToClipboard } from "@repo/design-system/hooks/use-copy-to-clipboard";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { ArrowRight, Ellipsis, LinkIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ActivityEntryRow, ActivityTime } from "./activity-entry";

/**
 * A comment on the Activity tab's timeline (ISS-12117): the same who, what,
 * when row as every other entry (ISS-12330), the what being "commented" over a read-only
 * card that points at the comment where it really lives. The tab is an audit
 * trail, not an action surface, so there is no reply, reaction or edit here;
 * the only menu action is Copy link (Ottilie / Nerys, 2026-09-25).
 *
 * The card is the comments rail's card width (Nerys, 2026-10-08), so a
 * comment reads the same size here as beside the canvas.
 *
 * Comments are not activity events (ISS-10994): the host supplies them from
 * its own comment source (Liveblocks for Documents).
 */
export function ActivityCommentEntry({
  avatar,
  actor,
  createdAt,
  now,
  body,
  href,
  unavailable = false,
}: Readonly<{
  /** The author's avatar (`ActivityActorAvatar`), drawn on the line. */
  avatar: ReactNode;
  /** The author's name (`ActivityActorName`). */
  actor: ReactNode;
  createdAt: Date;
  /** The clock relative times are measured against; stories pin it. */
  now?: Date | number;
  /** The comment's text. Clamped to three lines; the link opens the rest. */
  body?: string | null;
  /** Where the comment lives (the comments rail, deep-linked to it). */
  href: string;
  /** The comment was deleted or can no longer be read. */
  unavailable?: boolean;
}>) {
  return (
    <ActivityEntryRow
      actor={actor}
      avatar={avatar}
      below={
        <article
          className={cn(
            "w-full rounded-lg border border-border bg-card",
            ACTIVITY_COMMENT_CARD_WIDTH_CLASS
          )}
        >
          <div className="flex items-start gap-2 py-3 pr-2 pl-4 text-sm">
            <div className="min-w-0 flex-1 pt-1">
              {unavailable ? (
                <p className="text-muted-foreground italic">
                  This comment is no longer available.
                </p>
              ) : (
                <>
                  {body ? (
                    <p className="line-clamp-3 whitespace-pre-line break-words text-foreground leading-6">
                      {body}
                    </p>
                  ) : null}
                  <Link
                    className={cn(
                      "mt-1.5 inline-flex items-center gap-1 rounded-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline",
                      CHIP_FOCUS_RING_CLASS
                    )}
                    href={href}
                  >
                    View comment
                    <ArrowRight aria-hidden className="size-3.5" />
                  </Link>
                </>
              )}
            </div>
            {unavailable ? null : <CommentLinkMenu href={href} />}
          </div>
        </article>
      }
      time={<ActivityTime createdAt={createdAt} now={now} />}
    >
      <p className="text-muted-foreground text-sm leading-6">commented</p>
    </ActivityEntryRow>
  );
}

/**
 * The comments rail's card width, measured: the rail's default 352px less its
 * 16px padding each side and its 1px border. A comment is the same size here
 * as beside the canvas.
 */
export const ACTIVITY_COMMENT_CARD_WIDTH_CLASS = "max-w-[319px]";

/** The comment's one action: copy its link (same copy as the comments rail). */
function CommentLinkMenu({ href }: Readonly<{ href: string }>) {
  const [, copy] = useCopyToClipboard();
  const onCopy = async () => {
    const url = new URL(href, globalThis.location?.href).toString();
    if (await copy(url)) {
      toast.success("Copied link");
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="More actions"
          className="size-7 shrink-0 p-0"
          size="icon"
          type="button"
          variant="ghost"
        >
          <Ellipsis aria-hidden className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          aria-label="Copy link to comment"
          onSelect={() => {
            onCopy().catch(() => undefined);
          }}
        >
          <LinkIcon aria-hidden className="size-3.5" />
          Copy link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
