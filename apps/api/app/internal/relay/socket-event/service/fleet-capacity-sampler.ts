import { RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS } from "@repo/api/src/types/relay-heartbeat";
import { log } from "@repo/observability/log";
import { computeTargetsService } from "@/app/compute-targets/service";
import { isRecord } from "@/lib/type-guards";
import { withTimeout } from "@/lib/with-timeout";
import {
  readMaxInFlightCommands,
  releaseQueuedCommands,
} from "./command-drain";
import { emitFleetCapacityMetrics } from "./hello-handler";

const PRESENCE_FLEET_CAPACITY_TIMEOUT_MS = 5000;

// Room for clock jitter between two consecutive heartbeats, so a heartbeat that
// arrives fractionally early is still sampled.
const FLEET_CAPACITY_SAMPLE_INTERVAL_MARGIN_MS = 5000;

// Derived from the cadence that drives it, not re-declared: every heartbeat must
// clear this gate, while the desktop's own presence — which `onQueueStatsChange`
// fires per queue mutation and never debounces — collapses into it.
const FLEET_CAPACITY_MIN_SAMPLE_INTERVAL_MS =
  RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS -
  FLEET_CAPACITY_SAMPLE_INTERVAL_MARGIN_MS;

export const FLEET_CAPACITY_TRACKED_TARGET_CAP = 1000;

// A read that never settles cannot be cancelled, so the latch below has to
// expire on its own. Without an expiry, one half-open socket — what a Postgres
// failover leaves behind, with no RST to settle the read — silences that
// target's gauges for the life of the process, which is the blackout this
// sampler exists to end. Four windows keeps a stalled read from stacking one
// more read per heartbeat while bounding the silence it can buy.
export const FLEET_CAPACITY_LATCH_TTL_MS =
  FLEET_CAPACITY_MIN_SAMPLE_INTERVAL_MS * 4;

const lastFleetCapacitySampleAt = new Map<string, number>();
const inFlightFleetCapacitySamples = new Map<string, number>();

/**
 * Claims a slot in a bounded `key -> claimedAt` map, refusing while `key` still
 * holds a claim younger than `windowMs`.
 *
 * Both maps are keyed by target id, which is external input, so both need the
 * same bound: sweep claims older than the window once at the cap, and refuse
 * outright when that frees nothing.
 */
function claimBoundedSlot(
  slots: Map<string, number>,
  key: string,
  now: number,
  windowMs: number
): boolean {
  const claimedAt = slots.get(key);
  if (claimedAt !== undefined && now - claimedAt < windowMs) {
    return false;
  }
  if (slots.size >= FLEET_CAPACITY_TRACKED_TARGET_CAP) {
    for (const [id, at] of slots) {
      if (now - at >= windowMs) {
        slots.delete(id);
      }
    }
    // The sweep frees nothing when every tracked key was claimed inside the
    // current window, which a reconnect burst produces. Dropping the claim is
    // what keeps the map bounded. The heartbeat and this window are both fixed
    // intervals, so their phase offset never drifts: a phase-locked fleet held
    // at the cap can land the same target in the shadow on every heartbeat
    // rather than only once. That needs the cap in tracked targets to be
    // reached, which today's fleet is far below.
    if (slots.size >= FLEET_CAPACITY_TRACKED_TARGET_CAP) {
      return false;
    }
  }
  slots.set(key, now);
  return true;
}

/**
 * Whether this sample still holds the latch it claimed.
 *
 * The latch expires, so a stalled read can outlive its claim: a newer sample
 * takes the latch, publishes the current occupancy, and then this one resumes
 * and republishes the occupancy it captured a latch-window ago. That overwrite
 * is always toward the older number, which on a filling executor is the LOWER
 * one — the direction that hides saturation. The claim timestamp doubles as the
 * per-target generation, so a sample that lost it has been superseded.
 *
 * Called at EVERY await boundary on the sampling path, not just the first.
 * There are three reads — `findById` here, then two `countCommandsForTarget`
 * inside the emit — and any of them can stall past the TTL, so one check before
 * the emit would leave the two likelier stalls unguarded.
 */
function claimStillHeld(targetId: string, claimedAt: number): boolean {
  if (inFlightFleetCapacitySamples.get(targetId) === claimedAt) {
    return true;
  }
  log.warn("fleet.capacity_metrics.sample_superseded", {
    computeTargetId: targetId,
    claimedAt,
  });
  return false;
}

