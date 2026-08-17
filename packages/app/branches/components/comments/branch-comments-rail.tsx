"use client";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@repo/design-system/components/ui/sheet";
import { useMediaQuery } from "@repo/design-system/hooks/use-media-query";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { useCallback, useEffect, useRef } from "react";
import { BranchCommentsTab } from "./branch-comments-model";

const MOBILE_VIEWPORT_QUERY = "(max-width: 639px)";
const NARROW_VIEWPORT_QUERY = "(max-width: 1024px)";
export const BRANCH_COMMENTS_MIN_WIDTH = 280;
export const BRANCH_COMMENTS_MAX_WIDTH = 560;
const BRANCH_COMMENTS_KEYBOARD_STEP = 16;

/**
 * Responsive Branch comments shell. Wide layouts use a resizable inline rail;
 * narrow layouts use a right Sheet, and mobile uses a bottom Sheet. Both Sheet
 * variants trap focus, close on Escape, and return focus to the page toggle.
 */
export function BranchCommentsRail({
  activeTab,
  children,
  onClose,
  onWidthChange,
  open,
  returnFocusRef,
  width,
}: Readonly<{
  activeTab: BranchCommentsTab;
  children: ReactNode;
  onClose: () => void;
  onWidthChange: (width: number) => void;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  width: number;
}>) {
  const isMobile = useMediaQuery(MOBILE_VIEWPORT_QUERY);
  const isNarrow = useMediaQuery(NARROW_VIEWPORT_QUERY);
  const resizeHandlersRef = useRef<{
    onMove: (event: PointerEvent) => void;
    onUp: () => void;
  } | null>(null);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
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
  const resizeWithKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onWidthChange(width + BRANCH_COMMENTS_KEYBOARD_STEP);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onWidthChange(width - BRANCH_COMMENTS_KEYBOARD_STEP);
      } else if (event.key === "Home") {
        event.preventDefault();
        onWidthChange(BRANCH_COMMENTS_MIN_WIDTH);
      } else if (event.key === "End") {
        event.preventDefault();
        onWidthChange(BRANCH_COMMENTS_MAX_WIDTH);
      }
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

  if (!open) {
    return null;
  }

  if (isNarrow) {
    return (
      <Sheet onOpenChange={(nextOpen) => !nextOpen && onClose()} open={open}>
        <SheetContent
          className={
            isMobile
              ? "flex max-h-[85vh] flex-col gap-0 p-0"
              : "flex w-full flex-col gap-0 p-0 sm:max-w-md"
          }
          onCloseAutoFocus={(event) => {
            if (returnFocusRef.current) {
              event.preventDefault();
              returnFocusRef.current.focus();
            }
          }}
          side={isMobile ? "bottom" : "right"}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Comments</SheetTitle>
            <SheetDescription>
              {activeTab === BranchCommentsTab.Details
                ? "Comments for the Branch details view."
                : "Comments for the Sessions and timeline view."}
            </SheetDescription>
          </SheetHeader>
          {children}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      aria-label="Comments"
      className="relative flex shrink-0 flex-col border-l bg-background"
      style={{ width }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: WAI-ARIA window-splitter pattern requires an adjustable separator; an hr cannot receive pointer or keyboard resizing input. */}
      <button
        aria-label="Resize comments rail"
        aria-orientation="vertical"
        aria-valuemax={BRANCH_COMMENTS_MAX_WIDTH}
        aria-valuemin={BRANCH_COMMENTS_MIN_WIDTH}
        aria-valuenow={width}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-primary/40"
        onKeyDown={resizeWithKeyboard}
        onPointerDown={startResize}
        role="separator"
        type="button"
      />
      {children}
    </aside>
  );
}
