"use client";

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@closedloop-ai/design-system/components/ui/popover";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { InfoIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ComponentProps, FocusEvent, ReactNode } from "react";

type InfoHintProps = {
  /**
   * Accessible name for the trigger button and the popover dialog, e.g. "About
   * Active sessions" or "Metric details".
   */
  label: string;
  /** Popover body content; the caller owns its shape and text sizing. */
  children: ReactNode;
  /**
   * Extra classes for the trigger button — per-call-site size/alignment tuning.
   * The base already carries a widened `px-1.5` hit area so hovering the
   * whitespace around the glyph (not only its strokes) opens the popover
   * (FEA-3819). A caller that must keep the glyph in a fixed inline slot pairs
   * its own `-mx-1.5` here to cancel that padding's layout push while keeping the
   * enlarged hit box (see MetricCard's label trigger).
   */
  triggerClassName?: string;
  /** Icon size class (default `size-3.5`). */
  iconClassName?: string;
  /** Popover alignment against the trigger (default "start"). */
  align?: ComponentProps<typeof PopoverContent>["align"];
  /** Popover side (default "bottom"). */
  side?: ComponentProps<typeof PopoverContent>["side"];
  /** Gap in px between the trigger and the popover (default 0 — flush). */
  sideOffset?: number;
  /** Classes for the popover content (width, spacing, text size). */
  contentClassName?: string;
};

/**
 * A hover/focus info "ⓘ" affordance (FEA-3819). Hovering anywhere over the
 * widened icon target — or focusing it by keyboard — reveals a short explainer,
 * and moving away dismisses it; no click is required to show or persist it.
 * Moving the pointer into the popover keeps it open so its text stays
 * readable/selectable. A click (or a touch tap, which has no hover) pins it as a
 * secondary affordance and toggles closed. Generic: the caller supplies the
 * content and positions the popover. This is the single interaction model behind
 * the metric-card label icon and the insights tile info button.
 */
export function InfoHint({
  label,
  children,
  triggerClassName,
  iconClassName = "size-3.5",
  align = "start",
  side = "bottom",
  sideOffset = 0,
  contentClassName,
}: InfoHintProps) {
  const contentId = useId();
  const [openState, setOpenState] = useState({
    focus: false,
    hover: false,
    pinned: false,
  });
  const triggerClickShouldCloseRef = useRef(false);
  const open = openState.focus || openState.hover || openState.pinned;

  // Reveal on a genuine keyboard focus, not on a programmatic focus a
  // modal/focus-trap moves onto the trigger — see `trackInputModality` below.
  useEffect(() => {
    trackInputModality();
  }, []);

  const showTransientInfo = (reason: "focus" | "hover") => {
    setOpenState((currentState) => ({ ...currentState, [reason]: true }));
  };
  const hideTransientInfo = (reason: "focus" | "hover") => {
    setOpenState((currentState) => ({ ...currentState, [reason]: false }));
  };
  const togglePinnedInfo = (forceClose = false) =>
    setOpenState((currentState) => {
      if (forceClose || currentState.pinned) {
        return { focus: false, hover: false, pinned: false };
      }

      return { ...currentState, pinned: true };
    });
  const hideInfo = () =>
    setOpenState({ focus: false, hover: false, pinned: false });

  const handleTriggerClick = () => {
    const shouldClosePinnedInfo = triggerClickShouldCloseRef.current;
    triggerClickShouldCloseRef.current = false;
    togglePinnedInfo(shouldClosePinnedInfo);
  };

  const handlePointerDown = () => {
    // Capture whether the hint was already pinned so the click that FOLLOWS this
    // press toggles it correctly even when Radix closes the anchored content as
    // an outside interaction first. The click — which a touch tap also fires —
    // owns activation, so a tap can never pin on pointerdown and then unpin on
    // the click it produces (a real tap now opens/closes in one gesture).
    triggerClickShouldCloseRef.current = openState.pinned;
  };

  const handleBlur = (event: FocusEvent<HTMLButtonElement>) => {
    const relatedTarget = event.relatedTarget;
    const nextTargetIsInside =
      relatedTarget instanceof Node &&
      event.currentTarget.contains(relatedTarget);

    if (!nextTargetIsInside) {
      hideTransientInfo("focus");
    }
  };

  return (
    <Popover onOpenChange={(nextOpen) => !nextOpen && hideInfo()} open={open}>
      <PopoverAnchor asChild>
        <button
          aria-controls={open ? contentId : undefined}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={label}
          // `px-1.5` widens the hit box beyond the glyph so a hover lands on the
          // padding around the "i", not just its strokes (FEA-3819); a caller may
          // add `-mx-1.5` to keep the glyph in its original inline slot.
          className={cn(
            "inline-flex items-center justify-center px-1.5 text-muted-foreground/60 transition-colors hover:text-foreground",
            triggerClassName
          )}
          onBlur={handleBlur}
          onClick={handleTriggerClick}
          onFocus={() => {
            if (isKeyboardModality()) {
              showTransientInfo("focus");
            }
          }}
          onPointerDown={handlePointerDown}
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") {
              showTransientInfo("hover");
            }
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== "touch") {
              hideTransientInfo("hover");
            }
          }}
          type="button"
        >
          <InfoIcon className={iconClassName} />
        </button>
      </PopoverAnchor>
      <PopoverContent
        align={align}
        aria-label={label}
        className={contentClassName}
        id={contentId}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={hideInfo}
        onMouseEnter={() => showTransientInfo("hover")}
        onMouseLeave={() => hideTransientInfo("hover")}
        onOpenAutoFocus={(event) => event.preventDefault()}
        role="dialog"
        side={side}
        sideOffset={sideOffset}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

// Input-modality tracking so the hint reveals on a genuine KEYBOARD focus but not
// on a programmatic focus — e.g. a modal/focus-trap moving focus onto the trigger
// (the insights expand modal). A programmatic focus would otherwise pop the hint
// open unbidden and, being a Radix dismissable layer, swallow the enclosing
// modal's Escape. This mirrors the standard `:focus-visible` heuristic, which
// jsdom does not implement reliably. One pair of document-level listeners,
// attached lazily on first mount and never removed (a process-lifetime
// singleton), tracks whether the last interaction was a key or a pointer.
let keyboardModality = false;
let modalityListenersAttached = false;

function trackInputModality(): void {
  if (modalityListenersAttached || globalThis.document === undefined) {
    return;
  }
  modalityListenersAttached = true;
  globalThis.document.addEventListener(
    "keydown",
    () => {
      keyboardModality = true;
    },
    true
  );
  globalThis.document.addEventListener(
    "pointerdown",
    () => {
      keyboardModality = false;
    },
    true
  );
}

function isKeyboardModality(): boolean {
  return keyboardModality;
}
