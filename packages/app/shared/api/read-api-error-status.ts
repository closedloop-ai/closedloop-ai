import { ApiError } from "./api-error";

/**
 * The HTTP status a failed read actually received, or null when none arrived.
 *
 * A client-side deadline (`isTimeout`) is null rather than the error's nominal
 * status: no answer was received, and reporting one would say something about a
 * server exchange that never happened. A status outside the real response range
 * is likewise absent — forwarding it would have a telemetry contract reject the
 * whole record.
 *
 * ISS-9725: shared by the desktop dead-end classifiers and the web Branches
 * monitor. It was file-private to the desktop Sessions hook while that was the
 * only caller; with a second runtime reporting the same reads, a copy is how the
 * SAME Cloud 401/403 starts meaning two different things depending on which
 * shell the reader happened to be in.
 */
export function readApiErrorStatus(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.isTimeout()) {
    return null;
  }
  return Number.isInteger(error.status) &&
    error.status >= 100 &&
    error.status <= 599
    ? error.status
    : null;
}
