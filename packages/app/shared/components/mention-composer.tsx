"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { AtSignIcon } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  applyMentionSelection,
  filterMentionCandidates,
  findActiveMentionQuery,
  type MentionUser,
  mentionDisplayName,
} from "../lib/mentions";
import {
  MAX_MENTION_SUGGESTIONS,
  MentionSuggestionList,
} from "./mention-suggestion-list";

/** Matches trailing whitespace; used to decide whether button-inserted "@" needs a leading space. */
const TRAILING_WHITESPACE_PATTERN = /\s$/;

/** Matches a single whitespace char; used as a mention-token right boundary. */
const WHITESPACE_PATTERN = /\s/;

type MentionComposerProps = Readonly<{
  placeholder?: string;
  submitLabel?: string;
  cancelLabel?: string;
  minHeightClassName?: string;
  containerClassName?: string;
  /** Seed the textarea (edit surfaces); defaults to empty for a fresh compose. */
  defaultValue?: string;
  /**
   * Controlled text, for a host that owns the draft (the comments pane does,
   * PLN-2162 decision 4). The host clears it after a submit lands, so a failed
   * write keeps the typing; the composer never resets a controlled value.
   */
  value?: string;
  /**
   * Every text change, with the ids picked so far, so a host that keeps the
   * draft can keep its picks and hand them back as `initialMentions`.
   */
  onValueChange?: (value: string, mentions: string[]) => void;
  /** The field's accessible name when no visible label names it; defaults to the placeholder. */
  ariaLabel?: string;
  /** Shown above the field. */
  helperText?: ReactNode;
  /** Shown beside the mention control. */
  leadingActions?: ReactNode;
  /**
   * Members already @-mentioned on the comment being edited. Seeds the picked
   * set so an edit that leaves the existing "@Name" tokens intact re-submits
   * those mentions instead of silently clearing them.
   */
  initialMentions?: readonly MentionUser[];
  /**
   * Org members the @-picker offers. The host supplies them (the users slice's
   * `OrgMentionComposer` does), because `shared/` must not import a feature
   * slice. Omitted or loading: the picker has no candidates.
   */
  members?: readonly MentionUser[];
  /** Focus the textarea on mount (reply/edit surfaces that open on demand). */
  autoFocus?: boolean;
  /**
   * Disables the textarea and submit — a viewer without a wired write path, or
   * while a submit is in flight (paired with `isPending`).
   */
  disabled?: boolean;
  /** Marks a submit in flight: keeps submit disabled so a post cannot double-fire. */
  isPending?: boolean;
  /**
   * id of a visible `<Label>` that names the textarea. When omitted the
   * placeholder is used as the accessible name (reply/edit surfaces that open
   * beside an already-labeled comment). The always-on artifact composer passes
   * this so its visible "Add a comment" label names the field.
   */
  labelledBy?: string;
  /**
   * Cancel handler. When omitted, no Cancel button renders — the always-on
   * artifact composer has nothing to cancel back to, so it shows Submit only.
   */
  onCancel?: () => void;
  /**
   * Emits the trimmed body plus the distinct @-mentioned user IDs (FEA-3490).
   * Return the submit promise (e.g. `mutateAsync`) to retain the draft when the
   * post fails and clear it only on success; a `void` return clears immediately.
   */
  onSubmit: (payload: { body: string; mentions: string[] }) => unknown;
}>;

/**
 * Canonical inline comment composer with an @-mention picker (FEA-3490). A plain
 * textarea plus an overlay suggestion combobox — the simplest shape that reuses
 * the shared, SDK-free mention matching without a TipTap/ProseMirror rewrite.
 *
 * Typing "@" (at input start or after whitespace) or clicking the "@" button
 * opens a filtered list of the active `members` the host passes in. Choosing
 * one inserts "@Display Name " into the text and records the stable user ID as a
 * mention. Only mentions whose inserted "@Display Name" token still appears in
 * the final body are submitted, so deleting the token drops the mention.
 *
 * One component for every native comment surface — trace-comment create, reply,
 * and edit all render this so mentioning is identical across the flow. Shared by
 * web and desktop via `@repo/app`.
 */
