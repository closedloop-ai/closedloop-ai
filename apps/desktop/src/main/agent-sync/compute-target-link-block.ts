/**
 * @file compute-target-link-block.ts
 * @description ISS-11426: the latch that makes a `target_not_owned` refusal
 * visible to the user instead of deferring it forever in silence.
 *
 * `target_not_owned` is a no-budget-burn environmental class
 * (`agent-session-sync-backoff-policy.ts`), so a lane refused under it defers
 * with every retry budget intact and never dead-letters. That is the right
 * SAFETY behaviour — the rows are stuck, not lost — and it is also why the
 * condition is invisible: the sync panel stays green while the lane stops
 * advancing. Measured 2026-09-28 on one production install, 5,131 of its 5,219
 * sync batches refused over two days with no surface saying so and no action
 * available to the person using it.
 *
 * What a refusal actually MEANS is narrow, which is why only one reason latches
 * here. The server answers it when
 * `computeTarget.findFirst({ id, organizationId, userId })` misses
 * (`apps/api/app/compute-targets/service.ts`), so the target this machine is
 * presenting is not one the signed-in account owns — typically a target minted
 * before an account switch. The remedy is to link this machine to the account
 * signed in now, which is something the user can do. An org-policy denial is
 * NOT that: it arrives as `feature_disabled` since ISS-11426 coded the two
 * apart, only an org admin can change it, and relinking would do nothing — so
 * it must never reach this latch. ISS-11449 retires that policy altogether, after
 * which an ownership refusal is the dominant remaining cause — which is why this
 * keys on the REASON the coded 403 produced and never on the bare 403 status. The
 * one residue is an UNCODED 403 from an API deploy predating ISS-11426, which the
 * lane still folds to `target_not_owned` exactly as it did before; cloud deploys
 * ahead of desktop (`main/sync/AGENTS.md`), so that pairing is a compatibility
 * path rather than a fleet state, and it latches no more than today reports.
 *
 * A LEVEL, not an event: the block is read by a once-a-second status poll, so it
 * has to answer "is this still true right now". Exactly ONE thing clears it — a
 * batch the cloud ACCEPTED — and that asymmetry is the whole rule.
 *
 * Neither half of it is arbitrary. A non-ownership FAILURE (a 429, a transport
 * blip, an ingest error) says nothing about whether the presented identity is
 * owned, so clearing on one would drop the alert and its action between two
 * refusals and restart the block's age and count on the next — a two-day
 * condition could then never be represented (whitlockk). And a success is accepted
 * REGARDLESS of which target it names, because the remedy this alert asks for
 * produces a success under a DIFFERENT target: keying the clear on the refused
 * id would leave a block latched under a target the machine no longer presents,
 * unclearable for the life of the process, still telling a user who has already
 * relinked that they have not. The over-eager direction is the bounded one — a
 * still-refused lane re-latches on its next batch, seconds later.
 *
 * WHICH LANE ANSWERED IS PART OF THE EVIDENCE, and it is the correction whitlockk,
 * tamsinb and the codex reviewer all landed on from different sides. "Any
 * success clears" is only sound over lanes whose route actually runs the
 * owner-scoped lookup. The desktop trace-comment lane (removed by ISS-11213) did
 * not: a BRANCH-targeted trace comment carries no compute target at all
 * (`apps/api/app/comments/service/trace-comment-target-lookup.ts`), so its
 * acceptance proved nothing about the identity this machine presents — yet it
 * reached the same tracker and wiped a transcript-lane refusal, which on a
 * once-a-second poll made the alert flicker and restart its age. That route
 * also answers a bare `forbiddenResponse()` for the org session-sync policy
 * (`route-handlers.ts` → `traceCommentSyncPolicyError`) and for editing a
 * comment somebody else owns, which the desktop folded to `target_not_owned` on
 * status alone. {@link LANE_OWNERSHIP_ROLE} is where that is decided, once,
 * exhaustively over the closed lane union, which still carries the
 * trace-comment member.
 *
 * Never a timer: a timer clears a condition that is still blocking egress.
 */

