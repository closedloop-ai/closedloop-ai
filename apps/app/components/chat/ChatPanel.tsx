"use client";

import { ChatInput } from "@repo/app/chat/components/chat-input";
import type { ChatMessage, ContentBlock } from "@repo/app/chat/lib/types";
import { cn } from "@repo/design-system/lib/utils";
import { memo, useEffect, useRef } from "react";
import { ChatBubble } from "@/components/chat/ChatBubble";
import { MessageContent } from "@/components/chat/MessageContent";
import { UserMessageContent } from "@/components/chat/UserMessageContent";

/**
 * Memoized transcript row. Takes the message DATA as props (rather than
 * receiving freshly-built JSX through `children`) so the underlying
 * `ChatBubble` memo comparator can short-circuit on unchanged messages.
 * Without this, the parent re-creates `children` JSX every render and the
 * `prev.children === next.children` check in `ChatBubble` never holds, so
 * the entire transcript re-renders on every stream tick / keystroke.
 */
const ChatRow = memo(function ChatRow({
  message,
  index,
}: Readonly<{ message: ChatMessage; index: number }>) {
  return (
    <ChatBubble
      index={index}
      isStreaming={false}
      messageRole={message.role}
      timestamp={message.timestamp}
    >
      {message.role === "user" ? (
        <UserMessageContent content={message.content} />
      ) : (
        <MessageContent blocks={message.blocks} content={message.content} />
      )}
    </ChatBubble>
  );
});

export type ChatPanelProps = {
  messages: ChatMessage[];
  isLoading: boolean;
  isStreaming: boolean;
  streamingContent: string;
  streamingBlocks: ContentBlock[];
  streamStartedAt: string;
  contextPercent: number | null;
  error: string | null;
  inputValue: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  onClear: () => void;
  currentProvider: string | null;
  currentModel: string | null;
  welcomeMessage?: string;
  inputPlaceholder?: string;
  contextSlot?: React.ReactNode;
  /** Content rendered in the chat-input footer slot (e.g. the model picker). */
  inputFooter?: React.ReactNode;
  notice?: string | null;
  className?: string;
};

function ProviderBadge({
  provider,
}: Readonly<{ provider: string }>): React.ReactElement {
  return (
    <span className="inline-flex items-center rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground uppercase tracking-wide">
      {provider}
    </span>
  );
}

export function ChatPanel({
  messages,
  isLoading,
  isStreaming,
  streamingContent,
  streamingBlocks,
  streamStartedAt,
  contextPercent,
  error,
  inputValue,
  onInputChange,
  onSend,
  onStop,
  onClear,
  currentProvider,
  currentModel: _currentModel,
  welcomeMessage,
  inputPlaceholder,
  contextSlot,
  inputFooter,
  notice,
  className,
}: Readonly<ChatPanelProps>) {
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messages.length === 0 && streamingContent.length === 0) {
      return;
    }
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  const showWelcome = !isLoading && messages.length === 0;
  const hasProviderBadge = currentProvider !== null && messages.length > 0;

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
        className
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-base text-foreground">Chat</span>
          {hasProviderBadge ? (
            <ProviderBadge provider={currentProvider ?? ""} />
          ) : null}
        </div>
        {messages.length > 0 ? (
          <button
            className="font-mono text-[11px] text-muted-foreground uppercase tracking-wide hover:text-foreground"
            onClick={onClear}
            type="button"
          >
            Clear
          </button>
        ) : null}
      </div>

      {notice ? (
        <output className="shrink-0 border-warning/30 border-b bg-warning/12 px-3 py-2 text-warning-foreground text-xs">
          {notice}
        </output>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {contextSlot}
        {showWelcome && welcomeMessage ? (
          <div className="rounded-md bg-muted/40 p-3 text-muted-foreground text-xs">
            {welcomeMessage}
          </div>
        ) : null}
        {messages.map((msg, index) => (
          <ChatRow index={index} key={msg.id} message={msg} />
        ))}
        {isStreaming ? (
          <ChatBubble
            contextPercent={contextPercent}
            index={messages.length}
            isStreaming
            messageRole="assistant"
            timestamp={streamStartedAt}
          >
            <MessageContent
              blocks={streamingBlocks}
              content={streamingContent}
              isStreaming
            />
          </ChatBubble>
        ) : null}
        <div ref={transcriptEndRef} />
      </div>

      {error ? (
        <div
          aria-live="polite"
          className="shrink-0 border-destructive/30 border-t bg-destructive/10 px-3 py-2 text-destructive text-xs"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <ChatInput
        footer={inputFooter}
        isStreaming={isStreaming}
        onChange={onInputChange}
        onSend={onSend}
        onStop={onStop}
        placeholder={inputPlaceholder ?? "Ask anything…"}
        value={inputValue}
      />
    </div>
  );
}
