/**
 * Launch-failure cleanup: driving a Loop row to a terminal status after a
 * launch could not be delivered.
 *
 * Extracted from `loop-orchestrator.ts` (ISS-5708) — these are the failure-path
 * writes, not the launch path, and the orchestrator is a shrink-only file.
 * Keeping `failLoopWithError` here too keeps the fallback next to the primitive
 * it falls back onto, so neither can drift from the other's terminal-status
 * rules.
 *
 * ISS-5711 changed WHAT gets written: a failed launch is now recorded as
 * FAILED with a LAUNCH_FAILED error, not as a user cancellation. The
 * durability guarantee ISS-5708 added is preserved — if the terminal write
 * cannot be made, that is said out loud rather than assumed.
 */

import { LoopErrorCode, LoopStatus } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { isInvalidStatusTransitionError } from "@/app/loops/loop-errors";
import { loopsService } from "@/app/loops/service";
import { TERMINAL_LOOP_STATUSES } from "@/app/loops/validators";

/**
 * User-facing message persisted on a loop whose dispatch threw before the
 * runner was ever reachable. Deliberately a fixed constant rather than the
 * caught error's text: the raw launch error is already captured in full on the
 * `loop.launch_failed` log line (with the triggering `commandId` for the trace
 * pivot), while this string is durably persisted on the loop row and rendered
 * in-product, so it must not carry unscrubbed error text that could include a
 * token or other secret.
 *
 * Kept generic across everything `launchLoop`'s try block can throw — credential
 * resolution, run-context construction, the runner-token pin, and the dispatch
 * itself — rather than naming the compute-target handoff, which is only one of
 * those failure modes.
 */
const LAUNCH_FAILURE_MESSAGE =
  "The run failed while being prepared and never started.";

/**
 * Transition a loop to FAILED status and append an error event.
 * Silently swallows InvalidStatusTransition errors only when the loop is
 * already in a terminal status (COMPLETED, FAILED, CANCELLED, TIMED_OUT) --
 * indicating a benign race condition where another handler finished first.
 * If the source status is NOT terminal (e.g. PENDING), the transition failure
 * is a real validation issue and is re-thrown so it surfaces to the caller.
 * The event is only persisted after the status transition succeeds.
 *
 * `options.neverStarted` marks a failure that happened before the runner was
 * ever reachable. `loopsService.updateStatus` otherwise backfills `startedAt`
 * on every terminal transition (for runs whose "started" event was lost), which
 * for a pre-start failure fabricates a start time the loop detail surface
 * renders as a "Started" timestamp and a duration -- contradicting the error
 * copy that says the run never began (ISS-5711).
 */
export async function failLoopWithError(
  loopId: string,
  organizationId: string,
  code: LoopErrorCode,
  message: string,
  timestamp: string,
  options?: { neverStarted?: boolean }
): Promise<void> {
  try {
    await loopsService.updateStatus(loopId, organizationId, LoopStatus.Failed, {
      error: { code, message },
      completedAt: new Date(),
      ...(options?.neverStarted ? { startedAt: null } : {}),
    });
  } catch (err) {
    if (isInvalidStatusTransitionError(err)) {
      if (TERMINAL_LOOP_STATUSES.has(err.from)) {
        // Race: another handler already drove the loop to a terminal state.
        // This is a benign race condition -- swallow silently.
        log.info("loop.fail_already_terminal", {
          loopId,
          from: err.from,
          detail:
            "failLoopWithError: loop already terminal, skipping transition",
        });
        return;
      }
      // Non-terminal source status (e.g. PENDING): this indicates a real
      // transition validation issue, not a race. Re-throw so the caller
      // sees the failure.
      log.error("loop.fail_invalid_transition", {
        loopId,
        from: err.from,
        to: LoopStatus.Failed,
        detail:
          "failLoopWithError: unexpected invalid transition from non-terminal status",
      });
      throw err;
    }
    throw err;
  }

  await loopsService.addEvent(loopId, organizationId, {
    type: "error",
    data: { code, message, timestamp },
  });
}

/**
 * Record a launch failure as the failure it is.
 *
 * Before ISS-5711 this called `loopsService.cancel`, which wrote
 * `LoopStatus.Cancelled` with no error column and no error event — so the
 * durable record claimed the user had cancelled their own run, the status
 * badge rendered a non-error state, and the `ghost-loop-ux` recovery
 * affordance (gated on `LoopStatus.Failed`) never offered a way out.
 *
 * `failLoopWithError` re-throws when the loop's source status is non-terminal,
 * but this runs inside `launchLoop`'s catch block, which re-throws the ORIGINAL
 * launch error immediately afterwards. Swallowing here preserves the existing
 * caller-visible semantics exactly: bookkeeping never masks the launch error
 * that callers (and `classifyLaunchFailure`) actually classify on.
 */
export async function failLoopAfterLaunchFailure(
  loopId: string,
  organizationId: string
): Promise<void> {
  try {
    await failLoopWithError(
      loopId,
      organizationId,
      LoopErrorCode.LaunchFailed,
      LAUNCH_FAILURE_MESSAGE,
      new Date().toISOString(),
      // Dispatch threw before the runner was reachable, so the run provably
      // never started: keep `startedAt` null rather than let the terminal
      // backfill invent one.
      { neverStarted: true }
    );
    return;
  } catch (failError) {
    // `failLoopWithError` already swallows the benign terminal-status race, so
    // an InvalidStatusTransitionError reaching here means the loop was in a
    // NON-terminal status the state machine refuses to fail from — a real
    // validation problem, not a race.
    if (isInvalidStatusTransitionError(failError)) {
      log.error("loop.fail_after_launch_failure_invalid_transition", {
        loopId,
        from: failError.from,
        detail:
          "Launch failed but the loop could not be transitioned to FAILED from a non-terminal status",
      });
    } else {
      log.error("loop.fail_after_launch_failure_failed", {
        loopId,
        failError,
      });
    }
  }

  await reportIfStillActive(loopId, organizationId);
}

/**
 * ISS-5708 durability check, retained through the ISS-5711 change of verb.
 *
 * Callers of `launchLoop` answer the browser on the strength of the launch
 * failure being durable server-side. When the terminal write above did not
 * land, that claim is false — the row keeps holding the (artifactId, command)
 * index slot with active tokens and blocks the user's retry. Re-read before
 * saying so: the write can fail for reasons that have nothing to do with the
 * row's state (a transient DB error on a row another handler already
 * terminalised), and reporting that row as stuck would be wrong.
 *
 * The row is then left for `reapStalePendingLoops`, and
 * `loop.launch_failure_not_durable` says so explicitly rather than letting the
 * caller's assumption stand unchallenged.
 */
async function reportIfStillActive(
  loopId: string,
  organizationId: string
): Promise<void> {
  try {
    const current = await loopsService.findById(loopId, organizationId);
    if (!current || TERMINAL_LOOP_STATUSES.has(current.status)) {
      return;
    }
    log.error("loop.launch_failure_not_durable", {
      loopId,
      status: current.status,
      detail:
        "Launch failed and the FAILED write did not land. The row may still be PENDING/CLAIMED with active tokens until reapStalePendingLoops clears it.",
    });
  } catch (probeError) {
    log.error("loop.launch_failure_not_durable", {
      loopId,
      probeError,
      detail:
        "Launch failed, the FAILED write did not land, and the follow-up status probe also failed.",
    });
  }
}
