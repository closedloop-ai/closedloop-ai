/**
 * Sub-second-precision duration for one attempt in a retry trail — the desktop
 * audit cascade and the routines run drawer render the same row shape and had
 * each declared this privately.
 *
 * Deliberately NOT `formatDurationMs`, and the difference is the point: that one
 * rolls up into `Xm Ys` past a minute, which is the right reading for a session
 * that ran for an hour. An attempt trail is a column of values that are compared
 * against each other, so a single unit keeps them scannable — and an attempt
 * slow enough to leave the second range is itself the signal, which a `2m 5s`
 * would round away. It also takes a plain `number`, because an attempt that
 * exists always has a measured duration; there is no null case to spell.
 */
export function formatAttemptDurationMs(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}
