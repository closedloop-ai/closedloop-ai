"use client";

import { useMediaQuery } from "@repo/design-system/hooks/use-media-query";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

const NARROW_VIEWPORT_QUERY = "(max-width: 1024px)";
const NARROW_OVERLAY_WIDTH = 400;

export const FeedRailTab = {
  Feed: "feed",
  Chat: "chat",
} as const;

export type FeedRailTab = (typeof FeedRailTab)[keyof typeof FeedRailTab];

type FeedRailProps = {
  visible: boolean;
  onClose: () => void;
  width: number;
  onWidthChange: (nextWidth: number) => void;
  activeTab: FeedRailTab;
  hasChat: boolean;
  onTabChange: (next: FeedRailTab) => void;
  feedPanel: ReactNode;
  chatPanel?: ReactNode;
};

export function FeedRail({
  visible,
  onClose,
  width,
  onWidthChange,
  activeTab,
  hasChat,
  onTabChange,
  feedPanel,
  chatPanel,
}: Readonly<FeedRailProps>) {
  const isNarrow = useMediaQuery(NARROW_VIEWPORT_QUERY);

  const resizeHandlersRef = useRef<{
    onMove: (e: PointerEvent) => void;
    onUp: () => void;
  } | null>(null);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;

      function onMove(moveEvent: PointerEvent) {
        onWidthChange(startWidth - (moveEvent.clientX - startX));
      }

      function onUp() {
        globalThis.window.removeEventListener("pointermove", onMove);
        globalThis.window.removeEventListener("pointerup", onUp);
        resizeHandlersRef.current = null;
      }

      resizeHandlersRef.current = { onMove, onUp };
      globalThis.window.addEventListener("pointermove", onMove);
      globalThis.window.addEventListener("pointerup", onUp);
    },
    [onWidthChange, width]
  );

  useEffect(() => {
    return () => {
      const handlers = resizeHandlersRef.current;
      if (handlers) {
        globalThis.window.removeEventListener("pointermove", handlers.onMove);
        globalThis.window.removeEventListener("pointerup", handlers.onUp);
      }
    };
  }, []);

  if (!visible) {
    return null;
  }

  const effectiveTab: FeedRailTab = hasChat ? activeTab : FeedRailTab.Feed;

  return (
    <>
      {isNarrow ? (
        <button
          aria-label="Close feed rail"
          className="fixed inset-0 z-40 bg-black/30"
          onClick={onClose}
          type="button"
        />
      ) : null}
      <aside
        className={
          isNarrow
            ? "fixed inset-y-0 right-0 z-50 flex flex-col border-l bg-background"
            : "relative flex shrink-0 flex-col border-l bg-background"
        }
        style={{ width: isNarrow ? NARROW_OVERLAY_WIDTH : width }}
      >
        {isNarrow ? null : (
          <button
            aria-label="Resize feed rail"
            className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-primary/40"
            onPointerDown={startResize}
            type="button"
          />
        )}
        <Tabs
          className="flex min-h-0 flex-1 flex-col gap-0"
          onValueChange={(value) => onTabChange(value as FeedRailTab)}
          value={effectiveTab}
        >
          <header className="flex h-10 shrink-0 items-center border-b px-3">
            <TabsList aria-label="Feed mode">
              <TabsTrigger value={FeedRailTab.Feed}>Feed</TabsTrigger>
              {hasChat ? (
                <TabsTrigger value={FeedRailTab.Chat}>Chat</TabsTrigger>
              ) : null}
            </TabsList>
          </header>
          <TabsContent
            className="flex min-h-0 flex-1 flex-col"
            value={FeedRailTab.Feed}
          >
            {feedPanel}
          </TabsContent>
          {hasChat ? (
            <TabsContent
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
              value={FeedRailTab.Chat}
            >
              {chatPanel}
            </TabsContent>
          ) : null}
        </Tabs>
      </aside>
    </>
  );
}
