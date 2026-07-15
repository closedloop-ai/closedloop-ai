export type LoopCompletedNotificationOptions = {
  title: string;
  body: string;
  actions?: Array<{ type: "button"; text: string }>;
};

export type LoopCompletedNotification = {
  on(event: "action", listener: (_event: unknown, index: number) => void): void;
  on(event: "click", listener: () => void): void;
  show(): void;
};

/**
 * Minimal description of a loop that just reached a terminal success state,
 * carried from the finalizer (live-exit path) to the notifier so it can build
 * a user-facing OS notification without depending on the full LocalJob shape.
 */
export type LoopCompletedNotice = {
  loopId: string;
  command: string;
  /** Human-friendly artifact slug from the loop request, when present. */
  artifactSlug?: string;
};

type LoopCompletedNotifierOptions = {
  createNotification: (
    options: LoopCompletedNotificationOptions
  ) => LoopCompletedNotification;
  supportsActions: () => boolean;
  /** Re-engagement action: bring the user back to the app for the loop. */
  onViewLoop: (notice: LoopCompletedNotice) => void;
  log?: (message: string) => void;
};

const VIEW_LOOP_ACTION_TEXT = "View loop";

/**
 * Fires one Desktop OS notification when a loop reaches terminal success,
 * reusing the same `createNotification` + `supportsActions` wiring as
 * {@link PendingCommandKeyNotifier}. Unlike the in-app status badge, an OS
 * notification reaches a user whose app is unfocused — the strongest
 * re-engagement channel for the "your agent finished" moment.
 *
 * Notifications are deduped per loop id for the lifetime of the process so a
 * replayed or double finalization never double-notifies.
 */
export class LoopCompletedNotifier {
  private readonly options: LoopCompletedNotifierOptions;
  private readonly notifiedLoopIds = new Set<string>();

  constructor(options: LoopCompletedNotifierOptions) {
    this.options = options;
  }

  notifyCompleted(notice: LoopCompletedNotice): void {
    const loopId = notice.loopId.trim();
    if (!loopId) {
      return;
    }
    if (this.notifiedLoopIds.has(loopId)) {
      return;
    }
    this.notifiedLoopIds.add(loopId);

    const supportsActions = this.options.supportsActions();
    const notification = this.options.createNotification({
      title: "Loop complete",
      body: describeCompletedLoop(notice),
      // The "View loop" action button only renders on platforms whose native
      // notifications support action buttons (macOS today), mirroring the
      // command-key notifier's `supportsActions()` gate.
      ...(supportsActions
        ? {
            actions: [{ type: "button" as const, text: VIEW_LOOP_ACTION_TEXT }],
          }
        : {}),
    });

    let actionInvoked = false;
    notification.on("click", () => {
      // On macOS an action-button press also emits a `click`; swallow the
      // paired click so the body and the button do not both fire onViewLoop.
      if (actionInvoked) {
        actionInvoked = false;
        return;
      }
      this.handleViewLoop(notice);
    });
    if (supportsActions) {
      notification.on("action", () => {
        actionInvoked = true;
        this.handleViewLoop(notice);
      });
    }
    notification.show();
  }

  private handleViewLoop(notice: LoopCompletedNotice): void {
    try {
      this.options.onViewLoop(notice);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "view loop action failed";
      this.options.log?.(
        `Loop completed notification action failed: ${message}`
      );
    }
  }
}

function describeCompletedLoop(notice: LoopCompletedNotice): string {
  const label = notice.artifactSlug?.trim();
  return label ? `${label} finished running.` : "Your agent finished running.";
}
