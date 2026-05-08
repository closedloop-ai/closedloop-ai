"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { ArrowUp } from "lucide-react";
import { useEffect, useRef } from "react";

export type PromptInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

/**
 * Chat-style prompt input: textarea with submit (arrow up) button.
 * Enter sends; Shift+Enter inserts newline. Auto-resizes vertically.
 */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  placeholder = "Ask anything",
  disabled = false,
  className,
}: Readonly<PromptInputProps>) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea when value changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: value is intentional
  useEffect(() => {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    el.style.height = "40px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (value.trim()) {
        onSubmit();
      }
    }
  };

  const canSubmit = value.trim().length > 0 && !disabled;

  return (
    <div className={cn("rounded-md border bg-background px-3 py-2", className)}>
      <div className="relative flex items-center">
        <textarea
          className={cn(
            "min-h-[40px] w-full resize-none bg-transparent py-2 pr-10 text-sm leading-relaxed placeholder:text-muted-foreground focus:outline-none focus:ring-0",
            "disabled:cursor-not-allowed disabled:opacity-50"
          )}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          ref={inputRef}
          rows={1}
          style={{
            maxHeight: "200px",
            overflow: "hidden",
          }}
          value={value}
        />
        <Button
          className="absolute right-0 shrink-0 rounded-md"
          disabled={!canSubmit}
          onClick={onSubmit}
          size="icon-sm"
          title="Send (Enter)"
          type="button"
          variant={canSubmit ? "default" : "secondary"}
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  );
}
