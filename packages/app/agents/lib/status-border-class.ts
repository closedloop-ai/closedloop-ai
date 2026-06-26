/**
 * Left-border accent class shared by the agent and session cards: warning when
 * the subject is waiting on input, success when it is actively running, and the
 * neutral card border otherwise.
 */
export function statusBorderClass(
  isWaiting: boolean,
  isRunning: boolean
): string {
  if (isWaiting) {
    return "border-l-2 border-l-warning";
  }
  if (isRunning) {
    return "border-l-2 border-l-success";
  }
  return "border-border/80";
}
