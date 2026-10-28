import { RELAY_PRESENCE_SILENCE_MS } from "@repo/api/src/types/relay-heartbeat";
import { log } from "@repo/observability/log";
import { releaseQueuedCommands } from "@/app/internal/relay/socket-event/service/command-drain";
import {
  type IdleDrainCandidate,
  listIdleDrainCandidates,
} from "@/lib/desktop-command-dispatch-queries";

/**
 * ISS-8686, the half the presence heartbeat cannot reach.
 *
 * The presence trigger in `fleet-capacity-sampler.ts` wakes a backlogged target
 * that is still connected. A DISCONNECTED one sends no presence, so its backlog
 * is reachable only by its next reconnect — which may never come. This sweep is
 * the floor under that case.
 *
 * It is deliberately a poor relation of the presence trigger, because a
 * disconnected target's dispatch FAILS BY DEFINITION and burns the relay's
 * `PEER_DISPATCH_TIMEOUT_MS` (4s, `apps/relay/src/proxy-dispatch.ts`) doing it.
 * 50.9% of production dispatches were already failing that way over the 24h to
 * 2026-09-02 (35,510 `target_not_connected` of 69,779 `Relay dispatch result`),
 * so every attempt this sweep adds is spent against a hop that is more likely
 * to time out than to deliver. The four bounds below exist for that reason and
 * not for tidiness.
 *
 * SILENCE, not `isOnline`, decides whether an attempt is worth making. The flag
 * is a stored verdict that a missed disconnect leaves stale in the direction
 * that costs the most — `true` for a desktop that is gone — while a presence
 * timestamp can only age. A stale `true` would buy a dead target the full ladder
 * of retries; a stale timestamp cannot, because silence only grows and the
 * give-up rung below is monotonic in it.
 *
 * WHICH silence: `ComputeTarget.presenceAt`, the relay `presence` clock, NOT
 * `lastSeenAt` (ISS-8897, marisolashgrove on #6459). Every rung below rests on one
 * claim — that a target heard from inside `IDLE_DRAIN_MIN_SILENCE_MS` is being
 * woken by `emitPresenceFleetCapacityMetrics` already — and only a relay
 * presence frame drives that wake. `lastSeenAt` also moves for registration, the
 * direct Socket.IO server's own 30s timer and the SSE stream's online mark, so
 * reading it here made a
 * desktop checking in on any of those transports look covered by a trigger that
 * never fires for it — and its backlog was drained by nothing at all. The two
 * clocks are separate columns on purpose; `lastSeenAt` keeps its own meaning and
 * its own consumers, including the ack-timeout sweep, which asks the different
 * question of whether the desktop is silent on ANY transport.
 */

/**
 * The cron cadence, restated so the stride ladder can be read in minutes.
 *
 * MUST match the five-minute cron entry in `apps/api/vercel.json`; a drift makes
 * every stride below silently mean a different wall-clock interval than its
 * comment claims, so a test pins the two together.
 */
export const IDLE_DRAIN_TICK_MS = 5 * 60 * 1000;

/**
 * Targets considered per tick, after the presence filter and before the stride
 * ladder.
 *
 * ISS-8895 moved the presence half of that sentence: the page used to be picked
 * by backlog depth alone and filtered afterwards in JS, so this number bounded a
 * set the sweep was partly about to discard. It now bounds targets the presence
 * trigger is NOT covering, which is work this sweep can act on. Due-ness is
 * still decided after the read, because the stride ladder is clock arithmetic
 * the database has no business doing.
 *
 * Smaller than the queue-depth sampler's 500 because this one ACTS rather than
 * observes: the sampler's budget buys gauge points, this one buys outbound
 * relay POSTs against a hop that is timing out half the time.
 */
export const IDLE_DRAIN_CANDIDATE_LIMIT = 100;

/**
 * Targets actually drained per tick.
 *
 * The hard fan-out cap. Each drained target costs up to its declared ceiling in
 * concurrent relay POSTs, each bounded by a 5s fetch timeout, and they are run
 * one target at a time — so a tick's worst case is this many 5s stalls in
 * series, which is what `IDLE_DRAIN_BUDGET_MS` then cuts short.
 */
export const IDLE_DRAIN_MAX_TARGETS_PER_TICK = 10;

/**
 * Wall-clock budget for one tick's dispatching.
 *
 * Checked BETWEEN targets, so it bounds how far the sweep walks rather than
 * cancelling a dispatch in flight. Without it a tick of ten fully-timing-out
 * targets can outrun the platform's function limit and lose its own summary
 * line — the one record that says what the sweep did.
 */
export const IDLE_DRAIN_BUDGET_MS = 45_000;

