"use client";

import { CHAT_MODEL_OPTIONS } from "@repo/app/chat/lib/default-models";
import { cn } from "@repo/design-system/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { PrCommentContext } from "@/app/(authenticated)/[orgSlug]/build/[id]/comment-context";
import { ChatModelSelect } from "@/components/chat/ChatModelSelect";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { useChatSession } from "@/hooks/chat/use-chat-session";

const STORAGE_KEY = "artifact-chat-panel-width";
const MIN_WIDTH = 280;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 320;

function getStoredWidth(): number {
  if (globalThis.window === undefined) {
    return DEFAULT_WIDTH;
  }
  try {
    const stored = globalThis.localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      const n = Number.parseInt(stored, 10);
      if (Number.isFinite(n)) {
        return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_WIDTH;
}

function setStoredWidth(w: number) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(w));
  } catch {
    // ignore
  }
}

function useResizableWidth(): {
  width: number;
  handleResizeStart: (e: React.MouseEvent) => void;
} {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // Holds the active drag's teardown function so the component can clean up
  // document listeners and body styles if it unmounts mid-drag. Without this,
  // an in-progress drag would leak `mousemove`/`mouseup` handlers and leave
  // `document.body.style.cursor = "col-resize"` stuck until the next drag.
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setWidth(getStoredWidth());
  }, []);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: width };

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragRef.current) {
          return;
        }
        const delta = dragRef.current.startX - ev.clientX;
        const newWidth = Math.min(
          MAX_WIDTH,
          Math.max(MIN_WIDTH, dragRef.current.startWidth + delta)
        );
        setWidth(newWidth);
        setStoredWidth(newWidth);
      };

      const teardown = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        cleanupRef.current = null;
      };

      const onMouseUp = () => {
        teardown();
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      cleanupRef.current = teardown;
    },
    [width]
  );

  return { width, handleResizeStart };
}

export type ChatDrawerPanelProps = {
  chatKey: string;
  context: string;
  provider?: "claude" | "codex";
  cwd?: string;
  welcomeMessage: string;
  contextSlot?: React.ReactNode;
  notice?: string | null;
  contextSelection?: PrCommentContext | null;
  onContextConsumed?: () => void;
  fillParent?: boolean;
};

export function ChatDrawerPanel({
  chatKey,
  context,
  provider = "claude",
  cwd,
  welcomeMessage,
  contextSlot,
  notice,
  contextSelection,
  onContextConsumed,
  fillParent = false,
}: Readonly<ChatDrawerPanelProps>) {
  const { width, handleResizeStart } = useResizableWidth();
  // Model the next message will be sent with. Provider stays pinned per chat;
  // this only switches model *within* the bound provider. `undefined` lets the
  // hook fall back to DEFAULT_CHAT_MODELS[provider].
  const [selectedModel, setSelectedModel] = useState<string | undefined>();

  const handleProviderMismatch = useCallback((boundProvider: string) => {
    toast.error(
      `This chat is bound to ${boundProvider}. Clear the chat to switch providers.`
    );
  }, []);

  const chat = useChatSession({
    chatKey,
    context,
    provider,
    model: selectedModel,
    cwd,
    onProviderMismatch: handleProviderMismatch,
    contextSelection,
    onContextConsumed,
  });

  // Once history loads, adopt the chat's persisted model as the initial picker
  // selection (only if it's one of this provider's offered options) so the
  // control reflects — and keeps sending — the model the chat is bound to,
  // until the user explicitly picks a different one.
  const { currentModel } = chat;
  useEffect(() => {
    if (
      selectedModel === undefined &&
      currentModel !== null &&
      CHAT_MODEL_OPTIONS[provider].some((o) => o.value === currentModel)
    ) {
      setSelectedModel(currentModel);
    }
  }, [currentModel, provider, selectedModel]);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 min-w-0 max-w-full overflow-hidden bg-background",
        !fillParent && "border-l"
      )}
      style={fillParent ? undefined : { width }}
    >
      {!fillParent && (
        <button
          aria-label="Resize chat panel"
          className="w-1 shrink-0 cursor-col-resize border-y-0 border-r-0 border-l bg-transparent p-0 transition-colors hover:bg-primary/30 focus:outline-none active:bg-primary/50"
          onMouseDown={handleResizeStart}
          type="button"
        />
      )}
      <ChatPanel
        className="flex-1"
        contextPercent={chat.contextPercent}
        contextSlot={contextSlot}
        currentModel={chat.currentModel}
        currentProvider={chat.currentProvider}
        error={chat.error}
        inputFooter={
          <ChatModelSelect
            disabled={chat.isStreaming}
            onChange={setSelectedModel}
            provider={provider}
            value={selectedModel}
          />
        }
        inputValue={chat.inputValue}
        isLoading={chat.isLoading}
        isStreaming={chat.isStreaming}
        messages={chat.messages}
        notice={notice}
        onClear={chat.clearHistory}
        onInputChange={chat.setInputValue}
        onSend={chat.sendMessage}
        onStop={chat.stopStreaming}
        streamingBlocks={chat.streamingBlocks}
        streamingContent={chat.streamingContent}
        streamStartedAt={chat.streamStartedAt}
        welcomeMessage={welcomeMessage}
      />
    </div>
  );
}
