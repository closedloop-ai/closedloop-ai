// The renderer's local-preference seam.
//
// Renderer-only view preferences (sidebar expanded, import splash collapsed)
// live in `localStorage` under a `closedloop.desktop.*` key. They have no
// main-process consumer, and storage being unavailable — disabled, quota-denied,
// or absent under SSR/test — must degrade to the caller's default rather than
// break the surface that reads it.
//
// ISS-5258: extracted from `App.tsx`'s `readDesktopSidebarOpen` /
// `writeDesktopSidebarOpen` once a second preference needed the same guards, so
// the try/catch shape exists once instead of per call site.

const TRUE_VALUE = "true";
const FALSE_VALUE = "false";

/**
 * Read a boolean preference. A missing, corrupt, or unreadable value resolves
 * to `fallback` — only the exact `"true"`/`"false"` sentinels are honored.
 */
export function readRendererBooleanPreference(
  key: string,
  fallback: boolean
): boolean {
  if (globalThis.window === undefined) {
    return fallback;
  }
  try {
    const stored = globalThis.window.localStorage.getItem(key);
    if (stored === TRUE_VALUE) {
      return true;
    }
    if (stored === FALSE_VALUE) {
      return false;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * Persist a boolean preference. Callers update React state first, so a write
 * failure still applies the choice for the current session.
 */
export function writeRendererBooleanPreference(
  key: string,
  value: boolean
): void {
  if (globalThis.window === undefined) {
    return;
  }
  try {
    globalThis.window.localStorage.setItem(
      key,
      value ? TRUE_VALUE : FALSE_VALUE
    );
  } catch {
    // Storage can be disabled or quota-denied; the in-memory UI state wins.
  }
}