/**
 * Silence below which a target belongs to the presence trigger, not to this.
 *
 * Two heartbeats. A target heard from this recently is being woken every 30s by
 * `emitPresenceFleetCapacityMetrics` already, so draining it here would be a
 * duplicate dispatch against the same backlog on a second schedule.
 */
export const IDLE_DRAIN_MIN_SILENCE_MS = RELAY_PRESENCE_SILENCE_MS;

/** Silence past which a target is not dispatched to at all. */
export const IDLE_DRAIN_GIVE_UP_MS = 24 * 60 * 60 * 1000;

/**
 * Ticks between attempts, as a function of how long a target has been silent.
 *
 * A REAL decay, not a fixed interval renamed: the gap between attempts grows
 * 5min -> 15min -> 30min -> 1h with the silence, then stops. `undefined` is the
 * give-up, and it is the load-bearing entry — a fixed retry, however sparse,
 * costs a permanently-dead target a peer-hop timeout forever, which is bounded
 * per tick and unbounded in time. A target silent for a day is left to its next
 * reconnect, whose hello flush already drains it.
 *
 * Expressed in ticks rather than milliseconds so the ladder cannot disagree
 * with the schedule that drives it.
 */
export function retryStrideTicks(silentMs: number): number | undefined {
  if (silentMs < IDLE_DRAIN_MIN_SILENCE_MS) {
    return;
  }
  if (silentMs < 15 * 60 * 1000) {
    return 1;
  }
  if (silentMs < 60 * 60 * 1000) {
    return 3;
  }
  if (silentMs < 6 * 60 * 60 * 1000) {
    return 6;
  }
  if (silentMs < IDLE_DRAIN_GIVE_UP_MS) {
    return 12;
  }
  return;
}

/**
 * A stable per-target offset in ticks, so a stride does not phase-lock the fleet.
 *
 * Without it every stride-12 target becomes due on the same tick and eats the
 * whole fan-out cap together, starving the stride-1 targets that are likelier
 * to still be reachable. Any stable spread does; this one needs no state and no
 * hash dependency.
 */
function stableTickOffset(targetId: string): number {
  let sum = 0;
  for (let index = 0; index < targetId.length; index++) {
    sum += targetId.charCodeAt(index);
  }
  return sum;
}

/**
 * Whether a target's turn comes up on the tick containing `now`.
 *
 * Derived from the clock rather than from stored attempt counts, so the backoff
 * survives a cold serverless instance. A per-target counter would need either a
 * migration or module state that a Vercel cron does not keep between ticks, and
 * would then decay wrongly — or not at all — on every new instance.
 *
 * The cost of bucketing wall-clock time is scheduler jitter: a firing that
 * slips across a boundary can land two invocations in one bucket, or leave a
 * bucket unfired. Neither strands a target — a missed bucket comes round again
 * one stride later, and a doubled one is a duplicate dispatch the desktop's own
 * `commandId` dedupe already absorbs. It would only starve a target if the
 * scheduler skipped ticks in a period that stayed aligned to that target's
 * offset, which cron jitter is not.
 */
export function isDueThisTick(
  targetId: string,
  silentMs: number,
  now: number
): boolean {
  const stride = retryStrideTicks(silentMs);
  if (stride === undefined) {
    return false;
  }
  const tick = Math.floor(now / IDLE_DRAIN_TICK_MS);
  return (tick + stableTickOffset(targetId)) % stride === 0;
}

/**
 * How long a candidate has been absent from the relay presence trigger.
 *
 * A null `presenceAt` is UNKNOWN, not zero and not infinite: no relay presence
 * frame has ever been observed for this target. The drain resolves that
 * deliberately (ISS-8897 AC4) by measuring from `createdAt`, which is a true
 * lower bound — a target cannot have been present before it existed — rather
 * than a stand-in value. So a brand-new target is treated as never covered,
 * which is what it is, and the stride ladder still leaves it to the presence
 * trigger for its first `IDLE_DRAIN_MIN_SILENCE_MS` in case one is coming.
 * The opposite reading — null as "present now" — would strand its backlog
 * forever, and that is the defect this clock exists to fix.
 */
export function presenceSilenceMs(
  candidate: IdleDrainCandidate,
  now: number
): number {
  return now - (candidate.presenceAt ?? candidate.createdAt).getTime();
}

/**
 * Drains backlogged targets the presence trigger cannot reach.
 *
 * ONE fixed query per tick, bounded after the presence filter rather than
 * before it (ISS-8895), and then at most `IDLE_DRAIN_MAX_TARGETS_PER_TICK`
 * drains. Never a query per fleet member.
 */
