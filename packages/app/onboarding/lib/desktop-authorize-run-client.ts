import { DESKTOP_AUTHORIZE_RUN_PATHNAME } from "@repo/api/src/types/desktop-authorize-url";

/**
 * Consume the pending Desktop authorize run before a terminal handback.
 * Best effort and tightly bounded so a stalled cleanup cannot outlive the
 * one-time code it precedes.
 */
export async function clearDesktopAuthorizeRun(): Promise<void> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(),
    DESKTOP_AUTHORIZE_RUN_CLEAR_TIMEOUT_MS
  );
  try {
    await globalThis.fetch(DESKTOP_AUTHORIZE_RUN_PATHNAME, {
      method: "DELETE",
      credentials: "same-origin",
      signal: controller.signal,
    });
  } catch {
    // Best effort. The cookie's own TTL bounds a cleanup failure.
  } finally {
    clearTimeout(deadline);
  }
}

export const DESKTOP_AUTHORIZE_RUN_CLEAR_TIMEOUT_MS = 2000;
