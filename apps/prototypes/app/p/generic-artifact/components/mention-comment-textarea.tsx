"use client";

// Prototype-local mention behavior; promotion requires a separate shared-component review.

import { Button } from "@repo/design-system/components/ui/button";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { cn } from "@repo/design-system/lib/utils";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";

const MENTION_PEOPLE = [
  { initials: "AE", name: "Andrew Eye" },
  { initials: "PB", name: "Parker Byrd" },
  { initials: "SC", name: "Sam Chen" },
  { initials: "JL", name: "Jordan Lee" },
] as const;

const MENTION_QUERY_PATTERN = /(?:^|\s)@([^@\n]*)$/;
const RENDERED_MENTION_PATTERN =
  /(@(?:Andrew Eye|Parker Byrd|Sam Chen|Jordan Lee))/g;

type MentionCommentTextareaProps = {
  ariaLabel: string;
  autoFocus?: boolean;
  className?: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  value: string;
};

type MentionCommentComposerProps = {
  cancelLabel?: string;
  defaultValue?: string;
  minHeightClassName?: string;
  onCancel?: () => void;
  onSubmit: (body: string) => void;
  placeholder?: string;
  submitLabel?: string;
};

export function MentionCommentTextarea({
  ariaLabel,
  autoFocus,
  className,
  onChange,
  onKeyDown,
  placeholder,
  value,
}: MentionCommentTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [mention, setMention] = useState<{
    end: number;
    query: string;
    start: number;
  } | null>(null);
  const matches = mention
    ? MENTION_PEOPLE.filter(({ name }) =>
        name.toLowerCase().includes(mention.query.toLowerCase())
      )
    : [];

  const updateMention = (nextValue: string, caret: number) => {
    const prefix = nextValue.slice(0, caret);
    const match = prefix.match(MENTION_QUERY_PATTERN);
    if (!match) {
      setMention(null);
      return;
    }
    const query = match[1] ?? "";
    const atOffset = match[0].lastIndexOf("@");
    setActiveIndex(0);
    setMention({
      end: caret,
      query,
      start: prefix.length - match[0].length + atOffset,
    });
  };

  const chooseMention = (name: string) => {
    if (!mention) {
      return;
    }
    const replacement = `@${name} `;
    const nextValue =
      value.slice(0, mention.start) + replacement + value.slice(mention.end);
    const nextCaret = mention.start + replacement.length;
    onChange(nextValue);
    setMention(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  return (
    <div className="relative">
      <Textarea
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        className={className}
        onChange={(event) => {
          onChange(event.target.value);
          updateMention(event.target.value, event.target.selectionStart);
        }}
        onClick={(event) =>
          updateMention(
            event.currentTarget.value,
            event.currentTarget.selectionStart
          )
        }
        onKeyDown={(event) => {
          if (mention && matches.length > 0) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((current) => (current + 1) % matches.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex(
                (current) => (current - 1 + matches.length) % matches.length
              );
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              chooseMention(matches[activeIndex]?.name ?? matches[0].name);
              return;
            }
          }
          if (event.key === "Escape" && mention) {
            event.preventDefault();
            setMention(null);
            return;
          }
          onKeyDown?.(event);
        }}
        placeholder={placeholder}
        ref={textareaRef}
        value={value}
      />
      {mention && matches.length > 0 ? (
        <div
          aria-label="Mention someone"
          className="absolute right-0 bottom-[calc(100%+0.375rem)] left-0 z-50 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground opacity-100 shadow-xl"
          role="listbox"
        >
          <div className="px-2 py-1 text-muted-foreground text-xs">
            Mention someone
          </div>
          {matches.map((person, index) => (
            <button
              aria-selected={index === activeIndex}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                index === activeIndex ? "bg-accent" : "hover:bg-muted"
              )}
              key={person.name}
              onMouseDown={(event) => {
                event.preventDefault();
                chooseMention(person.name);
              }}
              role="option"
              type="button"
            >
              <span className="flex size-6 items-center justify-center rounded-full bg-muted font-medium text-[10px]">
                {person.initials}
              </span>
              {person.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MentionText({ text }: { text: string }): ReactNode {
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(RENDERED_MENTION_PATTERN)) {
    const start = match.index;
    if (start > cursor) {
      content.push(
        <span key={`text-${cursor}`}>{text.slice(cursor, start)}</span>
      );
    }
    content.push(
      <span className="font-medium text-primary" key={`mention-${start}`}>
        {match[0]}
      </span>
    );
    cursor = start + match[0].length;
  }
  if (cursor < text.length) {
    content.push(<span key={`text-${cursor}`}>{text.slice(cursor)}</span>);
  }
  return content;
}

export function MentionCommentComposer({
  cancelLabel = "Cancel",
  defaultValue = "",
  minHeightClassName = "min-h-20",
  onCancel,
  onSubmit,
  placeholder = "Add a comment and @mention someone…",
  submitLabel = "Comment",
}: MentionCommentComposerProps) {
  const [draft, setDraft] = useState(defaultValue);
  const submit = () => {
    const body = draft.trim();
    if (!body) {
      return;
    }
    onSubmit(body);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-2" data-comment-control>
      <MentionCommentTextarea
        ariaLabel={placeholder}
        className={cn(minHeightClassName, "resize-y text-sm")}
        onChange={setDraft}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        value={draft}
      />
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button
            onClick={() => {
              setDraft(defaultValue);
              onCancel();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {cancelLabel}
          </Button>
        ) : null}
        <Button
          disabled={!draft.trim()}
          onClick={submit}
          size="sm"
          type="button"
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
