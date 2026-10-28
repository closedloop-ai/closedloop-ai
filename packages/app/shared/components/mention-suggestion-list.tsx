"use client";

import { PersonAvatar } from "@repo/design-system/components/ui/person-avatar";
import { cn } from "@repo/design-system/lib/utils";
import type { CSSProperties, MouseEvent } from "react";
import { createPortal } from "react-dom";
import { type MentionUser, mentionDisplayName } from "../lib/mentions";

/** Max member rows shown in the suggestion popover to keep it scannable. */
export const MAX_MENTION_SUGGESTIONS = 6;

export type MentionSuggestionListProps = Readonly<{
  suggestions: readonly MentionUser[];
  /** The viewport rect the menu opens against: a textarea, or an editor caret. */
  anchorRect: DOMRect;
  onSelect: (user: MentionUser) => void;
  /**
   * The keyboard-highlighted row, for a host whose focus stays in its own
   * field (the document editor's body picker, PLN-2189 T-2.7). Given, the menu
   * is a listbox; omitted (the comment composer), the rows are plain buttons.
   */
  activeIndex?: number;
  /** Size the menu to the anchor's width; off for a caret, which has none. */
  matchAnchorWidth?: boolean;
  /** Where the portal mounts; `document.body` when omitted. */
  container?: HTMLElement;
}>;

/**
 * The @-mention member menu shared by the comment composer and the document
 * editor's body picker (PLN-2189 T-2.8): one row per member with avatar, name
 * and email, chosen on mousedown so the host field keeps its caret.
 *
 * FEA-3490: it renders in a portal at `position: fixed`. Every comment surface
 * mounts the composer inside a scroll container with `overflow` clipping (the
 * session-trace `.sd3-scroll` / rail), which would clip an in-flow
 * absolutely-positioned dropdown out of view. A portaled fixed menu escapes
 * every ancestor's overflow.
 */
export function MentionSuggestionList({
  suggestions,
  anchorRect,
  onSelect,
  activeIndex,
  matchAnchorWidth = true,
  container,
}: MentionSuggestionListProps) {
  const isListbox = activeIndex !== undefined;
  return createPortal(
    <div
      className="z-50 flex max-h-56 flex-col overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      data-comment-control="true"
      data-testid="mention-suggestions"
      role={isListbox ? "listbox" : undefined}
      style={mentionMenuStyle(anchorRect, matchAnchorWidth)}
    >
      {suggestions.map((user, index) => {
        const rowProps = {
          className: cn(ROW_CLASS, index === activeIndex && "bg-accent"),
          "data-comment-control": "true",
          // Keep the host's caret; select on mousedown before blur.
          onMouseDown: (event: MouseEvent<HTMLButtonElement>) => {
            event.preventDefault();
            onSelect(user);
          },
          type: "button" as const,
        };
        return isListbox ? (
          <button
            {...rowProps}
            aria-selected={index === activeIndex}
            key={user.id}
            ref={index === activeIndex ? scrollIntoList : undefined}
            role="option"
            tabIndex={-1}
          >
            <MentionSuggestionRowContent user={user} />
          </button>
        ) : (
          <button {...rowProps} key={user.id}>
            <MentionSuggestionRowContent user={user} />
          </button>
        );
      })}
    </div>,
    container ?? globalThis.document.body
  );
}

function MentionSuggestionRowContent({
  user,
}: Readonly<{ user: MentionUser }>) {
  return (
    <>
      <PersonAvatar
        avatarUrl={user.avatarUrl}
        className="size-5"
        fallbackClassName="text-[9px]"
        imageAlt={mentionDisplayName(user)}
        initials={mentionDisplayName(user).slice(0, 2).toUpperCase()}
        name={mentionDisplayName(user)}
      />
      <span className="truncate">{mentionDisplayName(user)}</span>
      <span className="truncate text-muted-foreground text-xs">
        {user.email}
      </span>
    </>
  );
}

const ROW_CLASS =
  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent";

/** Popover height cap (matches the `max-h-56` = 14rem = 224px class). */
const MENTION_MENU_MAX_HEIGHT = 224;

/** Gap between the anchor's edge and the popover. */
const MENTION_MENU_GAP = 4;

/** The menu's width at a caret, which has no width to match (`w-72`). */
const CARET_MENU_WIDTH = 288;

/**
 * Fixed-position style for the portaled menu, anchored to a viewport rect.
 * Opens below the anchor by default; flips above when there is not enough room
 * below and there is more room above, and caps `maxHeight` to the available
 * space so the menu is never clipped off-screen. Horizontally it starts at the
 * anchor and shifts left as far as needed to keep its right edge on screen.
 */
function mentionMenuStyle(
  rect: DOMRect,
  matchAnchorWidth: boolean
): CSSProperties {
  const spaceBelow = globalThis.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  const openUp =
    spaceBelow < MENTION_MENU_MAX_HEIGHT && spaceAbove > spaceBelow;
  const available = Math.max(
    0,
    (openUp ? spaceAbove : spaceBelow) - MENTION_MENU_GAP
  );
  const width = matchAnchorWidth ? rect.width : CARET_MENU_WIDTH;
  const rightmostLeft = globalThis.innerWidth - width - MENTION_MENU_GAP;
  const style: CSSProperties = {
    position: "fixed",
    left: Math.max(0, Math.min(rect.left, rightmostLeft)),
    width,
    maxHeight: Math.min(MENTION_MENU_MAX_HEIGHT, available),
  };
  if (openUp) {
    style.bottom = globalThis.innerHeight - rect.top + MENTION_MENU_GAP;
  } else {
    style.top = rect.bottom + MENTION_MENU_GAP;
  }
  return style;
}

/**
 * The highlighted row's ref: the host's focus stays in its own field, so the
 * row is scrolled into the capped list as the highlight reaches it.
 */
function scrollIntoList(row: HTMLButtonElement | null) {
  row?.scrollIntoView({ block: "nearest" });
}
