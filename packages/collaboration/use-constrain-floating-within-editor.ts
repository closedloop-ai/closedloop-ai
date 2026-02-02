"use client";

import type { AnchoredThreadsProps } from "@liveblocks/react-tiptap";
import { useEffect } from "react";

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

function getBoundaryElement(editor: AnchoredThreadsProps["editor"]) {
  return editor?.view?.dom?.closest(BOUNDARY_SELECTOR) as HTMLElement | null;
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

    let rafId = 0;

    const clampFloatingElements = () => {
      const boundary = getBoundaryElement(editor);
      if (boundary) {
        const boundaryRect = boundary.getBoundingClientRect();
        const minLeft = boundaryRect.left + EDGE_PADDING;
        const maxRight = boundaryRect.right - EDGE_PADDING;
        const minTop = boundaryRect.top + EDGE_PADDING;
        const maxBottom = boundaryRect.bottom - EDGE_PADDING;

        const elements = document.querySelectorAll(FLOATING_SELECTOR);
        for (const element of elements) {
          if (!(element instanceof HTMLElement)) {
            continue;
          }

          const rect = element.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) {
            continue;
          }

          const matrix = getTransformMatrix(
            window.getComputedStyle(element).transform
          );
          if (!matrix) {
            continue;
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
            if (typeof DOMMatrix === "undefined") {
              continue;
            }
            const adjusted = DOMMatrix.fromMatrix(matrix);
            adjusted.m41 = matrix.m41 + deltaX;
            adjusted.m42 = matrix.m42 + deltaY;
            element.style.transform = adjusted.toString();
          }
        }
      }

      rafId = requestAnimationFrame(clampFloatingElements);
    };

    rafId = requestAnimationFrame(clampFloatingElements);

    return () => cancelAnimationFrame(rafId);
  }, [editor]);
}
