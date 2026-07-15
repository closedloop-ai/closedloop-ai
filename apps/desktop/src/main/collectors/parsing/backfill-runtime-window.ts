/**
 * @file backfill-runtime-window.ts
 * @description The minimal renderer-window surface a backfill runtime boundary
 * uses to push a `desktop:db:changed` invalidation after re-deriving
 * session-projected rows. One definition shared by every backfill kind
 * (artifact-link, activity-segment, …) so the channel/payload contract has a
 * single source of truth. Intentionally dependency-free so the boundary modules
 * do not pull the transcript-enumeration graph in just for a type.
 */
export type DbChangedWindow = {
  webContents: {
    isDestroyed: () => boolean;
    send: (
      channel: "desktop:db:changed",
      payload: Record<string, never>
    ) => void;
  };
};

/**
 * Crash-safe `desktop:db:changed` push shared by the backfill boundaries.
 * Mirrors the guard in `sendToRendererWindow` (renderer-ipc.ts) for this narrow
 * window surface: skips a missing or destroyed window and swallows the "Render
 * frame was disposed before WebFrameMain could be accessed" throw that occurs
 * when the renderer is reaped across sleep/wake while the main process still
 * holds the window. Kept dependency-free (no logger) so the boundary modules
 * stay light; a torn-down renderer is the expected, benign miss.
 */
export function notifyDbChanged(window: DbChangedWindow | null): void {
  if (!window) {
    return;
  }
  try {
    // Read webContents inside the try: a destroyed-but-not-null window can throw
    // "Object has been destroyed" from the native getter before the
    // isDestroyed()/send guards run. DbChangedWindow has no window-level
    // isDestroyed(), so the try is the guard.
    const contents = window.webContents;
    if (contents.isDestroyed()) {
      return;
    }
    contents.send("desktop:db:changed", {});
  } catch {
    // Best-effort cache nudge against a renderer that vanished mid-send.
  }
}
