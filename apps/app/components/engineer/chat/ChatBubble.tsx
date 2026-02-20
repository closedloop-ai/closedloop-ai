"use client";

import { cn } from "@repo/design-system/lib/utils";
import { Copy, Forward, PlayCircle, Trash2 } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { formatTime, type SuggestedAction } from "@/lib/engineer/chat-utils";

type ChatBubbleProps = {
  messageRole: "user" | "assistant";
  timestamp: string;
  roleLabel?: string;
  sender?: "claude" | "codex";
  isStreaming?: boolean;
  onDelete?: () => void;
  children: React.ReactNode;
  actions?: SuggestedAction[];
  onAction?: (action: SuggestedAction) => void;
  index?: number;
  bubbleClassName?: string;
  roleClassName?: string;
  extraActions?: React.ReactNode;
  onCopy?: () => void;
  onForward?: () => void;
  forwardLabel?: string;
  /** Context window usage percentage (0-100) — shown in role bar when present */
  contextPercent?: number | null;
};

/**
 * Shared message bubble wrapper for chat interfaces.
 * Uses standardized iMessage-style colors by default, with overrides via bubbleClassName/roleClassName.
 */
export const ChatBubble = memo(
  function ChatBubble({
    messageRole,
    timestamp,
    roleLabel,
    sender,
    isStreaming = false,
    onDelete,
    children,
    actions,
    onAction,
    index = 0,
    bubbleClassName,
    roleClassName,
    extraActions,
    onCopy,
    onForward,
    forwardLabel,
    contextPercent,
  }: Readonly<ChatBubbleProps>) {
    const isCodex = sender === "codex";
    const isUser = isCodex ? false : messageRole === "user";
    const isAssistant = isCodex || messageRole === "assistant";
    function defaultLabel() {
      if (isCodex) {
        return "Codex";
      }
      if (sender === "claude") {
        return "Claude";
      }
      if (isUser) {
        return "you";
      }
      return "closedloop.dev";
    }
    const displayLabel = roleLabel ?? defaultLabel();

    function roleColor() {
      if (isCodex) {
        return "text-[oklch(0.45_0.025_260)] dark:text-[oklch(0.65_0.025_260)]";
      }
      if (isUser) {
        return "text-muted-foreground";
      }
      return "text-primary";
    }

    function bubbleColor() {
      if (isCodex) {
        return "bg-[oklch(0.91_0.008_260)] dark:bg-[oklch(0.25_0.012_260)] text-foreground";
      }
      if (isUser) {
        return "bg-[#3b5bdb] dark:bg-[#364fc7] text-white";
      }
      return "bg-[#E5E5EA] dark:bg-[#38383D] text-foreground";
    }

    return (
      <div
        className={cn(
          "group fade-in slide-in-from-bottom-2 flex animate-in flex-col gap-1 duration-300",
          isCodex || isUser ? "items-end" : "items-start"
        )}
        style={{ animationDelay: `${index * 50}ms` }}
      >
        {/* Role indicator with action buttons */}
        <div className="flex items-center gap-2 px-1">
          <span
            className={cn(
              "font-mono text-[10px] uppercase tracking-wider",
              roleClassName ?? roleColor()
            )}
          >
            {displayLabel}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {formatTime(timestamp)}
          </span>
          {contextPercent != null && (
            <span className="font-mono text-[10px] text-muted-foreground/50">
              · {contextPercent}%
            </span>
          )}
          {onDelete && !isStreaming && (
            <button
              className="cursor-pointer rounded p-0.5 text-muted-foreground/50 opacity-0 transition-all hover:text-destructive group-hover:opacity-100"
              onClick={onDelete}
              title="Delete message"
            >
              <Trash2 className="size-3" />
            </button>
          )}
          {onCopy && !isStreaming && (
            <button
              className="cursor-pointer rounded p-0.5 text-muted-foreground/50 opacity-0 transition-all hover:scale-125 hover:text-foreground active:scale-95 group-hover:opacity-100"
              onClick={onCopy}
              title="Copy message"
            >
              <Copy className="size-3 transition-transform hover:-rotate-6" />
            </button>
          )}
          {onForward && !isStreaming && (
            <button
              className="cursor-pointer rounded p-0.5 text-muted-foreground/50 opacity-0 transition-all hover:scale-125 hover:text-primary active:scale-95 group-hover:opacity-100"
              onClick={onForward}
              title={forwardLabel ?? "Forward message"}
            >
              <Forward className="size-3 transition-transform hover:translate-x-0.5" />
            </button>
          )}
        </div>

        {/* Message content */}
        <div
          className={cn(
            "min-w-0 max-w-[90%] overflow-hidden rounded-xl px-4 py-2.5 text-sm leading-relaxed",
            bubbleClassName ??
              cn(bubbleColor(), isStreaming && "border border-primary/30")
          )}
        >
          {children}
        </div>

        {/* Elapsed time while streaming */}
        {isAssistant && isStreaming && (
          <div className="px-1">
            <ElapsedTimer start={timestamp} />
          </div>
        )}

        {/* Visibility note for Codex messages */}
        {isCodex && !isStreaming && (
          <p className="px-1 text-[10px] text-muted-foreground/50 italic">
            Only visible to you — other AI assistants cannot see this response
          </p>
        )}

        {/* Suggested action buttons for assistant messages */}
        {isAssistant &&
          !isStreaming &&
          actions &&
          actions.length > 0 &&
          onAction && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 px-1">
              {actions.map((action) => (
                <button
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium text-xs",
                    "border border-primary/20 bg-primary/10 text-primary",
                    "cursor-pointer transition-colors hover:border-primary/30 hover:bg-primary/20"
                  )}
                  key={action.label}
                  onClick={() => onAction(action)}
                  title={action.message}
                >
                  <PlayCircle className="size-3" />
                  {action.label}
                </button>
              ))}
            </div>
          )}

        {/* Extra actions slot */}
        {extraActions}
      </div>
    );
  },
  (prev, next) =>
    prev.messageRole === next.messageRole &&
    prev.timestamp === next.timestamp &&
    prev.roleLabel === next.roleLabel &&
    prev.sender === next.sender &&
    prev.isStreaming === next.isStreaming &&
    prev.children === next.children &&
    prev.index === next.index &&
    prev.bubbleClassName === next.bubbleClassName &&
    prev.roleClassName === next.roleClassName &&
    prev.extraActions === next.extraActions &&
    prev.forwardLabel === next.forwardLabel &&
    (prev.onDelete == null) === (next.onDelete == null) &&
    (prev.onCopy == null) === (next.onCopy == null) &&
    (prev.onForward == null) === (next.onForward == null) &&
    (prev.onAction == null) === (next.onAction == null) &&
    prev.contextPercent === next.contextPercent &&
    JSON.stringify(prev.actions) === JSON.stringify(next.actions)
);

/**
 * Displays elapsed time since a given start timestamp, updating every second.
 */
function ElapsedTimer({ start }: Readonly<{ start: string }>) {
  const [elapsed, setElapsed] = useState(() =>
    Math.max(0, Math.floor((Date.now() - new Date(start).getTime()) / 1000))
  );

  useEffect(() => {
    const t0 = new Date(start).getTime();
    const id = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - t0) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [start]);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const label = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  return (
    <span className="font-mono text-[10px] text-muted-foreground/50">
      · {label}
    </span>
  );
}
