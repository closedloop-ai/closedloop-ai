"use client";

import { cn } from "@repo/design-system/lib/utils";
import { Send, Square } from "lucide-react";
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

/**
 * Shared chat input area with auto-resize textarea and send/stop button.
 * Uses standardized primary (gold) color for accents.
 */
export function ChatInput({
  value,
  onChange,
  onSend,
  onStop,
  onKeyDown,
  isStreaming,
  placeholder = "Type a message...",
  disabled = false,
  beforeInput,
  footer,
}: Readonly<ChatInputProps>) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea when input changes
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = "40px";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Let parent handle keyboard events first
    if (onKeyDown) {
      onKeyDown(e);
      // If parent handled it (e.g., mention autocomplete), don't process further
      if (e.defaultPrevented) {
        return;
      }
    }

    // Enter without shift sends the message
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const canSend = value.trim() && !isStreaming && !disabled;

  return (
    <div className="shrink-0 border-border border-t bg-muted/30">
      {beforeInput}

      <div className="relative flex items-end gap-3 p-4 pt-3">
        <span className="shrink-0 pb-2.5 font-bold font-mono text-primary text-sm">
          {">"}
        </span>
        <div className="relative flex-1">
          <textarea
            className={cn(
              "w-full resize-none bg-transparent text-sm placeholder:text-muted-foreground",
              "py-2 pr-10 font-mono leading-relaxed",
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
              minHeight: "40px",
              maxHeight: "50vh",
              overflow: "hidden",
            }}
            value={value}
          />
          {isStreaming && onStop ? (
            <button
              className={cn(
                "absolute right-0 bottom-1.5 flex size-7 items-center justify-center rounded-lg",
                "cursor-pointer transition-all duration-200",
                "bg-foreground/[0.08] text-foreground/50 hover:bg-foreground/15 hover:text-foreground"
              )}
              onClick={onStop}
              title="Stop response"
              type="button"
            >
              <Square className="size-2.5 fill-current" />
            </button>
          ) : (
            <button
              className={cn(
                "absolute right-0 bottom-1.5 flex size-7 items-center justify-center rounded-lg",
                "transition-all duration-200",
                canSend
                  ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90"
                  : "cursor-not-allowed bg-muted text-muted-foreground"
              )}
              disabled={!canSend}
              onClick={onSend}
              type="button"
            >
              <Send className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {footer}
    </div>
  );
}
