import { ListEmptyReason } from "@repo/api/src/list-empty-state";
import {
  BranchesListStateKind,
  type BranchesListStateSignals,
  resolveBranchesListState,
} from "@repo/app/branches/lib/branch-list-state";
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
 * ISS-9725 — the dead-end classifier for the Branches list. `null` means no
 * dead-end treatment is on screen.
 *
 * Unlike the Sessions list classifier, which re-derives the render precedence
 * and needs `sessions-list-render-agreement.test.tsx` to hold the two in step,
 * this one CALLS {@link resolveBranchesListState} — the single resolver both the
 * v1 body and the v2 surface branch on (ISS-9429). So the record cannot describe
 * a screen other than the one rendered, and a new {@link ListEmptyReason} fails
 * `tsc` in the switch below rather than being classified as an existing one. A
 * new `BranchesListStateKind` does NOT — the early return absorbs it, silently,
 * as "no treatment"; that arm is a judgment about whether the new kind is a dead
 * end at all, which is not something a compiler can make.
 */

/** Exactly what the bodies pass the resolver, plus the failed read's status. */
export type BranchesListDeadEndInputs = BranchesListStateSignals & {
  /**
   * The failed list read's HTTP status, or null when no response carried one —
   * never 0. Read through `readApiErrorStatus`, the same conversion Sessions
   * does, so one `ApiError` cannot mean two things across the two lists.
   */
  httpStatus: number | null;
};

export function resolveBranchesListDeadEnd(
  inputs: BranchesListDeadEndInputs
): DeadEndCause | null {
  const { httpStatus, ...signals } = inputs;
  const state = resolveBranchesListState(signals);
  if (state.kind !== BranchesListStateKind.Empty) {
    // Rows are on screen, or the read has not settled. Branches runs no stall
    // detector, so — unlike Sessions, whose `soft`/`hard` phases buy the fifth
    // `why` — an unsettled Branches read reports nothing: a spinner is the
    // product working, and there is no threshold here that established
    // otherwise. Inventing a `loading` record without one would report a
    // duration nothing measured.
    return null;
  }
  switch (state.reason) {
    case ListEmptyReason.Unavailable:
      return {
        treatment: DeadEndFlowTreatment.BranchesListUnavailable,
        state: DeadEndFlowState.Unavailable,
        reason: resolveFailedReadReason(httpStatus),
        // `BranchesEmptyVariant.Unavailable` is the one arm of
        // `BranchesListStateView` that renders a Retry.
        retryOffered: true,
        ...httpStatusFields(httpStatus),
      };
    case ListEmptyReason.Filtered:
      return {
        treatment: DeadEndFlowTreatment.BranchesListEmpty,
        state: DeadEndFlowState.NotApplicable,
        reason: DeadEndFlowReason.FilteredOut,
        retryOffered: false,
      };
    case ListEmptyReason.Empty:
      return {
        treatment: DeadEndFlowTreatment.BranchesListEmpty,
        state: DeadEndFlowState.TrueZero,
        reason: DeadEndFlowReason.Absent,
        retryOffered: false,
      };
    default:
      return assertEmptyReasonHandled(state.reason);
  }
}

/**
 * Compile-time exhaustiveness for {@link ListEmptyReason}. It THROWS rather than
 * returning a fallback cause on purpose: a value that reached here is one the
 * list can render and this classifier has no vocabulary for, and inventing a
 * plausible record for it is the confident wrong number this instrumentation
 * exists to avoid. In practice the `never` parameter means a new reason fails
 * `tsc` first.
 */
function assertEmptyReasonHandled(reason: never): never {
  throw new Error(`Unhandled Branches list empty reason: ${String(reason)}`);
}