import { SyncLane, SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { DesktopSyncBatchOutcome } from "../telemetry/app-otel-runtime.js";
import type { SyncLaneBatchEvent } from "./sync-lane-cloud-health.js";

/**
 * The block as the renderer reads it: counts and one opaque id, never a path, a
 * session id or a credential.
 */
export type ComputeTargetLinkBlockState = {
  /** The target the cloud refused, or null when the lane could not name one. */
  refusedComputeTargetId: string | null;
  /** How many batches have been refused since the block was first observed. */
  refusedBatchCount: number;
  /** ISO timestamp of the first refusal in this block. */
  firstRefusedAt: string;
};

export type ComputeTargetLinkBlockTracker = {
  /**
   * Fold one lane batch outcome into the block. Safe to call for every outcome
   * on every lane — a success is what CLEARS the block, so calling it only on
   * failures would latch the first refusal forever, and a lane whose answer is
   * not evidence about ownership is discarded HERE rather than at each tee.
   */
  observe(event: SyncLaneBatchEvent, computeTargetId: string | null): void;
  /**
   * ISS-11467: latch the block from the LOCAL owner check instead of a server
   * refusal, for the account-switch case the lanes no longer spend a batch on.
   *
   * Routing every lane through the identity-bound resolver means a KNOWN-foreign
   * id never reaches the cloud — which also means it can never be refused, and
   * {@link observe} was the block's only producer. Without this the relink ISS-11426
   * shipped would silently stop appearing in exactly the state it was built for.
   * The condition is identical, only detected one hop earlier: the client and the
   * server disagree with nobody about who owns the target.
   *
   * Caller-gated to the FOREIGN-ACCOUNT refusal
   * (`ComputeTargetRefusalReason`), never the ISS-8702 origin mismatch, which is
   * transient and would make this a prompt for a condition that clears itself.
   *
   * Latches at a count of ONE and does not climb on repeat, because a lane tick is
   * not a batch: `refusedBatchCount` counts batches the cloud refused, and pacing
   * it off a once-a-second readiness read would report a number no batch produced.
   * A later server refusal under the same target still increments through
   * {@link observe}, and an accepted batch still clears it.
   */
  observeLocalOwnershipRefusal(computeTargetId: string): void;
  /** The current block, or null when nothing is blocked. */
  read(): ComputeTargetLinkBlockState | null;
};

/**
 * What ONE lane's answer is evidence of, for this latch alone.
 *
 * Two independent questions, and a lane can answer the second without
 * answering the first: does an accepted batch prove the cloud takes the
 * identity this machine presents (may CLEAR), and is a `target_not_owned` from
 * this lane an ownership refusal the server NAMED rather than one the desktop
 * inferred from a bare 403 (may LATCH)?
 */
export const ComputeTargetOwnershipRole = {
  /**
   * Owner-scoped route AND a coded 403, so both answers count. May latch and
   * may clear.
   */
  Coded: "coded",
  /**
   * Owner-scoped route whose 403 is still bare, so acceptance proves ownership
   * but a refusal cannot be told apart from a policy denial. Clears only.
   */
  AcceptanceOnly: "acceptance_only",
  /** Not an ownership answer in either direction. Ignored entirely. */
  Unrelated: "unrelated",
} as const;
export type ComputeTargetOwnershipRole =
  (typeof ComputeTargetOwnershipRole)[keyof typeof ComputeTargetOwnershipRole];

/**
 * Exhaustive over the closed lane union by TYPE, not by a side list: a new
 * `SyncLane` reds `tsc` here and has to state what its answer means, rather
 * than inheriting "clears the alert" by default — which is the shape of the
 * defect this table fixes.
 *
 * Every `Coded` entry is coded on the SERVER today, which is what the role
 * asserts:
 * - session metadata — FEA-3425 split `feature_disabled` out
 *   (`desktop-agent-sessions-client.ts` → `ackReasonForHttpFailure`)
 * - invocation parts — ISS-11426, this change
 *   (`DesktopAgentComponentInvocationSyncRestErrorCode`)
 * - transcript archive — `TranscriptForbiddenCode.PolicyDisabled` /
 *   `.NotOwned` (`transcript-failure-classification.ts`)
 *
 * The component-inventory route DOES run `findOwnedById`
 * (`apps/api/app/desktop/components/sync/service.ts`) but answers an
 * uncoded 403, so it may clear and may not latch. It does not reach this
 * tracker today; the entry states what its answer would MEAN rather than
 * leaving the next wiring to guess.
 */
const LANE_OWNERSHIP_ROLE: Record<SyncLane, ComputeTargetOwnershipRole> = {
  [SyncLane.SessionMetadata]: ComputeTargetOwnershipRole.Coded,
  [SyncLane.InvocationParts]: ComputeTargetOwnershipRole.Coded,
  [SyncLane.TranscriptArchive]: ComputeTargetOwnershipRole.Coded,
  [SyncLane.ComponentInventory]: ComputeTargetOwnershipRole.AcceptanceOnly,
  // Branch-targeted comments carry no compute target, the route's 403 covers
  // the org policy and "not your comment" as well as ownership, and neither is
  // coded. Both directions are therefore noise.
  [SyncLane.TraceComments]: ComputeTargetOwnershipRole.Unrelated,
};

export function createComputeTargetLinkBlockTracker(
  now: () => number = Date.now
): ComputeTargetLinkBlockTracker {
  let state: ComputeTargetLinkBlockState | null = null;
  return {
    observe(event, computeTargetId) {
      const role = LANE_OWNERSHIP_ROLE[event.lane];
      if (role === ComputeTargetOwnershipRole.Unrelated) {
        return;
      }
      if (event.reason === SyncReason.TargetNotOwned) {
        // Only a lane that CODES its 403 may latch. On every other lane the
        // reason was folded from the bare status, which cannot tell an
        // ownership miss from an org-policy denial — and offering the relink
        // for a policy denial sends the user at an action that cannot help.
        if (role === ComputeTargetOwnershipRole.Coded) {
          state = nextBlock(state, computeTargetId, now);
        }
        return;
      }
      // An ACCEPTED batch — and only that — is evidence the cloud takes the
      // identity this machine presents, whichever target it named. Every other
      // failure reason leaves the block exactly as it was.
      if (event.outcome === DesktopSyncBatchOutcome.Success) {
        state = null;
      }
    },
    observeLocalOwnershipRefusal(computeTargetId) {
      if (state?.refusedComputeTargetId === computeTargetId) {
        return;
      }
      state = {
        refusedComputeTargetId: computeTargetId,
        refusedBatchCount: 1,
        firstRefusedAt: new Date(now()).toISOString(),
      };
    },
    read() {
      return state;
    },
  };
}

function nextBlock(
  previous: ComputeTargetLinkBlockState | null,
  computeTargetId: string | null,
  now: () => number
): ComputeTargetLinkBlockState {
  if (
    previous !== null &&
    previous.refusedComputeTargetId === computeTargetId
  ) {
    return {
      ...previous,
      refusedBatchCount: previous.refusedBatchCount + 1,
    };
  }
  return {
    refusedComputeTargetId: computeTargetId,
    refusedBatchCount: 1,
    firstRefusedAt: new Date(now()).toISOString(),
  };
}