export function MentionComposer({
  placeholder = "Add a comment...",
  submitLabel = "Comment",
  cancelLabel = "Cancel",
  minHeightClassName = "min-h-[72px]",
  containerClassName = "flex flex-col gap-2",
  defaultValue = "",
  value: controlledValue,
  onValueChange,
  ariaLabel,
  helperText,
  leadingActions,
  initialMentions,
  members,
  autoFocus = false,
  disabled = false,
  isPending = false,
  labelledBy,
  onCancel,
  onSubmit,
}: MentionComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const controlled = controlledValue !== undefined;
  const value = controlled ? controlledValue : uncontrolledValue;
  const [mentionQuery, setMentionQuery] = useState<{
    start: number;
    query: string;
  } | null>(null);
  // Tracks user IDs the author has picked (seeded from any existing mentions on
  // an edit, or a kept draft's picks); a mention only counts when its
  // "@Display Name" label still appears in the final body (delete-to-remove).
  const [pickedById, setPickedById] = useState<Map<string, MentionUser>>(
    () => new Map((initialMentions ?? []).map((user) => [user.id, user]))
  );
  function setValue(next: string, picked = pickedById) {
    if (!controlled) {
      setUncontrolledValue(next);
    }
    onValueChange?.(next, [...picked.keys()]);
  }
  // A controlled draft its owner emptied, as it does once a submit lands,
  // carries no picks into the next comment. A failed submit keeps the text,
  // and with it the picks.
  if (controlled && controlledValue === "" && pickedById.size > 0) {
    setPickedById(new Map());
  }

  useEffect(() => {
    if (!autoFocus) {
      return;
    }
    const el = textareaRef.current;
    if (el) {
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    }
  }, [autoFocus]);

  useLayoutEffect(() => {
    const pendingCaret = pendingCaretRef.current;
    if (pendingCaret === null) {
      return;
    }
    pendingCaretRef.current = null;
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.focus();
    el.setSelectionRange(pendingCaret, pendingCaret);
  });

  const suggestions = useMemo(() => {
    if (!(mentionQuery && members)) {
      return [] as MentionUser[];
    }
    const candidates: MentionUser[] = members.map((user) => ({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      active: user.active,
    }));
    return filterMentionCandidates(candidates, mentionQuery.query).slice(
      0,
      MAX_MENTION_SUGGESTIONS
    );
  }, [mentionQuery, members]);

  const showSuggestions = Boolean(mentionQuery) && suggestions.length > 0;

  // The portaled, fixed suggestion menu (FEA-3490) is anchored to the
  // textarea: re-measured on open, ancestor scroll (capture phase), and resize
  // so it tracks the field.
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
    // Capture phase catches scrolls on any ancestor, not just window.
    globalThis.addEventListener("scroll", measure, true);
    globalThis.addEventListener("resize", measure);
    // Track the field-sizing textarea's own growth as the query is typed so the
    // anchored menu follows its bottom edge (guarded for environments without
    // ResizeObserver, e.g. jsdom).
    const el = textareaRef.current;
    const observer =
      el && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    observer?.observe(el as Element);
    return () => {
      globalThis.removeEventListener("scroll", measure, true);
      globalThis.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [showSuggestions]);

  function syncMentionQuery(nextValue: string, caret: number) {
    setMentionQuery(findActiveMentionQuery(nextValue, caret));
  }

  function handleChange(nextValue: string) {
    setValue(nextValue);
    const caret = textareaRef.current?.selectionStart ?? nextValue.length;
    syncMentionQuery(nextValue, caret);
  }

  function openPickerFromButton() {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const caret = textarea.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    // Insert a bare "@" (space-prefixed when mid-line) so the picker opens with
    // an empty query, matching the type-"@" path.
    const needsSpace =
      before.length > 0 && !TRAILING_WHITESPACE_PATTERN.test(before);
    const insertion = `${needsSpace ? " " : ""}@`;
    const nextValue = `${before}${insertion}${value.slice(caret)}`;
    const nextCaret = before.length + insertion.length;
    pendingCaretRef.current = nextCaret;
    setValue(nextValue);
    syncMentionQuery(nextValue, nextCaret);
  }

  function selectMention(user: MentionUser) {
    if (!mentionQuery) {
      return;
    }
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const label = mentionDisplayName(user);
    const { value: nextValue, caret: nextCaret } = applyMentionSelection({
      value,
      caret,
      start: mentionQuery.start,
      label,
    });
    const picked = new Map(pickedById);
    picked.set(user.id, user);
    pendingCaretRef.current = nextCaret;
    setPickedById(picked);
    setValue(nextValue, picked);
    setMentionQuery(null);
  }

  function resolveMentions(body: string): string[] {
    // Only submit a picked mention whose exact "@Display Name" token still
    // appears in the body followed by a boundary (whitespace or end), so
    // deleting the token drops the mention and a longer name is not matched by a
    // shorter prefix. Two distinct members with the same display name is an
    // inherent limitation of a plain-text token model (both ids would match);
    // acceptable here because the API re-scopes to org members. Server-side
    // scoping is the authoritative guard.
    const ids: string[] = [];
    for (const [id, user] of pickedById) {
      const token = `@${mentionDisplayName(user)}`;
      let from = body.indexOf(token);
      while (from !== -1) {
        const nextChar = body[from + token.length];
        if (nextChar === undefined || WHITESPACE_PATTERN.test(nextChar)) {
          ids.push(id);
          break;
        }
        from = body.indexOf(token, from + 1);
      }
    }
    return [...new Set(ids)];
  }

  function submit() {
    // Guard against a keyboard submit (Cmd/Ctrl+Enter) firing while a post is
    // already in flight or the composer is disabled — the submit button is
    // disabled in those states, but the shortcut bypasses it and could
    // double-fire the mutation.
    if (disabled || isPending) {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }
    const result = onSubmit({
      body: trimmed,
      mentions: resolveMentions(trimmed),
    });
    // Clear the draft only once the submit resolves so a failed post keeps the
    // typed text (and picked mentions) for retry. Consumers whose `onSubmit`
    // returns void (fire-and-forget) clear immediately, preserving prior
    // behavior; consumers that return the mutation promise retain-on-failure.
    if (isPromiseLike(result)) {
      result.then(
        () => resetDraft(),
        () => {
          // Keep the draft on failure; the parent surfaces the error toast.
        }
      );
      return;
    }
    resetDraft();
  }

  function resetDraft() {
    setMentionQuery(null);
    if (controlled) {
      return;
    }
    setValue("");
    setPickedById(new Map());
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionQuery && suggestions.length > 0 && event.key === "Enter") {
      event.preventDefault();
      const first = suggestions[0];
      if (first) {
        selectMention(first);
      }
      return;
    }
    if (mentionQuery && event.key === "Escape") {
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

  return (
    <div className={containerClassName} data-comment-control="true">
      {helperText}
      <div className="relative">
        <Textarea
          aria-label={labelledBy ? undefined : (ariaLabel ?? placeholder)}
          aria-labelledby={labelledBy}
          className={`${minHeightClassName} resize-y text-sm`}
          data-comment-control="true"
          disabled={disabled}
          onChange={(event) => handleChange(event.target.value)}
          onClick={(event) =>
            syncMentionQuery(
              event.currentTarget.value,
              event.currentTarget.selectionStart ?? 0
            )
          }
          onKeyDown={handleKeyDown}
          onKeyUp={(event) =>
            syncMentionQuery(
              event.currentTarget.value,
              event.currentTarget.selectionStart ?? 0
            )
          }
          placeholder={placeholder}
          ref={textareaRef}
          value={value}
        />
        {showSuggestions && anchorRect ? (
          <MentionSuggestionList
            anchorRect={anchorRect}
            onSelect={selectMention}
            suggestions={suggestions}
          />
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            aria-label="Mention"
            className="h-7 w-7"
            data-comment-control="true"
            onClick={openPickerFromButton}
            size="icon"
            type="button"
            variant="ghost"
          >
            <AtSignIcon aria-hidden className="h-3.5 w-3.5" />
          </Button>
          {leadingActions}
        </div>
        <div className="flex items-center justify-end gap-2">
          {onCancel ? (
            <Button
              data-comment-control="true"
              disabled={isPending}
              onClick={onCancel}
              size="sm"
              title={cancelLabel}
              type="button"
              variant="outline"
            >
              {cancelLabel}
            </Button>
          ) : null}
          <Button
            data-comment-control="true"
            disabled={!hasContent || disabled || isPending}
            onClick={submit}
            size="sm"
            title={submitLabel}
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
 * True when a value is thenable (a Promise or Promise-like). Used to decide
 * whether an `onSubmit` return should gate the draft reset on resolution
 * (retain-on-failure) versus clear immediately (fire-and-forget `void`).
 */
function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value != null && typeof (value as { then?: unknown }).then === "function"
  );
}
