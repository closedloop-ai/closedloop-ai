"use client";

import type { AnchoredThreadsProps } from "@liveblocks/react-tiptap";
import { useEffect } from "react";

/**
 * Keeps Liveblocks floating UI (composer/toolbar/threads) within the editor bounds.
 * These elements are portaled to <body>, so we clamp their translated position.
 */
export function useConstrainFloatingWithinEditor(
  editor: AnchoredThreadsProps["editor"] | null | undefined
) {
  useEffect(() => {
    if (!editor) {
      return;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let isVisible = !document.hidden;

    // Debounced version for high-frequency events
    const clampFloatingElementsDebounced = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => clampFloatingElements(editor), 16); // ~60fps max
    };

    // Observe DOM mutations for when Liveblocks adds/moves floating elements
    const observer = new MutationObserver((mutations) => {
      if (isVisible && hasRelevantChanges(mutations)) {
        clampFloatingElements(editor);
      }
    });

    // Observe body for floating elements (they're portaled there)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });

    // Handle scroll/resize events
    const handleLayoutChange = () => {
      clampFloatingElementsDebounced();
    };

    window.addEventListener("scroll", handleLayoutChange, true);
    window.addEventListener("resize", handleLayoutChange);

    // Handle visibility changes (pause when tab is hidden)
    const handleVisibilityChange = () => {
      isVisible = !document.hidden;
      if (isVisible) {
        clampFloatingElements(editor);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Run once initially
    clampFloatingElements(editor);

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", handleLayoutChange, true);
      window.removeEventListener("resize", handleLayoutChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, [editor]);
}

const FLOATING_SELECTOR = [
  ".lb-tiptap-floating-composer",
  ".lb-tiptap-floating-toolbar",
  ".lb-tiptap-floating-threads",
  "[data-floating-composer]",
  "[data-floating-toolbar]",
  "[data-floating-threads]",
].join(",");

const BOUNDARY_SELECTOR = "[data-liveblocks-editor-boundary]";
const EDGE_PADDING = 8;

function clampFloatingElements(editor: AnchoredThreadsProps["editor"]) {
  const boundary = getBoundaryElement(editor);
  if (boundary) {
    const boundaryRect = boundary.getBoundingClientRect();
    const minLeft = boundaryRect.left + EDGE_PADDING;
    const maxRight = boundaryRect.right - EDGE_PADDING;
    const minTop = boundaryRect.top + EDGE_PADDING;
    const maxBottom = boundaryRect.bottom - EDGE_PADDING;

    const elements = document.querySelectorAll(FLOATING_SELECTOR);
    for (const element of elements) {
      if (element instanceof HTMLElement) {
        clampFloatingElement(element, minLeft, maxRight, minTop, maxBottom);
      }
    }
  }
}

function getBoundaryElement(editor: AnchoredThreadsProps["editor"]) {
  return editor?.view?.dom?.closest(BOUNDARY_SELECTOR) as HTMLElement | null;
}

function clampFloatingElement(
  element: HTMLElement,
  minLeft: number,
  maxRight: number,
  minTop: number,
  maxBottom: number
) {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return;
  }

  let deltaX = 0;
  let deltaY = 0;

  const availableWidth = maxRight - minLeft;
  if (rect.width > availableWidth) {
    deltaX += minLeft - rect.left;
  } else {
    if (rect.left < minLeft) {
      deltaX += minLeft - rect.left;
    }
    if (rect.right > maxRight) {
      deltaX -= rect.right - maxRight;
    }
  }

  const availableHeight = maxBottom - minTop;
  if (rect.height > availableHeight) {
    deltaY += minTop - rect.top;
  } else {
    if (rect.top < minTop) {
      deltaY += minTop - rect.top;
    }
    if (rect.bottom > maxBottom) {
      deltaY -= rect.bottom - maxBottom;
    }
  }

  if (deltaX || deltaY) {
    setElementTransform(element, deltaX, deltaY);
  }
}

function getTransformMatrix(transform: string) {
  if (!transform || transform === "none") {
    return null;
  }
  if (typeof DOMMatrixReadOnly === "undefined") {
    return null;
  }
  try {
    return new DOMMatrixReadOnly(transform);
  } catch {
    return null;
  }
}

function hasRelevantChanges(mutations: MutationRecord[]) {
  // Check if any floating elements were added or had style changes
  return mutations.some((mutation) => {
    if (mutation.type === "childList") {
      // Check if added nodes match our selectors
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement && node.matches(FLOATING_SELECTOR)) {
          return true;
        }
      }
    }
    if (mutation.type === "attributes" && mutation.attributeName === "style") {
      const target = mutation.target;
      if (target instanceof HTMLElement && target.matches(FLOATING_SELECTOR)) {
        return true;
      }
    }
    return false;
  });
}

function setElementTransform(
  element: HTMLElement,
  deltaX: number,
  deltaY: number
) {
  const matrix = getTransformMatrix(
    globalThis.getComputedStyle(element).transform
  );
  if (!matrix) {
    return;
  }
  const adjusted = DOMMatrix.fromMatrix(matrix);
  adjusted.m41 = matrix.m41 + deltaX;
  adjusted.m42 = matrix.m42 + deltaY;
  element.style.transform = adjusted.toString();
}
