"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { AtSignIcon } from "lucide-react";
import type { CSSProperties, KeyboardEvent } from "react";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  applyMentionSelection,
  findActiveMentionQuery,
  insertMentionTrigger,
  resolveMentions,
} from "../lib/mentions";
import type { CommentAuthor } from "../mock";

// Presentational mirror of packages/app/shared/components/mention-composer.tsx:
// a plain textarea plus an @-mention typeahead over the org member list. The
// domain component and its useOrganizationUsers hook can't be imported into the
// sandbox, so the same shape is replicated on DS primitives with a mock member
// list. In production this posts { body, mentions } and mentions notify the
// recipient's inbox only (no email). Text-model rules (caret splice, active-
// token replacement, boundary-matched resolution) live in ../lib/mentions.

const MAX_SUGGESTIONS = 6;
/** Popover height cap (matches the `max-h-56` = 14rem = 224px class). */
const MENTION_MENU_MAX_HEIGHT = 224;
/** Gap between the textarea edge and the popover. */
const MENTION_MENU_GAP = 4;

type MentionQueryState = { start: number; query: string };

type MentionComposerProps = {
  users: readonly CommentAuthor[];
  placeholder?: string;
  submitLabel?: string;
  cancelLabel?: string;
  minHeightClassName?: string;
  autoFocus?: boolean;
  /** id of a visible <Label> that names the textarea (artifact composer). */
  labelledBy?: string;
  /**
   * Controlled draft text. When provided (with onDraftChange), the parent owns
   * the draft so it survives an unmount — the artifact composer hoists its draft
   * to the page so hiding then reopening the rail does not lose it.
   */
  draft?: string;
  onDraftChange?: (next: string) => void;
  onCancel?: () => void;
  onSubmit: (payload: { body: string; mentions: string[] }) => void;
};

