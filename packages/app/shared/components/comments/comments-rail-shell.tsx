"use client";

import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@repo/design-system/components/ui/sheet";
import { useMediaQuery } from "@repo/design-system/hooks/use-media-query";
import { cn } from "@repo/design-system/lib/utils";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { useCallback, useEffect, useRef } from "react";
import {
  COMMENTS_MOBILE_MAX_WIDTH,
  COMMENTS_NARROW_QUERY,
  COMMENTS_RAIL_KEYBOARD_STEP,
  CommentsPaneLayout,
  clampCommentsRailWidth,
  commentsRailWidthBounds,
} from "./comments-pane-model";

const MOBILE_VIEWPORT_QUERY = `(max-width: ${COMMENTS_MOBILE_MAX_WIDTH}px)`;

/**
 * The responsive comments shell, generalized out of Branch's rail (first
 * promoted in #7763): an inline resizable rail when wide, a right Sheet when
 * narrow, a bottom Sheet on mobile. It owns placement, resize and focus only;
 * the content is `children`.
 *
 * `layout` lets a host that measures its own container (the artifact detail
 * shell) choose the arrangement instead of the viewport query.
 *
 * `dismissOnEscape`, `keepOpenOnFieldEscape` and `hideSheetClose` are opt-in
 * so Branch's shipped rail keeps its exact behavior; the canonical pane sets
 * all three.
 */
export function CommentsRailShell({
  availableWidth,
  children,
  description,
  dismissOnEscape = false,
  hideSheetClose = false,
  keepOpenOnFieldEscape = false,
  label = "Comments",
  layout,
  onClose,
  onWidthChange,
  onWidthCommit,
  open,
  returnFocusRef,
  width,
}: Readonly<{
  availableWidth?: number;
  children: ReactNode;
  description: ReactNode;
  /** Escape on the wide inline rail closes it and returns focus to the trigger. */
  dismissOnEscape?: boolean;
  /** For content that carries its own close control. */
  hideSheetClose?: boolean;
  /**
   * In the narrow and mobile Sheet, Escape typed into a field stays with the
   * field (or its composer's Cancel) instead of closing the Sheet. Off, the
   * Sheet keeps plain Radix behavior: Escape closes it from anywhere.
   */
  keepOpenOnFieldEscape?: boolean;
  /** The landmark's and the Sheet's accessible name. */
  label?: string;
  layout?: CommentsPaneLayout;
  onClose: () => void;
  onWidthChange: (width: number) => void;
  /** Once per drag, at pointer-up, and once per keyboard step. */
  onWidthCommit?: (width: number) => void;
  open: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  width: number;
}>) {
  const viewportMobile = useMediaQuery(MOBILE_VIEWPORT_QUERY);
  const viewportNarrow = useMediaQuery(COMMENTS_NARROW_QUERY);
  const resolvedLayout =
    layout ?? viewportLayout(viewportMobile, viewportNarrow);
  const resolvedWidth = clampCommentsRailWidth(width, availableWidth);
  const bounds = commentsRailWidthBounds(availableWidth);
  const resizeHandlersRef = useRef<{
    onMove: (event: PointerEvent) => void;
    onUp: () => void;
  } | null>(null);
  const setWidth = useCallback(
    (next: number) => {
      const clamped = clampCommentsRailWidth(next, availableWidth);
      onWidthChange(clamped);
      return clamped;
    },
    [availableWidth, onWidthChange]
  );

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = resolvedWidth;
      let latestWidth = startWidth;
      let moved = false;

      function onMove(moveEvent: PointerEvent) {
        moved = true;
        latestWidth = setWidth(startWidth - (moveEvent.clientX - startX));
      }

      function onUp() {
        globalThis.window.removeEventListener("pointermove", onMove);
        globalThis.window.removeEventListener("pointerup", onUp);
        resizeHandlersRef.current = null;
        // A click with no drag must not persist the width clamped to this container.
        if (moved) {
          onWidthCommit?.(latestWidth);
        }
      }

      resizeHandlersRef.current = { onMove, onUp };
      globalThis.window.addEventListener("pointermove", onMove);
      globalThis.window.addEventListener("pointerup", onUp);
    },
    [onWidthCommit, resolvedWidth, setWidth]
  );
  const resizeWithKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const next = keyboardResizeTarget(event.key, resolvedWidth, bounds);
      if (next !== null) {
        event.preventDefault();
        const committed = setWidth(next);
        onWidthCommit?.(committed);
      }
    },
    [bounds, onWidthCommit, resolvedWidth, setWidth]
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

  if (resolvedLayout !== CommentsPaneLayout.Wide) {
    const mobile = resolvedLayout === CommentsPaneLayout.Mobile;
    return (
      <Sheet onOpenChange={(nextOpen) => !nextOpen && onClose()} open={open}>
        <SheetContent
          className={
            mobile
              ? "flex max-h-[85vh] flex-col gap-0 p-0"
              : "flex w-full flex-col gap-0 p-0 sm:max-w-md"
          }
          hideClose={hideSheetClose}
          onCloseAutoFocus={(event) => {
            if (returnFocusRef?.current) {
              event.preventDefault();
              returnFocusRef.current.focus();
            }
          }}
          onEscapeKeyDown={(event) => {
            // Escape while typing belongs to the field (or its composer's Cancel).
            if (keepOpenOnFieldEscape && isTextEntryEscape(event)) {
              event.preventDefault();
            }
          }}
          side={mobile ? "bottom" : "right"}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{label}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          {children}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Escape bubbles here from the rail's own focusable controls; the landmark itself takes no input.
    <aside
      aria-label={label}
      className="relative flex shrink-0 flex-col border-l bg-background"
      onKeyDown={(event) => {
        if (
          dismissOnEscape &&
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !isTextEntryEscape(event.nativeEvent)
        ) {
          event.preventDefault();
          onClose();
          returnFocusRef?.current?.focus();
        }
      }}
      style={{ width: resolvedWidth }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: WAI-ARIA window-splitter pattern requires an adjustable separator; an hr cannot receive pointer or keyboard resizing input. */}
      <button
        aria-label="Resize comments rail"
        aria-orientation="vertical"
        aria-valuemax={bounds.max}
        aria-valuemin={bounds.min}
        aria-valuenow={resolvedWidth}
        className={cn(
          "absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-primary/40",
          CHIP_FOCUS_RING_CLASS
        )}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={startResize}
        role="separator"
        type="button"
      />
      {children}
    </aside>
  );
}

/** An IME composition, or Escape from a field the user is typing in. */
function isTextEntryEscape(event: KeyboardEvent): boolean {
  const target = event.target;
  return (
    event.isComposing ||
    (target instanceof HTMLElement &&
      (target.isContentEditable ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement))
  );
}

function viewportLayout(mobile: boolean, narrow: boolean): CommentsPaneLayout {
  if (mobile) {
    return CommentsPaneLayout.Mobile;
  }
  return narrow ? CommentsPaneLayout.Narrow : CommentsPaneLayout.Wide;
}

/** ArrowLeft widens because the rail grows leftward from the right edge. */
function keyboardResizeTarget(
  key: string,
  width: number,
  bounds: { max: number; min: number }
): number | null {
  switch (key) {
    case "ArrowLeft":
      return width + COMMENTS_RAIL_KEYBOARD_STEP;
    case "ArrowRight":
      return width - COMMENTS_RAIL_KEYBOARD_STEP;
    case "Home":
      return bounds.min;
    case "End":
      return bounds.max;
    default:
      return null;
  }
}
