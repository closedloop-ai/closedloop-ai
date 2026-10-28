import {
  deriveListEmptyReason,
  ListEmptyReason,
  type ListEmptyStateSignals,
} from "@repo/api/src/list-empty-state";
import {
  resolveSessionDetailAbsence,
  SessionDetailAbsence,
} from "@repo/app/agents/components/detail/agent-session-detail-absence";
import type { SessionDetailErrorKind } from "@repo/app/agents/components/detail/agent-session-detail-states";
import type { LoadingStallPhase } from "@repo/app/shared/lib/loading-stall-phase";
import {
  DeadEndFlowReason,
  DeadEndFlowState,
  DeadEndFlowTreatment,
} from "../../../shared/dead-end-telemetry-contract";
import {
  httpStatusFields,
  resolveFailedReadReason,
} from "../../hooks/dead-end-read-failure";
import type { DeadEndCause } from "../../hooks/use-dead-end-telemetry";

/**
 * ISS-7249 — the pure dead-end classifiers for the desktop Sessions list and
 * detail. These decide whether the five no-data states stay five things, so the
 * branch producing each sits in one testable file. `null` means no dead-end
 * treatment is on screen.
 *
 * These follow the render branches of the Sessions list surface and
 * `AgentSessionDetailView`. Where that precedence can be shared it IS shared
 * rather than mirrored: the detail asks `resolveSessionDetailAbsence`, the same
 * resolver the view branches on (review cid 3821325581). The list's own
 * precedence lives in the surface's JSX, and the guard against it drifting from
 * `resolveSessionsListDeadEnd` is behavioural — see
 * `sessions-view-empty-states.test.tsx`, which drives the real `SessionsView`
 * and fails if the classifier and the rendered surface ever disagree.
 *
 * ISS-10301 retired the v1 `SessionsTableBody` these sentences used to name; the
 * classifier and its inputs are unchanged and still read by
 * `use-sessions-dead-end-telemetry.ts`.
 */

/** The signals the Sessions list surface branches on, as its host holds them. */
export type SessionsListDeadEndInputs = {
  isTableLoading: boolean;
  /** Last-good rows to fall back on (`hasData`). */
  hasRenderableData: boolean;
  /** Keep-previous refetch label: a plain spinner, so no treatment is up. */
  hasLoadingLabel: boolean;
  stallPhase: LoadingStallPhase;
  visibleRowCount: number;
  emptySignals: ListEmptyStateSignals;
  /** FEA-4181: source still coming up vs a failed read — the one honest
   * `not_yet_synced` either surface can produce. */
  isSyncing: boolean;
  /**
   * Past the last page a SETTLED total supports, clamp not yet applied.
   * `deriveListEmptyReason` requires hosts to clamp BEFORE classifying: the
   * blank frame is repaired next commit, but a `true_zero` record is not.
   *
   * It must stay false until a successful response established that total
   * (ISS-7249, whitlockk review). A failed initial read leaves the render model on
   * its fallback zero, which clamps every `?page=2+` to page one and made this
   * true — suppressing the very `unavailable` record the failure should have
   * produced. `isSessionsPageOutOfRange` is the shared predicate that carries
   * the settled-total precondition, so the host cannot forget it.
   */
  isPageOutOfRange: boolean;
  /**
   * The failed list read's HTTP status, or null when no response carried one.
   * The list used to discard it and report every Cloud failure as
   * `fetch_failed`, while the DETAIL classified the same 401/403 as
   * `permission_denied` — one failure, two vocabularies, and no way to tell from
   * the data which surface was being honest (whitlockk review).
   */
  httpStatus: number | null;
};

/**
 * A `none`-phase blocking load returns null — a spinner in the first seconds is
 * the product working. A genuinely empty scope IS reported, as `true_zero`: a
 * dead-end rate can only exclude it if it is named.
 */
export function resolveSessionsListDeadEnd(
  inputs: SessionsListDeadEndInputs
): DeadEndCause | null {
  if (inputs.isTableLoading && !inputs.hasRenderableData) {
    return resolveListStallDeadEnd(inputs.stallPhase);
  }
  if (
    inputs.hasLoadingLabel ||
    inputs.isPageOutOfRange ||
    inputs.visibleRowCount > 0
  ) {
    return null;
  }
  return resolveListEmptyDeadEnd(inputs);
}

/** The signals `AgentSessionDetailView` branches on. */
export type SessionDetailDeadEndInputs = {
  isLoading: boolean;
  isError: boolean;
  hasSession: boolean;
  errorKind: SessionDetailErrorKind | undefined;
  /** The failed response's status, or null when none arrived — never 0. */
  httpStatus: number | null;
  stallPhase: LoadingStallPhase;
};

/**
 * The last branch is the interesting one: a settled read with no row and no
 * error — a query paused offline — renders the SAME "Session not found" as a
 * 404 but establishes nothing, so it reports `unknown`/`unclassified` where the
 * 404 reports `true_zero`/`absent`. The detail has no retry affordance, so every
 * cause reports `retryOffered: false`; that is what makes "how often does a user
 * hit a dead end with no way out" answerable.
 */
