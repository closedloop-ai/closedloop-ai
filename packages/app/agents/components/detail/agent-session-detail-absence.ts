/**
 * @file agent-session-detail-absence.ts
 * @description ISS-7249, review cid 3821325581: the ONE precedence deciding
 * what a session detail shows when it has no session to show.
 *
 * `AgentSessionDetailView` used to encode this order in JSX and the desktop
 * dead-end classifier re-encoded it by hand, with nothing but a comment tying
 * them together — the same design decision in two files, where reordering
 * either one silently misclassifies every record the other produces. Both now
 * branch on this resolver, so the precedence has one home and a new arm fails
 * `tsc` at every consumer instead of drifting.
 *
 * Deliberately lightweight (no component imports) so a classifier can consume it
 * without pulling a render runtime.
 *
 * Four values for three renderings is not an oversight. `ErroredAbsent` and
 * `UnresolvedAbsent` both draw "Session not found", but a settled 404 has
 * ESTABLISHED that the session is gone while a settled read with no error and no
 * row — a query paused offline — has established nothing. Collapsing them is
 * precisely the distinction loss this ticket exists to undo, so the shared
 * vocabulary keeps them apart and lets the render fold them.
 */
import { SessionDetailErrorKind } from "./agent-session-detail-states";

export const SessionDetailAbsence = {
  /** A genuine first load: still pending, no row yet. */
  Loading: "loading",
  /** Settled and errored with a transient provider failure, not a missing row. */
  ProviderError: "provider_error",
  /** Settled and errored with no row: an established absence. */
  ErroredAbsent: "errored_absent",
  /** Settled, NOT errored, still no row. Establishes nothing. */
  UnresolvedAbsent: "unresolved_absent",
} as const;

export type SessionDetailAbsence =
  (typeof SessionDetailAbsence)[keyof typeof SessionDetailAbsence];

export type SessionDetailAbsenceInputs = {
  isLoading: boolean;
  isError: boolean;
  errorKind: SessionDetailErrorKind | undefined;
};

/**
 * Call this ONLY once the caller has established there is no session; the
 * has-a-session gate stays with the caller so the view keeps its type narrowing.
 */
export function resolveSessionDetailAbsence(
  inputs: SessionDetailAbsenceInputs
): SessionDetailAbsence {
  if (inputs.isLoading) {
    return SessionDetailAbsence.Loading;
  }
  if (inputs.isError) {
    return inputs.errorKind === SessionDetailErrorKind.ProviderError
      ? SessionDetailAbsence.ProviderError
      : SessionDetailAbsence.ErroredAbsent;
  }
  return SessionDetailAbsence.UnresolvedAbsent;
}