export async function drainIdleCommandQueues(): Promise<IdleDrainSummary> {
  const now = Date.now();
  const candidatePage = await listIdleDrainCandidates(
    IDLE_DRAIN_CANDIDATE_LIMIT,
    new Date(now - IDLE_DRAIN_MIN_SILENCE_MS)
  );

  const due: string[] = [];
  let targetsGivenUp = 0;
  for (const candidate of candidatePage.candidates) {
    const silentMs = presenceSilenceMs(candidate, now);
    // Counted from the page rather than filtered out of it: the SQL predicate
    // deliberately stops at the presence cutoff, because a give-up predicate
    // would empty this counter — see `listIdleDrainCandidates`.
    if (silentMs >= IDLE_DRAIN_GIVE_UP_MS) {
      targetsGivenUp += 1;
    }
    if (isDueThisTick(candidate.computeTargetId, silentMs, now)) {
      due.push(candidate.computeTargetId);
    }
  }

  const tick = Math.floor(now / IDLE_DRAIN_TICK_MS);
  const selected = rotatingSelection(
    due,
    tick,
    IDLE_DRAIN_MAX_TARGETS_PER_TICK
  );
  let targetsAttempted = 0;
  let commandsReleased = 0;
  let budgetExhausted = false;

  // One target at a time: the whole point of the fan-out cap is that this sweep
  // never opens the fleet's backlogs onto the relay at once.
  for (const targetId of selected) {
    if (Date.now() - now >= IDLE_DRAIN_BUDGET_MS) {
      budgetExhausted = true;
      break;
    }

    targetsAttempted += 1;
    try {
      commandsReleased += await releaseQueuedCommands(targetId);
    } catch (error) {
      // One unreachable target must not end the sweep for the rest.
      log.warn("command.idle_drain.target_failed", {
        computeTargetId: targetId,
        error,
      });
    }
  }

  return {
    targetsSkippedByBudget: selected.length - targetsAttempted,
    candidatesWithBacklog: candidatePage.candidates.length,
    candidatesTruncated: candidatePage.hasMore,
    targetsDue: due.length,
    targetsGivenUp,
    targetsSkippedByCap: due.length - selected.length,
    targetsAttempted,
    commandsReleased,
    budgetExhausted,
  };
}

/**
 * What one sweep did, for the run's own log line.
 *
 * `targetsDue` and `targetsAttempted` are kept apart on purpose: collapsing
 * them would hide the fan-out cap biting, which is the number that says whether
 * the backoff ladder is spreading the fleet or the cap is silently rationing it.
 *
 * ATTEMPTED, not drained: it counts targets this sweep dispatched AT, including
 * the ones whose drain threw. Naming it `drained` would report a relay outage as
 * successful work, which is the one thing a sweep into a hop failing half its
 * dispatches must not do. `commandsReleased` is the delivered count.
 */
export type IdleDrainSummary = {
  /**
   * Targets on this tick's page: backlogged, and NOT covered by the presence
   * trigger. The page is capped after that second filter, so this number is
   * work this sweep could act on rather than rows it was about to discard.
   */
  candidatesWithBacklog: number;
  candidatesTruncated: boolean;
  targetsDue: number;
  /**
   * Backlogged candidates silent past `IDLE_DRAIN_GIVE_UP_MS`, counted apart
   * from the rest of `targetsDue === 0`.
   *
   * `retryStrideTicks` returns `undefined` both under `IDLE_DRAIN_MIN_SILENCE_MS`
   * (the presence trigger's territory) and past the give-up horizon (stranded
   * for good) — two opposite situations `targetsDue: 0` cannot tell apart on its
   * own. This is the counter for the second, load-bearing one.
   */
  targetsGivenUp: number;
  /** Dropped before the loop, by the fan-out cap. */
  targetsSkippedByCap: number;
  /**
   * Dropped inside the loop, by the wall-clock budget.
   *
   * Kept apart from the cap's count so a budget-truncated tick cannot read as a
   * cap-limited one: they are different problems with different fixes, and a
   * single "skipped" number would name the wrong one.
   */
  targetsSkippedByBudget: number;
  targetsAttempted: number;
  commandsReleased: number;
  budgetExhausted: boolean;
};

/**
 * `count` items from `items`, starting at a tick-derived rotating offset.
 *
 * Needed only in the first rung, where stride 1 puts every candidate up for
 * every tick: `due` is then just the backlog-depth order the query returned,
 * and a plain `slice(0, count)` would hand the same top targets the whole cap
 * every five minutes, starving the rest of that band indefinitely.
 * `stableTickOffset` already spreads the wider strides across ticks on its
 * own — this is what makes that spread apply where the fleet is densest too.
 */
function rotatingSelection<T>(items: T[], tick: number, count: number): T[] {
  if (items.length === 0) {
    return [];
  }
  const start = tick % items.length;
  return items.slice(start).concat(items.slice(0, start)).slice(0, count);
}