export function resolveSessionDetailDeadEnd(
  inputs: SessionDetailDeadEndInputs
): DeadEndCause | null {
  if (inputs.hasSession) {
    return null;
  }
  // review cid 3821325581: the branch ORDER is no longer re-derived here. The
  // view and this classifier ask the same resolver what the absence is, so the
  // precedence has one owner and adding an arm to it fails `tsc` in this switch
  // rather than silently classifying a new screen as an old one.
  const absence = resolveSessionDetailAbsence({
    errorKind: inputs.errorKind,
    isError: inputs.isError,
    isLoading: inputs.isLoading,
  });
  switch (absence) {
    case SessionDetailAbsence.Loading:
      return resolveDetailStallDeadEnd(inputs.stallPhase);
    case SessionDetailAbsence.ProviderError:
      return resolveDetailProviderErrorDeadEnd(inputs.httpStatus);
    case SessionDetailAbsence.ErroredAbsent:
      return {
        treatment: DeadEndFlowTreatment.SessionDetailNotFound,
        state: DeadEndFlowState.TrueZero,
        reason: DeadEndFlowReason.Absent,
        retryOffered: false,
        ...httpStatusFields(inputs.httpStatus),
      };
    case SessionDetailAbsence.UnresolvedAbsent:
      // Renders the same "Session not found" card as the arm above, and is a
      // different fact: a query paused offline has established nothing.
      return {
        treatment: DeadEndFlowTreatment.SessionDetailNotFound,
        state: DeadEndFlowState.Unknown,
        reason: DeadEndFlowReason.Unclassified,
        retryOffered: false,
      };
    default:
      // No `default` fallthrough value on purpose: a new absence arm must fail
      // `tsc` here rather than be silently classified as an existing one.
      return assertAbsenceHandled(absence);
  }
}

function resolveListStallDeadEnd(
  stallPhase: LoadingStallPhase
): DeadEndCause | null {
  if (stallPhase === "none") {
    return null;
  }
  // ISS-11204: elapsed time is no longer a failure. A stalled blocking read
  // keeps the loading treatment at every phase, and offers no Retry — Retry
  // belongs to a request that actually failed. So the record says Loading with
  // no retry offered, because that is what the reader is looking at; the old
  // `hard` arm claimed an Unavailable treatment and a Retry that the body has
  // stopped rendering.
  return {
    treatment: DeadEndFlowTreatment.SessionsListStalled,
    state: DeadEndFlowState.Loading,
    reason: DeadEndFlowReason.LoadingThresholdExceeded,
    retryOffered: false,
  };
}

function resolveListEmptyDeadEnd({
  emptySignals,
  httpStatus,
  isSyncing,
}: {
  emptySignals: ListEmptyStateSignals;
  httpStatus: number | null;
  isSyncing: boolean;
}): DeadEndCause {
  const emptyReason = deriveListEmptyReason(emptySignals);
  if (emptyReason === ListEmptyReason.Unavailable) {
    return {
      treatment: DeadEndFlowTreatment.SessionsListUnavailable,
      state: DeadEndFlowState.Unavailable,
      // FEA-4181's `isSyncing` is the source still coming up, which is not
      // the same fact as a read that failed.
      reason: isSyncing
        ? DeadEndFlowReason.NotYetSynced
        : resolveFailedReadReason(httpStatus),
      // review cid 3818119802: the two branches do NOT offer the same way out,
      // so they must not report the same `retryOffered`. Syncing renders
      // `SyncingEmpty`, which is a title, a clock icon, and no action at all —
      // the user has no way out and the attribute has to say so, or the "dead
      // end with no way out" rate this event exists to measure undercounts by
      // exactly these. The failed read renders `ErroredEmpty`, which always
      // carries an action: the host's "Clear filters and reload" recovery Link
      // — that component's own words, "the honest superset action" — or a lone
      // Retry when no Link is wired. A reload IS a retry affordance, so that
      // branch stays true.
      retryOffered: !isSyncing,
      // Carried on the failed-read branch only: a source that has not finished
      // syncing received no response, so a status there would describe a server
      // exchange that never happened.
      ...(isSyncing ? {} : httpStatusFields(httpStatus)),
    };
  }
  if (emptyReason === ListEmptyReason.Filtered) {
    return {
      treatment: DeadEndFlowTreatment.SessionsListEmpty,
      state: DeadEndFlowState.NotApplicable,
      reason: DeadEndFlowReason.FilteredOut,
      retryOffered: false,
    };
  }
  return {
    treatment: DeadEndFlowTreatment.SessionsListEmpty,
    state: DeadEndFlowState.TrueZero,
    reason: DeadEndFlowReason.Absent,
    retryOffered: false,
  };
}

function resolveDetailStallDeadEnd(
  stallPhase: LoadingStallPhase
): DeadEndCause | null {
  if (stallPhase === "none") {
    return null;
  }
  return {
    treatment: DeadEndFlowTreatment.SessionDetailStalled,
    state: DeadEndFlowState.Loading,
    reason: DeadEndFlowReason.LoadingThresholdExceeded,
    retryOffered: false,
  };
}

function resolveDetailProviderErrorDeadEnd(
  httpStatus: number | null
): DeadEndCause {
  return {
    treatment: DeadEndFlowTreatment.SessionDetailUnavailable,
    state: DeadEndFlowState.Unavailable,
    reason: resolveFailedReadReason(httpStatus),
    retryOffered: false,
    ...httpStatusFields(httpStatus),
  };
}

/**
 * Compile-time exhaustiveness for {@link SessionDetailAbsence}. It THROWS rather
 * than returning a fallback cause on purpose: a value that reached here is one
 * the view can render and this classifier has no vocabulary for, and inventing a
 * plausible record for it is the confident wrong number ISS-7249 is about. In
 * practice the `never` parameter means a new arm fails `tsc` first.
 */
function assertAbsenceHandled(absence: never): never {
  throw new Error(`Unhandled session-detail absence: ${String(absence)}`);
}
