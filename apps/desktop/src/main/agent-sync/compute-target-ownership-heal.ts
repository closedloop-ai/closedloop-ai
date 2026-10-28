/**
 * @file compute-target-ownership-heal.ts
 * @description ISS-11467: the bounded, silent self-heal for the ownership
 * refusals the client could NOT see locally.
 *
 * `identity-bound-compute-target.ts` stops a KNOWN-foreign id from ever being
 * sent. What it cannot stop is the case its own guard deliberately declines to
 * judge: with no account recorded against the retained target, a STALE or ROTATED
 * id belonging to this same account is indistinguishable from another account's
 * id, and only the server can tell them apart
 * (`retained-compute-target-identity.ts:336`). The coded 403 ISS-11426 added is
 * that server answer arriving in a form this build can act on.
 *
 * So exactly one repair happens here: RE-RESOLVE the identity we already hold and
 * send the same batch once more under whatever that resolves to now.
 *
 * What this is NOT, and must never become: a re-registration. The refusal exists
 * so nothing crosses accounts, and claiming a NEW compute target to get unstuck
 * is the one move that could attach one account's captured sessions to another.
 * `reresolveComputeTargetId` is a READ of the resolver the lane already consults,
 * which is why a null from it stops the heal instead of escalating to a mint.
 *
 * ## Why one slot rather than a counter or a set
 *
 * The bound is a single remembered refused id, and both halves of that matter. A
 * per-call counter would let a permanently foreign install pay a second request
 * on every batch forever — the production install this ticket was written from
 * sent 5,219 batches and had 98.3% refused, so that is 5,000 extra requests to
 * learn one fact twice. A Set of refused ids would grow without bound from a
 * value the server controls, which the repo forbids for exactly this shape. One
 * slot spends one retry per DISTINCT refused target: a genuinely stale id heals
 * on its first refusal, a genuinely foreign one costs one round trip and is then
 * left to the ISS-11426 relink, and the slot re-arms only when the machine starts
 * presenting a different target.
 *
 * The slot is spent BEFORE the re-resolve, not after the retry settles. An
 * exception or a null resolve still consumes it, because a heal that could not
 * even be attempted must not be retried on the next batch either — that is the
 * loop this bound exists to make unreachable.
 *
 * ## Silence is the contract
 *
 * Nothing here reaches the renderer on the HEALED path. A stale id healing is not
 * news to the person using the app; the foreign case keeps its one ISS-11426
 * affordance, which the lane composition now latches from the local owner check as
 * well as from a server 403.
 *
 * What the outcomes get instead is separate observability, without a
 * telemetry-contract change. Four outcomes, and the reason they are four rather
 * than two is that collapsing them recreates the original defect one rung in — a
 * lane that never finishes with nothing saying so:
 *
 * - `healed` — the cloud ACCEPTED the retry. A `sync.batch` SUCCESS span carrying
 *   `sync.attempt: 2`, plus the gateway log line.
 * - `refused_again` — refused on ownership again under the fresh target: a
 *   `sync.batch` FAILURE span, `sync.reason:target_not_owned`, `sync.attempt: 2`.
 * - `inconclusive` — the retry went out and landed on neither: a rejected ack, a
 *   5xx, a transport error. Its span is whatever that failure was, and the lane is
 *   handed the FIRST result so its accounting is untouched.
 * - `not_reresolved` / `unnameable` — no second span, because no second batch was
 *   sent; the gateway log line is the record.
 *
 * `sync.attempt` is reused rather than a new `SyncReason` member being added
 * because `SyncTelemetrySchema` is `.strict()` over a closed enum and its receiver
 * deploys independently: emitting a member the receiver has not learned drops the
 * WHOLE span, so a new value has to land receiver-first
 * (`docs/runbooks/backward-compatible-api-contracts.md`). The invocation lane has
 * never set `sync.attempt`, so on `sync.lane:invocation_parts` its presence means
 * this and only this.
 *
 * KNOWN SHORTFALL, disclosed rather than papered over: the `refused_again` arm is
 * retained whole because failure spans trip `keep-error-status`, while the `healed`
 * arm rides a baseline-sampled SUCCESS span
 * (`packages/telemetry-contract/src/sync-sampling-bias.ts`). So a count of
 * `refused_again` is exact and a count of `healed` is a sample at no known constant
 * rate — read the healed arm as presence, never as a rate, and never compute a
 * heal-success ratio from the two. Closing that needs a sampling-immune counter
 * dimension, which is a telemetry-contract change and a separate receiver-first
 * deploy.
 */

