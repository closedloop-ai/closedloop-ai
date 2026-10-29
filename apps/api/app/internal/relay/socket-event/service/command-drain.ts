import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import {
  dispatchRelayCommandToRelay,
  toRelayOperation,
} from "@/app/compute-targets/relay-command-helpers";
import { computeTargetsService } from "@/app/compute-targets/service";
import {
  acquireCommandDrainLease,
  countInFlightCommandsForDispatch,
  listQueuedCommandsForDispatch,
  releaseCommandDrainLease,
  renewCommandDrainLease,
} from "@/lib/desktop-command-dispatch-queries";
import type { DispatchableCommand } from "@/lib/desktop-command-mappers";
import { MAX_IN_FLIGHT_COMMANDS_CEILING } from "@/lib/desktop-gateway-types";
import { isRecord } from "@/lib/type-guards";

/**
 * The one normalization of a declared ceiling, shared by the hello cap and the
 * drain so the two cannot disagree about the same number.
 *
 * Absence means "no ceiling stated" and leaves a target unthrottled — an older
 * desktop that never reported one must not have its queue frozen by a limit it
 * never asked for. A stated-but-unusable value is NOT absence: it is floored to
 * 1, which is exactly what the desktop's own scheduler does with it
 * (`cloud-command-executor.ts`, `Math.max(1, maxInFlightCommands)`). Reading it
 * as absence here while hello floored it left a target throttled by hello and
 * un-drainable forever, which is a stall, not a ceiling.
 *
 * `executor_saturation` deliberately does NOT share this: a metric divides by
 * the ceiling, so flooring an unusable value there would publish a confident
 * wrong ratio. Skipping is right for a measurement, flooring for a limit.
 *
 * The value is also capped at `MAX_IN_FLIGHT_COMMANDS_CEILING`, because the
 * declared number becomes `free` below, then the `take` of the queue read, then
 * the width of the `Promise.all` that opens one outbound relay POST per row.
 *
 * EVERY finite declaration is clamped into that window, including one whose
 * magnitude is past the safe-integer range (`1e20`). Such a value used to return
 * absence, and absence here means unthrottled — so the one input furthest out of
 * range bought the caller the whole backlog and the fan-out this cap exists to
 * stop. Only a non-number or a non-finite one is absence.
 *
 * Any adjustment — the floor as well as the ceiling — is reported through
 * `onClamped` rather than logged here, because this runs on every terminal
 * command event while only a hello carries a fresh declaration. The relay lane
 * passes a sink; the drain deliberately does not, since it re-reads a value
 * already bounded at hello.
 */
export function normalizeMaxInFlightCommands(
  value: unknown,
  onClamped?: (clamp: { declared: number; applied: number }) => void
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const floored = Math.floor(value);
  const applied = Math.min(
    MAX_IN_FLIGHT_COMMANDS_CEILING,
    Math.max(1, floored)
  );
  if (applied !== floored) {
    onClamped?.({ declared: floored, applied });
  }
  return applied;
}

/** The ceiling a target declared on its last hello, as persisted on the row. */
export function readMaxInFlightCommands(
  capabilities: unknown
): number | undefined {
  if (!isRecord(capabilities)) {
    return undefined;
  }
  return normalizeMaxInFlightCommands(capabilities.maxInFlightCommands);
}

/**
 * How long one release may hold a target's lease before the lease expires.
 *
 * Sized to the work it covers, not to a round number: a release opens up to
 * `ceiling` concurrent relay POSTs, each bounded by the dispatch helper's 5s
 * fetch timeout. The holder is a serverless invocation that
 * can vanish mid-drain, so the ceiling on how long a crashed one can block the
 * next legitimate trigger is this constant and nothing else — short enough that
 * a lost holder costs at most one presence heartbeat, long enough that a slow
 * relay is not mistaken for a dead instance.
 *
 * IT IS DELIBERATELY SHORTER THAN THE READS THAT PRECEDE THAT FAN-OUT, and that
 * is safe only because of the renewal in `releaseQueuedCommands` (whitlockk, PR
 * #7119). Each read takes a pooled connection, and a wait for one is bounded by
 * `DB_POOL_ACQUIRE_TIMEOUT_MS` at 30s — per acquisition, so a stalled pool can
 * put 60s of reading inside a 15s window. Sizing this constant past that worst
 * case instead would let a crashed holder block its target for a minute and a
 * half; re-asserting ownership after the reads keeps the recovery bound at one
 * TTL and still refuses the second dispatcher.
 */
export const COMMAND_DRAIN_LEASE_TTL_MS = 15_000;

/**
 * Releases queued commands up to the target's declared ceiling.
 *
 * This is the half that makes throttling the reconnect flush safe. Nothing else
 * in the cloud re-dispatches a queued command: `POST /compute-targets/:id/commands`
 * attempts delivery once and leaves the row `queued` on `delivered:false`, with
 * no retry. So before this existed, a command held back was a command stranded
 * until the next reconnect — which is why capping the flush alone would have
 * traded a burst for a stall.
 *
 * Re-dispatching a command the desktop already holds is safe: its executor keys
 * on `commandId` and re-acks a duplicate instead of running it twice.
 *
 * ISS-8896: THE CEILING IS FLEET-WIDE, so the gate that protects it has to be
 * too. Everything below the lease is a read-modify-write — count what is in
 * flight, dispatch the difference — and the only thing serializing it was a
 * process-local map in `fleet-capacity-sampler.ts`. With more than one API
 * instance each held its own copy, so N instances read the same `inFlight` and
 * each dispatched a full `ceiling - inFlight`, putting N x ceiling commands on a
 * desktop that declared one. The lease is taken here rather than at the idle
 * drain's call site because all four triggers — presence, reconnect, a terminal
 * event, a refused ack — run the same race through this one function; guarding
 * the caller that happened to surface it would leave the other three broken.
 *
 * Refusing is the correct outcome, not a dropped drain: another instance is
 * dispatching against this target's ceiling right now, and whatever it cannot
 * fit stays queued for the next trigger exactly as it does when the ceiling is
 * already full.
 */
