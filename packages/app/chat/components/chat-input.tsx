"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef } from "react";

type ChatInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  isStreaming: boolean;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Custom content to render before the textarea (e.g., context indicators, image previews)
   */
  beforeInput?: React.ReactNode;
  /**
   * Custom content to render after the input area (e.g., message count, clear button)
   */
  footer?: React.ReactNode;
};

export function ChatInput({
  value,
  onChange,
  onSend,
  onStop,
  onKeyDown,
  isStreaming,
  placeholder = "Ask anything…",
  disabled = false,
  beforeInput,
  footer,
}: Readonly<ChatInputProps>) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    if (value.length > 0) {
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (onKeyDown) {
      onKeyDown(e);
      if (e.defaultPrevented) {
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const canSend = Boolean(value.trim()) && !isStreaming && !disabled;

  return (
    <div className="shrink-0 bg-background p-3">
      {beforeInput}

      <div
        className={cn(
          "flex items-end gap-2 rounded-xl border border-input-border bg-input py-2 pr-2 pl-3",
          "transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
        )}
      >
        <textarea
          aria-label="Chat input"
          className={cn(
            "flex-1 resize-none self-center bg-transparent text-sm leading-relaxed placeholder:text-muted-foreground",
            "focus:outline-none focus:ring-0",
            "disabled:cursor-not-allowed disabled:opacity-50"
          )}
          disabled={isStreaming || disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          ref={inputRef}
          rows={1}
          style={{
            maxHeight: "50vh",
            overflow: "hidden",
          }}
          value={value}
        />
        {isStreaming && onStop ? (
          <Button
            aria-label="Stop response"
            className="rounded-lg"
            onClick={onStop}
            size="icon-sm"
            title="Stop response"
            type="button"
            variant="ghost"
          >
            <Square className="size-3 fill-current" />
          </Button>
        ) : (
          <Button
            aria-label="Send message"
            className="rounded-lg"
            disabled={!canSend}
            onClick={onSend}
            size="icon-sm"
            type="button"
            variant={canSend ? "default" : "ghost"}
          >
            <ArrowUp />
          </Button>
        )}
      </div>

      {footer}
    </div>
  );
}