import type { AgentComponentInvocationSyncPart } from "@repo/api/src/types/agent-component-invocation";
import { DesktopAgentComponentInvocationSyncRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import type {
  AgentComponentInvocationSyncClientResult,
  DesktopAgentComponentInvocationsClient,
} from "../dashboard/desktop-agent-component-invocations-client.js";
import type { ComputeTargetLinkBlockTracker } from "./compute-target-link-block.js";
import {
  invocationPartBatchEvent,
  type SyncLaneBatchEvent,
} from "./sync-lane-cloud-health.js";

/** 1-indexed, so this is the SECOND send of the batch — the heal retry. */
export const COMPUTE_TARGET_OWNERSHIP_HEAL_ATTEMPT = 2;

/** How many distinct refused targets keep a spent heal. See the FIFO's comment. */
const HEAL_SLOT_CAPACITY = 8;

export const ComputeTargetOwnershipHealOutcome = {
  /** The re-resolved target was accepted: a stale id, healed with no user action. */
  Healed: "healed",
  /** Refused again under a DIFFERENT re-resolved target: the foreign case, left to the relink. */
  RefusedAgain: "refused_again",
  /**
   * The re-resolve produced the id the cloud just refused, so there was nothing
   * fresh to retry under and nothing was sent.
   *
   * Its own outcome, and that matters. Folding it into `RefusedAgain` would report
   * "we re-resolved and the server said no twice" for a batch the server was only
   * asked about once — and `RefusedAgain` is what hands the case to the relink, so
   * the collapse would attribute an unmoved local resolver to a foreign account.
   * This is the expected outcome whenever the socket has not re-acked, which on a
   * strict-online lane is most of the time.
   */
  NotReresolved: "not_reresolved",
  /**
   * The re-resolve could name no live target at all, so nothing was sent.
   *
   * Separate from {@link NotReresolved} because the two say different things about
   * the machine: "the resolver has not moved" is an ordinary strict-online tick,
   * while "the resolver can name nothing" is a socket that went down or an owner
   * check that has since refused the id outright. Neither is a retry and neither is
   * the foreign case.
   */
  Unnameable: "unnameable",
  /**
   * The retry went out and came back something OTHER than an acceptance or an
   * ownership refusal — a transport error, a 5xx, a rejected ack.
   *
   * It exists because `healed` must mean the cloud TOOK the batch. Folding a
   * `session_missing` rejection or a dropped connection into `healed` would report
   * success for a retry that never landed, which is the same false-completeness the
   * original defect had, on the one signal added to detect it.
   *
   * On this outcome the heal hands the FIRST result back to the lane, so the batch
   * is accounted exactly as it would have been with no heal at all. That is
   * deliberate and it is a safety property, not tidiness: `target_not_owned` burns
   * no retry budget, while a rejection like `session_missing` charges its horizon
   * and walks the row toward quarantine. A speculative retry must never be able to
   * turn a stuck-but-safe row into a dead-lettered one.
   */
  Inconclusive: "inconclusive",
} as const;
export type ComputeTargetOwnershipHealOutcome =
  (typeof ComputeTargetOwnershipHealOutcome)[keyof typeof ComputeTargetOwnershipHealOutcome];

export type ComputeTargetOwnershipHealer = {
  /**
   * Spend this refused target's one heal attempt and answer with a FRESH target to
   * retry under, or null when there is no bounded retry worth making — the attempt
   * is already spent for this id, the resolver can no longer name a target, or the
   * re-resolve produced the very id the cloud just refused.
   *
   * That last case is the common one on a strict-online lane and it is why this
   * returns null rather than the same id: a 403 does not restart the socket or
   * invalidate the retained record, so unless a hello landed inside the window the
   * resolver answers with what the lane already sent. Re-sending it buys one
   * guaranteed-identical refusal, a second failure span and a second increment on
   * the user-visible relink count, and learns nothing.
   */
  claimRetryTargetId(refusedComputeTargetId: string): string | null;
  /**
   * Record how the one retry settled, and SPEND the slot for the target it was
   * refused under. Spending here rather than at {@link claimRetryTargetId} is what
   * keeps the heal reachable: on a strict-online lane the resolver has usually not
   * moved at the moment of the first refusal, so spending on that answer would burn
   * the target's only attempt seconds after boot and the heal could never fire in
   * the one window it exists for. A non-attempt costs an in-process read and no
   * request, so there is nothing to bound there.
   *
   * Only the outcomes that ACTUALLY sent a second batch reach here — the non-retry
   * answers are recorded by {@link claimRetryTargetId}, which is the only place
   * they are distinguishable from each other.
   */
  recordOutcome(
    outcome: ComputeTargetOwnershipHealOutcome,
    refusedComputeTargetId: string,
    retriedComputeTargetId: string
  ): void;
};

export type ComputeTargetOwnershipHealerDeps = {
  /**
   * Re-read the identity-bound resolver. A READ, never a mint: null means the
   * account signed in now cannot be shown to own any live target, and the heal
   * stops there rather than claiming one.
   */
  reresolveComputeTargetId: () => string | null;
  log: (message: string) => void;
};

export function createComputeTargetOwnershipHealer(
  deps: ComputeTargetOwnershipHealerDeps
): ComputeTargetOwnershipHealer {
  // A bounded FIFO of the refused targets whose one heal is already spent. A SET
  // rather than a single slot because an online target can alternate — a flapping
  // socket, two relays — and a single slot re-arms on every switch, which is the
  // per-batch cost this bound exists to prevent. Capped and evicted oldest-first
  // because the keys come from the server: an unbounded set fed by external input is
  // the growth this repo forbids. A cap this small can only ever re-arm a target
  // that has been out of rotation for `HEAL_SLOT_CAPACITY` distinct others, which
  // costs one request.
  const spentComputeTargetIds: string[] = [];
  const log = (
    outcome: ComputeTargetOwnershipHealOutcome,
    computeTargetId: string
  ) => {
    deps.log(
      `compute-target ownership heal ${outcome}: refused target ${computeTargetId}`
    );
  };
  return {
    claimRetryTargetId(refusedComputeTargetId) {
      if (spentComputeTargetIds.includes(refusedComputeTargetId)) {
        return null;
      }
      const reresolved = deps.reresolveComputeTargetId();
      // Both non-retry answers are recorded HERE rather than by the caller, because
      // only this function can tell them from a slot that was already spent — which
      // is also a null return and was already recorded on the batch that spent it.
      // Reporting all three as one outcome is the collapse this module exists to
      // avoid, one rung in.
      if (reresolved === null) {
        log(
          ComputeTargetOwnershipHealOutcome.Unnameable,
          refusedComputeTargetId
        );
        return null;
      }
      if (reresolved === refusedComputeTargetId) {
        log(
          ComputeTargetOwnershipHealOutcome.NotReresolved,
          refusedComputeTargetId
        );
        return null;
      }
      return reresolved;
    },
    recordOutcome(outcome, refusedComputeTargetId, retriedComputeTargetId) {
      spentComputeTargetIds.push(refusedComputeTargetId);
      if (spentComputeTargetIds.length > HEAL_SLOT_CAPACITY) {
        spentComputeTargetIds.shift();
      }
      deps.log(
        `compute-target ownership heal ${outcome}: refused target ${refusedComputeTargetId}, retried under ${retriedComputeTargetId}`
      );
    },
  };
}

/**
 * ISS-11467: send one invocation part, and on a CODED ownership refusal re-resolve
 * the identity we already hold and send it once more.
 *
 * The retry is gated on `forbiddenCode`, never on the bare 403 status, which is
 * what keeps this compatible in both directions. An API deployment predating
 * ISS-11426 sends no code, so `forbiddenCode` is absent, so nothing here fires
 * and the batch takes exactly the path it takes today — the reason fold still
 * calls it `target_not_owned` and the ISS-11426 link block still latches. An
 * org-policy denial now arrives as `feature_disabled` and is never retried,
 * because relinking is not its remedy and re-resolving an identity would not
 * change the answer.
 *
 * Both sends go through the same emit/observe/burn-down path, deliberately. A
 * retry that skipped the tee would leave the link block latched on the first
 * refusal even when the retry was ACCEPTED, and a lane that heals while its alert
 * still says it is blocked is the lie the alert exists to prevent.
 */
export async function sendInvocationPartWithOwnershipHeal(input: {
  part: AgentComponentInvocationSyncPart;
  computeTargetId: string;
  client: DesktopAgentComponentInvocationsClient;
  computeTargetLinkBlock: ComputeTargetLinkBlockTracker;
  emitSyncBatchEvent: (event: SyncLaneBatchEvent) => void;
  ownershipHealer: ComputeTargetOwnershipHealer;
  recordAccepted: (result: AgentComponentInvocationSyncClientResult) => void;
}): Promise<AgentComponentInvocationSyncClientResult> {
  const first = await sendOneInvocationPart(input, input.computeTargetId);
  if (!isOwnershipRefusal(first)) {
    return first;
  }
  const retryTargetId = input.ownershipHealer.claimRetryTargetId(
    input.computeTargetId
  );
  if (retryTargetId === null) {
    return first;
  }
  const retried = await sendOneInvocationPart(
    input,
    retryTargetId,
    COMPUTE_TARGET_OWNERSHIP_HEAL_ATTEMPT
  );
  const outcome = healOutcome(retried);
  input.ownershipHealer.recordOutcome(
    outcome,
    input.computeTargetId,
    retryTargetId
  );
  // The FIRST result on anything inconclusive, so a speculative retry can never
  // make the lane's accounting worse than not retrying: `target_not_owned` burns no
  // retry budget, and a rejection such as `session_missing` charges a horizon that
  // ends in quarantine.
  return outcome === ComputeTargetOwnershipHealOutcome.Inconclusive
    ? first
    : retried;
}

/**
 * How the retry settled. `healed` requires an ACCEPTED ack — the cloud took the
 * batch — and nothing weaker. A rejected ack, a transport error and an
 * `unavailable` are all `inconclusive`: the retry did not land, and reporting one as
 * a heal would put false completeness on the one signal added to detect it.
 */
function healOutcome(
  retried: AgentComponentInvocationSyncClientResult
): ComputeTargetOwnershipHealOutcome {
  if (retried.kind === "ack" && retried.ack.accepted) {
    return ComputeTargetOwnershipHealOutcome.Healed;
  }
  if (isOwnershipRefusal(retried)) {
    return ComputeTargetOwnershipHealOutcome.RefusedAgain;
  }
  return ComputeTargetOwnershipHealOutcome.Inconclusive;
}

/**
 * One send plus its three observers. `attempt` is set ONLY on the heal retry:
 * the invocation lane has never carried `sync.attempt`, so on
 * `sync.lane:invocation_parts` its presence reads unambiguously as "this was the
 * ISS-11467 heal", and the two outcomes separate as
 * `sync.outcome:success sync.attempt:2` against
 * `sync.reason:target_not_owned sync.attempt:2`. Omitted rather than defaulted to
 * 1 on the first send, so an ordinary batch keeps reporting no attempt count
 * instead of a fabricated one.
 */
async function sendOneInvocationPart(
  input: {
    part: AgentComponentInvocationSyncPart;
    client: DesktopAgentComponentInvocationsClient;
    computeTargetLinkBlock: ComputeTargetLinkBlockTracker;
    emitSyncBatchEvent: (event: SyncLaneBatchEvent) => void;
    recordAccepted: (result: AgentComponentInvocationSyncClientResult) => void;
  },
  computeTargetId: string,
  attempt?: number
): Promise<AgentComponentInvocationSyncClientResult> {
  const result = await input.client.syncPart(input.part, computeTargetId);
  // ISS-6338: lane 2's cloud batch health. Emitted for EVERY outcome, not
  // just failures — a monitor that only ever sees failures cannot tell a
  // healthy lane from one that stopped being called.
  const batchEvent = invocationPartBatchEvent(result);
  input.emitSyncBatchEvent(
    attempt === undefined ? batchEvent : { ...batchEvent, attempt }
  );
  // ISS-11426 tee: the same event, read for the one reason a USER can act
  // on. Fed for every outcome, because a success is what clears the block.
  input.computeTargetLinkBlock.observe(batchEvent, computeTargetId);
  input.recordAccepted(result);
  return result;
}

/**
 * ISS-11467: a refusal this build can attribute to OWNERSHIP, from the code the
 * server sent rather than from the status. An absent code is the pre-ISS-11426
 * server and is deliberately NOT treated as an ownership refusal here, even
 * though the reason fold still labels it one: guessing from a status is the
 * collapse the coded 403 removed, and a heal driven by a guess would retry an
 * org-policy denial forever.
 */
function isOwnershipRefusal(
  result: AgentComponentInvocationSyncClientResult
): boolean {
  return (
    result.kind === "retry" &&
    result.forbiddenCode ===
      DesktopAgentComponentInvocationSyncRestErrorCode.TargetNotOwned
  );
}
