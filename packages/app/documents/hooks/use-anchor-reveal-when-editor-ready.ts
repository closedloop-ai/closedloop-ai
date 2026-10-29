"use client";

import { scrollToAnchor } from "@repo/collaboration/client/scroll-to-anchor";
import { useCallback, useEffect, useRef } from "react";

/**
 * Scrolls the editor to a thread's anchor, holding the request until the editor
 * has content. A reveal requested from another tab lands as soon as the
 * Artifact panel commits, which can be before the rich-text editor has mounted
 * its content, and a scroll then finds no anchor mark.
 */
export function useAnchorRevealWhenEditorReady(
  isEditorReady: boolean
): (threadId: string) => void {
  const isEditorReadyRef = useRef(isEditorReady);
  const pendingThreadIdRef = useRef<string | null>(null);

  useEffect(() => {
    isEditorReadyRef.current = isEditorReady;
    if (!isEditorReady) {
      return;
    }
    const pendingThreadId = pendingThreadIdRef.current;
    if (pendingThreadId !== null) {
      pendingThreadIdRef.current = null;
      scrollToAnchor(pendingThreadId);
    }
  }, [isEditorReady]);

  return useCallback((threadId: string) => {
    if (isEditorReadyRef.current) {
      pendingThreadIdRef.current = null;
      scrollToAnchor(threadId);
      return;
    }
    pendingThreadIdRef.current = threadId;
  }, []);
}
