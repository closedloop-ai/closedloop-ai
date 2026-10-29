/**
 * How long a helper process or worker thread may sit with no work before its
 * owner tears it down. Operator ruling, 2026-10-05: the app runs in the
 * background on a minimal footprint and consumes resources only while it is
 * doing work; every owner of this timer respawns its helper lazily on the next
 * request.
 */
export const HELPER_IDLE_TEARDOWN_MS = 60_000;

/** A re-armable one-shot timer that runs `onIdle` after a quiet period. */
export type IdleTeardownTimer = {
  /** (Re)start the countdown, replacing any countdown already running. */
  arm(): void;
  /** Stop the countdown, if one is running. */
  cancel(): void;
};

export function createIdleTeardownTimer(
  delayMs: number,
  onIdle: () => void
): IdleTeardownTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return {
    arm() {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        onIdle();
      }, delayMs);
      // An idle countdown must never be the thing keeping the process alive.
      timer.unref?.();
    },
    cancel,
  };
}
