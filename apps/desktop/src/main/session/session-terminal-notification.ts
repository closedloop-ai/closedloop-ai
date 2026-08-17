import { Notification } from "electron";
import { gatewayLog } from "../logging/gateway-logger.js";
import type { DesktopWindow } from "../window.js";

/** The terminal-status notice the DB host hands to the notification lane. */
export type SessionTerminalNotice = {
  sessionId: string;
  status: string;
};

/**
 * Fire a desktop Notification when a live agent session reaches a terminal
 * status, so users running a long session don't have to keep the window
 * focused to learn it finished. Gated on the `sessionCompletionNotifications`
 * flag by the caller; clicking deep-links to the session detail. Best-effort and
 * never throws into the DB-host message pump.
 */
export function notifySessionTerminal(
  desktopWindow: DesktopWindow,
  notice: SessionTerminalNotice
): void {
  try {
    const errored = notice.status === "error";
    const notification = new Notification({
      title: errored ? "Agent session failed" : "Agent session completed",
      body: errored
        ? "Your agent session ended with an error."
        : "Your agent session finished.",
    });
    notification.on("click", () => {
      desktopWindow.show();
      // Org-relative session-detail href; mirrors the renderer route
      // table's sessionDetailHref (/sessions/:id), which the main process
      // can't import. sendToRenderer is best-effort: the click can fire long
      // after notifySessionTerminal returns, against a torn-down renderer.
      desktopWindow.sendToRenderer(
        "desktop:navigate-tab",
        `/sessions/${encodeURIComponent(notice.sessionId)}`
      );
    });
    notification.show();
  } catch (error) {
    gatewayLog.warn(
      "session-completion-notification",
      error instanceof Error ? error.message : String(error)
    );
  }
}
