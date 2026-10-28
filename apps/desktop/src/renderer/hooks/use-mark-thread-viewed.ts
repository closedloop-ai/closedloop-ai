import { useEffect, useRef } from "react";

/**
 * ISS-7830 — record that the user navigated INTO this thread.
 *
 * The renderer is the only process that can witness this. Headless
 * classification for an agent-spawned thread is DYNAMIC: a subagent thread a
 * person opened is interactive, one nobody opened is not — and the classifier
 * could not consult a signal the product never captured. This hook is the
 * capture.
 *
 * NAVIGATION IS THE ACT, with no dwell threshold, because the ruling names
 * navigating into the thread and any minimum dwell would be an invented number
 * deciding which sessions a human sees labelled autonomous. So it fires on mount:
 * the detail route mounting IS the user having navigated here.
 *
 * FIRE-AND-FORGET, and a failure is swallowed rather than surfaced. Nothing on
 * this screen depends on the answer, a client-side log is banned repo-wide, and a
 * toast about a classification input would be noise on a screen the user opened
 * to read something else.
 *
 * THE RETRY IS THE NEXT MOUNT, and that is what makes the silence acceptable. The
 * marker below lives on the mounted view, not on the module, so a capture that
 * failed or was refused is attempted again the next time the thread is opened —
 * and the store is monotonic, so a retry that lands late records the same fact. A
 * module-level latch would instead drop every future view of that thread for the
 * life of the process, which is why the scope is pinned by a test.
 */
export function useMarkThreadViewed(
  sessionId: string,
  markViewed: MarkThreadViewed = markThreadViewedOverIpc
): void {
  const markRef = useRef(markViewed);
  markRef.current = markViewed;
  // Written only from the effect, never the render phase, so StrictMode's
  // doubled render leaves it intact and the doubled mount EFFECT is what this
  // actually suppresses — one navigation, one message.
  const sentForRef = useRef<string | null>(null);
  useEffect(() => {
    if (sentForRef.current === sessionId) {
      return;
    }
    sentForRef.current = sessionId;
    markRef.current(sessionId);
  }, [sessionId]);
}

/** Seam for tests; production uses the preload IPC bridge. */
export type MarkThreadViewed = (sessionId: string) => void;

function markThreadViewedOverIpc(sessionId: string): void {
  try {
    window.desktopApi.db.markSessionViewed(sessionId).catch(() => undefined);
  } catch {
    // Preload surface unavailable; nothing was recorded and nothing to say.
  }
}