async function sampleFleetCapacity(
  targetId: string,
  activeCommands: unknown,
  claimedAt: number
): Promise<boolean> {
  const target = await computeTargetsService.findById(targetId);

  // Early exit only: the emit re-checks for itself, so cutting this costs two
  // pointless reads rather than correctness.
  if (!claimStillHeld(targetId, claimedAt)) {
    return false;
  }

  const capabilities = target?.capabilities;
  const queuedCount = await emitFleetCapacityMetrics({
    targetId,
    isCurrentSample: () => claimStillHeld(targetId, claimedAt),
    ...(activeCommands === undefined ? {} : { activeCommands }),
    maxInFlightCommands:
      isRecord(capabilities) &&
      typeof capabilities.maxInFlightCommands === "number"
        ? capabilities.maxInFlightCommands
        : undefined,
    // Presence is the first path that can sample a target with no row — hello
    // resolves or creates one first — so without this the two causes of a
    // missing capability report the same reason: a desktop too old to send one,
    // and a target deleted while its desktop kept heartbeating.
    targetFound: target !== null,
  });

  // ISS-8686: the drain's other three triggers — reconnect, a terminal event,
  // and a refused ack — are all downstream of an already-delivered command, so
  // a target sitting at `in_flight = 0` with a backlog produces none of them and
  // never drains. Presence is the one signal a connected desktop keeps sending
  // regardless of command state, which is why the wake belongs here: ISS-8634
  // measured 713 of these samples across the 100-minute ISS-8453 incident with
  // no gap over 45s, so this path was live the whole time the queue grew 6->8
  // against an idle executor. Only the call was missing.
  //
  // The heartbeat cadence IS the retry interval — no second one is declared —
  // and the interval gate above already bounds it. Gated on a depth this sample
  // ALREADY read, so an idle fleet pays nothing: presence fires ~27k times a day
  // in production, and an ungated wake would spend three queries on every one.
  //
  // Both other conditions are the same economy. A target row this sample could
  // not find, and one whose desktop declares no ceiling, are the two cases
  // `releaseQueuedCommands` answers with 0 AFTER re-reading the row — and both
  // are PERMANENT for as long as that desktop keeps heartbeating, so without
  // them a version-skewed client buys a wasted read every 30s forever.
  return (
    queuedCount !== undefined &&
    queuedCount > 0 &&
    target !== null &&
    readMaxInFlightCommands(capabilities) !== undefined
  );
}

// Presence is the one event a connected worker keeps sending, so it is the only
// fleet-capacity sampling that survives a long stable connection. Rate-limited,
// bounded and non-rejecting on purpose: presence doubles as the heartbeat, so a
// stalled read must not start a fresh unbounded attempt on every probe, nor
// surface as a rejection.
export async function emitPresenceFleetCapacityMetrics(
  targetId: string,
  activeCommands?: unknown
): Promise<void> {
  const now = Date.now();
  if (
    !claimBoundedSlot(
      lastFleetCapacitySampleAt,
      targetId,
      now,
      FLEET_CAPACITY_MIN_SAMPLE_INTERVAL_MS
    )
  ) {
    return;
  }
  // `withTimeout` stops the wrapper waiting; it cannot cancel the read behind
  // it. Without this latch a hung findById would let the next heartbeat past the
  // interval gate and leave a second read behind, once per heartbeat.
  if (
    !claimBoundedSlot(
      inFlightFleetCapacitySamples,
      targetId,
      now,
      FLEET_CAPACITY_LATCH_TTL_MS
    )
  ) {
    return;
  }
  // What makes `now` usable as this sample's identity is the INTERVAL gate
  // above, not the latch: `inFlightFleetCapacitySamples` is deleted on
  // completion, so its next claim succeeds immediately regardless of TTL.
  // `lastFleetCapacitySampleAt` is never deleted on completion, and refuses any
  // claim inside its window — so two successful claims for one target are
  // always >= FLEET_CAPACITY_MIN_SAMPLE_INTERVAL_MS apart and can never share a
  // timestamp. A coarse or backwards clock is refused by that same comparison
  // rather than admitted with an equal one. The latch does contribute the
  // narrower half — while its entry exists, a same-millisecond claim is refused
  // too — so the interval gate is what extends that to samples whose
  // predecessor already completed.
  const settled = sampleFleetCapacity(targetId, activeCommands, now).finally(
    () => {
      // Ownership-scoped: an unconditional delete would let a superseded sample
      // release the latch of the newer one that replaced it, re-opening the
      // duplicate-read leak the latch exists to close.
      if (inFlightFleetCapacitySamples.get(targetId) === now) {
        inFlightFleetCapacitySamples.delete(targetId);
      }
    }
  );
  let shouldDrain = false;
  try {
    shouldDrain = await withTimeout(
      settled,
      PRESENCE_FLEET_CAPACITY_TIMEOUT_MS,
      "presenceFleetCapacityMetrics"
    );
  } catch (error) {
    log.warn("fleet.capacity_metrics.presence_failed", {
      computeTargetId: targetId,
      error,
    });
  }

  // Awaited here rather than handed to `waitUntil`, because this whole function
  // is ALREADY the promise `handlePresence` registered — a second, nested
  // registration made three awaited reads after the response was returned is a
  // late one, and a runtime that snapshots its pending set at handler return
  // would drop it. That failure is invisible: the drain simply never runs.
  //
  // Outside the timeout above on purpose. That deadline bounds how long the
  // GAUGES wait, and reusing it here would report a slow relay as a failed
  // sample; the drain carries its own per-dispatch timeout.
  if (shouldDrain) {
    await releaseQueuedCommands(targetId).catch((error) => {
      log.warn("command.drain.failed", {
        computeTargetId: targetId,
        error,
      });
    });
  }
}

/**
 * Clears both bounded maps. A case that leaves a read hung would otherwise latch
 * its target for every later case in the file, and a case that fills the
 * interval map to the cap would drop every later case's first sample.
 */
export function resetFleetCapacitySamplerForTests(): void {
  lastFleetCapacitySampleAt.clear();
  inFlightFleetCapacitySamples.clear();
}
