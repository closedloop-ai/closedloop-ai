"use client";

import { useMediaQuery } from "@closedloop-ai/design-system/hooks/use-media-query";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "./sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

const NARROW_VIEWPORT_QUERY = "(max-width: 1024px)";
// Below the `sm` breakpoint (640px) the rail is a bottom sheet, not a
// fixed-width right overlay — a 400px overlay leaves almost nothing on a phone.
const MOBILE_VIEWPORT_QUERY = "(max-width: 639px)";
const NARROW_OVERLAY_WIDTH = 400;

export const FeedRailTab = {
  Feed: "feed",
  Chat: "chat",
} as const;

export type FeedRailTab = (typeof FeedRailTab)[keyof typeof FeedRailTab];

/**
 * Layout mode for the feed rail (FEA-3865).
 * - `inline`: adaptive — a resizable inline rail at `lg+`, a fixed-width right
 *   overlay from `sm`..`lg`, and a bottom sheet below `sm`. This is the
 *   historical behavior (desktop unchanged) plus the new mobile sheet, and is
 *   the default.
 * - `overlay`: always the fixed-width right overlay with a click-to-close scrim.
 * - `sheet`: always the bottom sheet.
 */
export const FeedRailMode = {
  Inline: "inline",
  Overlay: "overlay",
  Sheet: "sheet",
} as const;

export type FeedRailMode = (typeof FeedRailMode)[keyof typeof FeedRailMode];

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
  /**
   * FEA-3865: how the rail lays out. Defaults to `inline` (the adaptive
   * inline→overlay→sheet behavior). Callers rarely override this — it exists so
   * a surface can pin one layout, and so stories/tests can exercise a single
   * mode.
   */
  mode?: FeedRailMode;
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
  mode = FeedRailMode.Inline,
}: Readonly<FeedRailProps>) {
  const isNarrow = useMediaQuery(NARROW_VIEWPORT_QUERY);
  const isMobile = useMediaQuery(MOBILE_VIEWPORT_QUERY);

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

  const effectiveTab: FeedRailTab = hasChat ? activeTab : FeedRailTab.Feed;

  // Resolve the effective layout. `inline` is adaptive (sheet < sm, overlay
  // sm..lg, inline lg+); the other two modes are forced.
  const resolvedMode = resolveFeedRailMode(mode, isMobile, isNarrow);

  if (!visible) {
    return null;
  }

  // The pointer resize handle is inline-only — overlay and sheet have no
  // draggable edge (nothing to resize against).
  const railBody = (
    <FeedRailBody
      chatPanel={chatPanel}
      effectiveTab={effectiveTab}
      feedPanel={feedPanel}
      hasChat={hasChat}
      onStartResize={
        resolvedMode === FeedRailMode.Inline ? startResize : undefined
      }
      onTabChange={onTabChange}
    />
  );

  if (resolvedMode === FeedRailMode.Sheet) {
    return (
      <Sheet
        onOpenChange={(open) => {
          if (!open) {
            onClose();
          }
        }}
        open={visible}
      >
        <SheetContent
          className="flex max-h-[85vh] flex-col gap-0 p-0"
          side="bottom"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Feed</SheetTitle>
          </SheetHeader>
          {railBody}
        </SheetContent>
      </Sheet>
    );
  }

  const isOverlay = resolvedMode === FeedRailMode.Overlay;

  return (
    <>
      {isOverlay ? (
        <button
          aria-label="Close feed rail"
          className="fixed inset-0 z-[var(--z-overlay)] bg-black/30"
          onClick={onClose}
          type="button"
        />
      ) : null}
      <aside
        className={
          isOverlay
            ? "fixed inset-y-0 right-0 z-[var(--z-modal)] flex flex-col border-l bg-background"
            : "relative flex shrink-0 flex-col border-l bg-background"
        }
        style={{ width: isOverlay ? NARROW_OVERLAY_WIDTH : width }}
      >
        {railBody}
      </aside>
    </>
  );
}

/**
 * The tab shell + feed/chat panels, shared by all three layout modes so the
 * inline rail, the overlay, and the bottom sheet render identical content. The
 * resize handle only appears when `onStartResize` is supplied (inline mode).
 */
function FeedRailBody({
  effectiveTab,
  hasChat,
  onTabChange,
  feedPanel,
  chatPanel,
  onStartResize,
}: {
  effectiveTab: FeedRailTab;
  hasChat: boolean;
  onTabChange: (next: FeedRailTab) => void;
  feedPanel: ReactNode;
  chatPanel?: ReactNode;
  onStartResize?: (event: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <>
      {onStartResize ? (
        <button
          aria-label="Resize feed rail"
          className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-primary/40"
          onPointerDown={onStartResize}
          type="button"
        />
      ) : null}
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
    </>
  );
}

/**
 * Collapse the requested `mode` + the current viewport into the layout that
 * actually renders. `overlay`/`sheet` are forced; `inline` is adaptive — a
 * bottom sheet below `sm`, the fixed-width overlay from `sm`..`lg`, and the
 * resizable inline rail at `lg+` (the historical behavior).
 */
function resolveFeedRailMode(
  mode: FeedRailMode,
  isMobile: boolean,
  isNarrow: boolean
): FeedRailMode {
  if (mode !== FeedRailMode.Inline) {
    return mode;
  }
  if (isMobile) {
    return FeedRailMode.Sheet;
  }
  if (isNarrow) {
    return FeedRailMode.Overlay;
  }
  return FeedRailMode.Inline;
}