export async function releaseQueuedCommands(targetId: string): Promise<number> {
  const target = await computeTargetsService.findById(targetId);
  const ceiling = readMaxInFlightCommands(target?.capabilities);
  if (ceiling === undefined) {
    return 0;
  }

  // After the ceiling check, so a version-skewed desktop that declares none
  // never pays for a lease it could not use.
  let heldUntil = await acquireCommandDrainLease(
    targetId,
    COMMAND_DRAIN_LEASE_TTL_MS
  );
  if (heldUntil === null) {
    log.info("command.drain.lease_held", { computeTargetId: targetId });
    return 0;
  }

  try {
    const batch = await readDispatchBatch(targetId, ceiling);
    if (batch === null) {
      return 0;
    }

    // The reads above can outlast the lease — see COMMAND_DRAIN_LEASE_TTL_MS —
    // so ownership is re-asserted before anything is dispatched. A holder whose
    // reads outran its window is refused here instead of fanning out alongside
    // the instance that legitimately claimed the target while it waited, and
    // whatever it was going to send stays queued for the next trigger exactly
    // as it does when the ceiling is already full.
    const renewed = await renewCommandDrainLease(
      targetId,
      heldUntil,
      COMMAND_DRAIN_LEASE_TTL_MS
    );
    if (renewed === null) {
      log.info("command.drain.lease_lost", { computeTargetId: targetId });
      return 0;
    }
    heldUntil = renewed;

    return await dispatchBatch(targetId, ceiling, batch);
  } finally {
    // Best-effort and outside the dispatch's failure domain: the lease expires
    // on its own, so a failed hand-back costs one TTL, never a thrown drain.
    await releaseCommandDrainLease(targetId, heldUntil).catch((error) => {
      log.warn("command.drain.lease_release_failed", {
        computeTargetId: targetId,
        error,
      });
    });
  }
}

/** What one release decided to send, or null when it has nothing to send. */
type DispatchBatch = {
  inFlight: number;
  queued: DispatchableCommand[];
};

/** The read half of the read-modify-write the lease exists to serialize. */
async function readDispatchBatch(
  targetId: string,
  ceiling: number
): Promise<DispatchBatch | null> {
  const inFlight = await countInFlightCommandsForDispatch(targetId);
  const free = ceiling - inFlight;
  if (free <= 0) {
    return null;
  }

  const queued = await listQueuedCommandsForDispatch(targetId, free);
  if (queued.length === 0) {
    return null;
  }
  return { inFlight, queued };
}

/** The write half, which only ever runs on a lease just re-asserted. */
async function dispatchBatch(
  targetId: string,
  ceiling: number,
  batch: DispatchBatch
): Promise<number> {
  const results = await Promise.all(
    batch.queued.map((command) => dispatchQueuedCommand(targetId, command))
  );
  const delivered = results.filter(Boolean).length;

  log.info("command.drain.released", {
    computeTargetId: targetId,
    ceiling,
    inFlight: batch.inFlight,
    attempted: batch.queued.length,
    delivered,
  });
  return delivered;
}

/**
 * A queued command carries no signature, so none is reconstructed here: the
 * create route expires a signed command it could not deliver rather than
 * leaving it queued, so a signed command never reaches this path.
 */
async function dispatchQueuedCommand(
  targetId: string,
  command: DispatchableCommand
): Promise<boolean> {
  try {
    const result = await dispatchRelayCommandToRelay({
      targetId,
      commandId: command.commandId,
      relayOperation: toRelayOperation(command.commandId, {
        operationId: command.operationId,
        method: command.method,
        path: command.path,
        headers: command.headers,
        query: command.query,
        body: command.body,
        timeoutMs: command.timeoutMs,
        lockKey: command.lockKey,
        requiresApproval: command.requiresApproval,
        approvalReason: command.approvalReason,
        streaming: command.streaming,
      }),
    });
    return result.delivered;
  } catch (error) {
    // The target going away mid-drain is ordinary, and the command stays queued
    // for the next completion or reconnect either way. Never let it reject the
    // caller: this runs off a command ack, which must still answer the desktop.
    log.warn("command.drain.dispatch_failed", {
      computeTargetId: targetId,
      commandId: command.commandId,
      error,
    });
    return false;
  }
}

/**
 * Fire-and-forget wrapper for the ack/event paths, which must answer the desktop
 * without waiting on a drain. Mirrors `scheduleGitHubDirtyScopeRecoveryDrain`.
 */
export function scheduleQueuedCommandRelease(targetId: string): void {
  waitUntil(
    releaseQueuedCommands(targetId).catch((error) => {
      log.warn("command.drain.failed", {
        computeTargetId: targetId,
        error,
      });
    })
  );
}
