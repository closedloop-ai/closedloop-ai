"use client";

import { cn } from "@repo/design-system/lib/utils";
import { useEffect, useRef } from "react";
import { ChatBubble } from "@/components/chat/ChatBubble";
import { ChatInput } from "@/components/chat/ChatInput";
import { MessageContent } from "@/components/chat/MessageContent";
import type { ChatMessage, ContentBlock } from "@/components/chat/types";
import { UserMessageContent } from "@/components/chat/UserMessageContent";

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
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
            Chat
          </span>
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
        <output className="shrink-0 border-amber-500/30 border-b bg-amber-500/10 px-3 py-2 text-amber-700 text-xs dark:text-amber-400">
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
          <ChatBubble
            index={index}
            isStreaming={false}
            key={msg.id}
            messageRole={msg.role}
            timestamp={msg.timestamp}
          >
            {msg.role === "user" ? (
              <UserMessageContent content={msg.content} />
            ) : (
              <MessageContent blocks={msg.blocks} content={msg.content} />
            )}
          </ChatBubble>
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
        isStreaming={isStreaming}
        onChange={onInputChange}
        onSend={onSend}
        onStop={onStop}
        placeholder={inputPlaceholder ?? "Ask anything"}
        value={inputValue}
      />
    </div>
  );
}