export function MentionComposer({
  users,
  placeholder = "Add a comment...",
  submitLabel = "Comment",
  cancelLabel = "Cancel",
  minHeightClassName = "min-h-[72px]",
  autoFocus = false,
  labelledBy,
  draft,
  onDraftChange,
  onCancel,
  onSubmit,
}: Readonly<MentionComposerProps>) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const listboxId = useId();
  const isControlled = draft !== undefined;
  const [uncontrolledValue, setUncontrolledValue] = useState("");
  const value = isControlled ? draft : uncontrolledValue;
  const setValue = isControlled
    ? (next: string) => onDraftChange?.(next)
    : setUncontrolledValue;
  const [mentionQuery, setMentionQuery] = useState<MentionQueryState | null>(
    null
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [pickedById, setPickedById] = useState<Map<string, CommentAuthor>>(
    () => new Map()
  );

  const suggestions = useMemo(() => {
    if (mentionQuery === null) {
      return [] as CommentAuthor[];
    }
    const q = mentionQuery.query.toLowerCase();
    return users
      .filter(
        (user) =>
          user.name.toLowerCase().includes(q) ||
          user.email.toLowerCase().includes(q)
      )
      .slice(0, MAX_SUGGESTIONS);
  }, [mentionQuery, users]);

  const showSuggestions = mentionQuery !== null && suggestions.length > 0;

  // The suggestion menu renders in a portal at `position: fixed`, anchored to
  // the textarea, so a reply composer mounted inside CommentThreadCard's
  // `overflow-hidden` root cannot clip the list. Mirrors the production
  // composer's portaled menu. Re-measured on open, ancestor scroll (capture),
  // resize, and textarea growth.
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!showSuggestions) {
      return;
    }
    const measure = () => {
      const el = textareaRef.current;
      if (el) {
        setAnchorRect(el.getBoundingClientRect());
      }
    };
    measure();
    globalThis.addEventListener("scroll", measure, true);
    globalThis.addEventListener("resize", measure);
    const el = textareaRef.current;
    const observer =
      el && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    if (el) {
      observer?.observe(el);
    }
    return () => {
      globalThis.removeEventListener("scroll", measure, true);
      globalThis.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [showSuggestions]);

  function syncQuery(nextValue: string, caret: number) {
    const next = findActiveMentionQuery(nextValue, caret);
    setMentionQuery(next);
    setActiveIndex(0);
  }

  function handleChange(nextValue: string) {
    setValue(nextValue);
    const caret = textareaRef.current?.selectionStart ?? nextValue.length;
    syncQuery(nextValue, caret);
  }

  function focusTextareaAt(caret: number) {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  }

  function openPickerFromButton() {
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const { value: nextValue, caret: nextCaret } = insertMentionTrigger({
      value,
      caret,
    });
    setValue(nextValue);
    syncQuery(nextValue, nextCaret);
    focusTextareaAt(nextCaret);
  }

  function selectMention(user: CommentAuthor) {
    if (mentionQuery === null) {
      return;
    }
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const { value: nextValue, caret: nextCaret } = applyMentionSelection({
      value,
      caret,
      start: mentionQuery.start,
      label: user.name,
    });
    setValue(nextValue);
    setMentionQuery(null);
    setPickedById((prev) => {
      const next = new Map(prev);
      next.set(user.id, user);
      return next;
    });
    focusTextareaAt(nextCaret);
  }

  function submit() {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }
    onSubmit({ body: trimmed, mentions: resolveMentions(trimmed, pickedById) });
    setValue("");
    setMentionQuery(null);
    setPickedById(new Map());
  }

  function moveActiveIndex(delta: number) {
    setActiveIndex((prev) => {
      const count = suggestions.length;
      if (count === 0) {
        return 0;
      }
      return (prev + delta + count) % count;
    });
  }

  function handleSuggestionKey(
    event: KeyboardEvent<HTMLTextAreaElement>
  ): boolean {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActiveIndex(1);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveIndex(-1);
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const picked = suggestions[activeIndex] ?? suggestions[0];
      if (picked) {
        selectMention(picked);
      }
      return true;
    }
    return false;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (showSuggestions && handleSuggestionKey(event)) {
      return;
    }
    if (mentionQuery !== null && event.key === "Escape") {
      event.preventDefault();
      setMentionQuery(null);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  }

  const hasContent = value.trim().length > 0;
  const activeOptionId = showSuggestions
    ? `${listboxId}-option-${activeIndex}`
    : undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Textarea
          aria-activedescendant={activeOptionId}
          aria-autocomplete="list"
          aria-controls={showSuggestions ? listboxId : undefined}
          aria-expanded={showSuggestions}
          aria-label={labelledBy ? undefined : placeholder}
          aria-labelledby={labelledBy}
          autoFocus={autoFocus}
          className={`${minHeightClassName} resize-y text-sm`}
          onChange={(event) => handleChange(event.target.value)}
          onClick={(event) =>
            syncQuery(
              event.currentTarget.value,
              event.currentTarget.selectionStart ?? 0
            )
          }
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          ref={textareaRef}
          role="combobox"
          value={value}
        />
        {showSuggestions && anchorRect
          ? createPortal(
              <div
                aria-label="Mention suggestions"
                className="z-50 flex max-h-56 flex-col overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
                id={listboxId}
                role="listbox"
                style={mentionMenuStyle(anchorRect)}
              >
                {suggestions.map((user, index) => (
                  <button
                    aria-selected={index === activeIndex}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                      index === activeIndex ? "bg-accent" : "hover:bg-accent"
                    }`}
                    id={`${listboxId}-option-${index}`}
                    key={user.id}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      selectMention(user);
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                    role="option"
                    type="button"
                  >
                    <Avatar className="size-5">
                      <AvatarFallback className="bg-primary/10 text-[9px] text-primary">
                        {user.name.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="truncate">{user.name}</span>
                    <span className="truncate text-muted-foreground text-xs">
                      {user.email}
                    </span>
                  </button>
                ))}
              </div>,
              globalThis.document.body
            )
          : null}
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button
          aria-label="Mention someone"
          className="h-7 w-7"
          onClick={openPickerFromButton}
          size="icon"
          type="button"
          variant="ghost"
        >
          <AtSignIcon aria-hidden className="h-3.5 w-3.5" />
        </Button>
        <div className="flex items-center justify-end gap-2">
          {onCancel ? (
            <Button
              onClick={onCancel}
              size="sm"
              type="button"
              variant="outline"
            >
              {cancelLabel}
            </Button>
          ) : null}
          <Button
            disabled={!hasContent}
            onClick={submit}
            size="sm"
            type="button"
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Fixed-position style for the portaled suggestion menu, anchored to the
 * textarea's viewport rect. Opens below by default; flips above when there is
 * not enough room below and more room above, capping `maxHeight` to the
 * available space so the menu is never clipped off-screen.
 */
function mentionMenuStyle(rect: DOMRect): CSSProperties {
  const spaceBelow = globalThis.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  const openUp =
    spaceBelow < MENTION_MENU_MAX_HEIGHT && spaceAbove > spaceBelow;
  const available = Math.max(
    0,
    (openUp ? spaceAbove : spaceBelow) - MENTION_MENU_GAP
  );
  const style: CSSProperties = {
    position: "fixed",
    left: rect.left,
    width: rect.width,
    maxHeight: Math.min(MENTION_MENU_MAX_HEIGHT, available),
  };
  if (openUp) {
    style.bottom = globalThis.innerHeight - rect.top + MENTION_MENU_GAP;
  } else {
    style.top = rect.bottom + MENTION_MENU_GAP;
  }
  return style;
}
