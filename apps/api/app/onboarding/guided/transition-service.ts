/**
 * @file transition-service.ts
 * @description Arbitrates and persists one guided onboarding transition
 * (ISS-8375).
 *
 * **This service persists a pointer; it never performs an action.** Sending
 * invitations, running the GitHub connect flow and downloading the installer
 * are owned by their own endpoints. A client calls the owning action first and
 * posts the transition only on its success.
 *
 * The markers written here are therefore not all the same kind of fact, and the
 * split is worth naming because it decides what a lying client can buy:
 *
 *  - **Re-derived.** `githubConnected` is recomputed on every snapshot from real
 *    database state — an installation row OR the caller's own GitHub OAuth
 *    grant. No marker can grant it, so a posted transition cannot claim it.
 *
 *    `teamInvited` is in this group too, and stayed in it through ISS-11670.
 *    That ticket moved which fact it reads — the per-user
 *    `onboarding_attempts.invites_sent_at` marker instead of the ORGANIZATION's
 *    active member count and invites-sent record, neither of which asks what
 *    this reader did — but NOT who may write it. The marker is stamped by the
 *    invitation send path itself (`organizations/invitations/service.ts`), on
 *    the same `invited > 0` the org-level marker is stamped on, so it records a
 *    send this server performed. `SendInvitations` deliberately stamps NOTHING
 *    here: it is the invite step's Continue, and Continue is also offered on an
 *    `AlreadyMember` outcome, which invites nobody (`invited: 0`, zero `Failed`
 *    rows — `packages/api/src/types/onboarding.ts`). Taking the client's word
 *    there would stamp the marker for a reader who sent no invitation and
 *    re-raise the false "Invitations sent" state ISS-11670 exists to remove.
 *  - **Marker-granted.** `desktopAppDownloaded` is true on this run's download
 *    marker OR a registered compute target; `tourCompleted` is the tour marker
 *    alone. Each takes the client's word that the event happened. That is
 *    deliberate (PLN-1861 §3.1): the marker is what stops the download step
 *    re-asking a user whose desktop has not registered yet, and a finished tour
 *    leaves nothing else to measure.
 *  - **Stamped but never read back.** `accountSkippedAt` is still written here,
 *    still write-once, and still selected — but ISS-11256 stopped the snapshot
 *    deriving anything from it. `buildServerContext` reports
 *    `AccountStatus.Established` unconditionally, because every principal that
 *    can reach either guided route has already resolved a stored user and
 *    organization, so a past deferral can never evidence a present absence.
 *    This marker is an event record, not a grant, and `accountStatus` is
 *    therefore neither re-derived nor marker-granted.
 *
 * The blast radius of the marker-granted two is bounded to skipping a step of
 * the poster's own onboarding. Neither grants access to anything, which is why
 * taking the client's word is acceptable here and would not be for a guard
 * that did.
 */

import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import type {
  GuidedOnboardingSnapshot,
  GuidedOnboardingTransitionRequest,
} from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  restoreOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { Result, Status } from "@repo/api/src/types/result";
import { log } from "@repo/observability/log";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import type { OnboardingWrite } from "../onboarding-receipt";
import {
  guidedOnboardingAttemptStore,
  type OnboardingAttemptMarkers,
  type OnboardingAttemptRecord,
} from "./attempt-store";
import { guidedOnboardingSnapshotService } from "./snapshot-service";

/** How an ACCEPTED transition settled. Both answer 200. */
export const GuidedTransitionOutcome = {
  /** The compare-and-swap held: the state was written and the revision moved. */
  Accepted: "accepted",
  /**
   * A redelivery of a command that already landed. The run is untouched and the
   * caller gets the current snapshot, because a duplicate delivery is a no-op,
   * not a failure.
   */
  Replayed: "replayed",
} as const;
export type GuidedTransitionOutcome =
  (typeof GuidedTransitionOutcome)[keyof typeof GuidedTransitionOutcome];

/** The two ways a transition is refused. Narrower than {@link Status} so the
 * route's translation is exhaustive over exactly these. */
export type GuidedTransitionRejectionStatus =
  | typeof Status.BadRequest
  | typeof Status.Conflict;

export type GuidedTransitionAcceptance = {
  outcome: GuidedTransitionOutcome;
  /** `null` when the write landed but the snapshot could not be composed. */
  snapshot: GuidedOnboardingSnapshot | null;
};

export type GuidedTransitionRejection = {
  status: GuidedTransitionRejectionStatus;
  /**
   * The snapshot the caller reconciles from on a {@link Status.Conflict}, or
   * `null` when composing it failed. Always `null` on a
   * {@link Status.BadRequest}: nothing was written, and composing a snapshot
   * for a payload the client got wrong would run the whole read fan-out for a
   * request that is being refused.
   */
  snapshot: GuidedOnboardingSnapshot | null;
};

/**
 * `Result` from the shared module rather than a one-off discriminated shape
 * (`apps/api/AGENTS.md`, `packages/api/AGENTS.md`). It is generic in its error
 * type, so the conflict's reconciliation snapshot rides the err branch.
 */
export type GuidedTransitionResult = Result<
  GuidedTransitionAcceptance,
  GuidedTransitionRejection
>;

/** The revision a snapshot reports when the caller has no run yet. */
const FIRST_RUN_REVISION = 0;

export type GuidedTransitionInput = {
  organizationId: string;
  userId: string;
  clerkUserId: string;
  command: GuidedOnboardingTransitionRequest;
};

export const guidedOnboardingTransitionService = {
  /**
   * `recordWrite` runs inside the transaction of the write that lands the
   * transition (ISS-12552), and never for a replay or a refusal.
   */
  async apply(
    request: GuidedTransitionInput,
    recordWrite?: RecordWriteInTransaction<OnboardingWrite>
  ): Promise<GuidedTransitionResult> {
    const { organizationId, userId, command } = request;

    // Before the read, before the write, and before `markersFor`: an
    // unreachable state must not reach any of them.
    if (!isCommandStateAcceptable(command)) {
      return Result.err({ status: Status.BadRequest, snapshot: null });
    }

    const existing = await guidedOnboardingAttemptStore.find(
      organizationId,
      userId
    );
    const markers = markersFor(command, existing);
    const write = {
      organizationId,
      userId,
      state: stateForWrite(command),
      commandId: command.commandId,
      markers,
    };

    if (existing === null) {
      // A command composed against a revision this run never reached, with no
      // run to compare it to. Creating the row here would accept a state the
      // server never issued a token for, so it settles as a conflict and the
      // client restarts from the returned first-run snapshot.
      if (command.revision !== FIRST_RUN_REVISION) {
        return await arbitrate(request);
      }
      const created = await guidedOnboardingAttemptStore.create(
        {
          ...write,
          experienceVariant: command.experienceVariant,
          host: command.host,
        },
        recordWrite
      );
      if (created !== null) {
        return await settle(GuidedTransitionOutcome.Accepted, request);
      }
      // A concurrent request created the run first. This command now has to be
      // arbitrated against the row that won, exactly like a failed swap.
      return await arbitrate(request);
    }

    const moved = await guidedOnboardingAttemptStore.compareAndSwap(
      { ...write, revision: command.revision },
      recordWrite
    );
    if (moved === 1) {
      return await settle(GuidedTransitionOutcome.Accepted, request);
    }
    return await arbitrate(request);
  },
};

function stateForWrite(
  command: GuidedOnboardingTransitionRequest
): GuidedOnboardingTransitionRequest["state"] {
  if (command.event.type !== OnboardingEvent.AccountEstablished) {
    return command.state;
  }
  return {
    ...command.state,
    accountProvider: command.event.provider,
  };
}

/**
 * Whether the state this command carries is one the machine could actually have
 * produced, on the caller's own host.
 *
 * `restoreOnboardingState` is called for its VERDICT, not for the state it
 * recovers: it is the read path's own predicate, so routing both boundaries
 * through it makes it impossible for the write to accept a payload the read
 * would throw away.
 *
 * The two boundaries want OPPOSITE outcomes from that one verdict, and that
 * asymmetry is deliberate. A STORED payload has no client left to tell, so the
 * read RECOVERS to a fresh run — something has to render. A POSTED payload has
 * a client, so the write REJECTS it and persists nothing. Without this check a
 * client could post `Ready` with an empty history — shape-valid, host-valid, and
 * reachable by no run — and the read would heal the state on the next GET while
 * `completedAt`, stamped by `markersFor` on the way in, stayed on the row for
 * good.
 */
function isCommandStateAcceptable(
  command: GuidedOnboardingTransitionRequest
): boolean {
  return (
    restoreOnboardingState(command.state, command.host).outcome ===
    OnboardingRestoreOutcome.Restored
  );
}

/**
 * Decide what a command that did not move the row means, against the row as it
 * stands NOW rather than the one read before the swap.
 */
async function arbitrate(
  request: GuidedTransitionInput
): Promise<GuidedTransitionResult> {
  const current = await guidedOnboardingAttemptStore.find(
    request.organizationId,
    request.userId
  );
  if (current?.lastCommandId === request.command.commandId) {
    return await settle(GuidedTransitionOutcome.Replayed, request);
  }
  return Result.err({
    status: Status.Conflict,
    snapshot: await composeSnapshot(request),
  });
}

async function settle(
  outcome: GuidedTransitionOutcome,
  request: GuidedTransitionInput
): Promise<GuidedTransitionResult> {
  return Result.ok({ outcome, snapshot: await composeSnapshot(request) });
}

/**
 * The current snapshot, or `null` when composing it failed.
 *
 * `getSnapshot` is deliberately all-or-nothing — a `false` it did not measure is
 * indistinguishable from a measured negative and would silently grant or deny a
 * gate — and its fan-out includes a live Clerk call. Letting that reject here
 * would answer 500 for a transition that ALREADY LANDED DURABLY, so the true
 * outcome is reported without a snapshot and the client re-reads through GET.
 *
 * `null` is not a snapshot whose fields are false: it says nothing was measured,
 * which keeps the same honesty the GET path keeps by refusing outright. That
 * path is untouched — this recovery lives here, on the write acknowledgement,
 * and not in `getSnapshot`.
 */
async function composeSnapshot(
  request: GuidedTransitionInput
): Promise<GuidedOnboardingSnapshot | null> {
  try {
    return await guidedOnboardingSnapshotService.getSnapshot({
      organizationId: request.organizationId,
      userId: request.userId,
      clerkUserId: request.clerkUserId,
      host: request.command.host,
    });
  } catch (error) {
    log.error("Failed to compose the guided onboarding snapshot", {
      error,
      organizationId: request.organizationId,
      userId: request.userId,
      commandId: request.command.commandId,
      host: request.command.host,
    });
    return null;
  }
}

/**
 * The timestamps this transition implies, minus any the run already carries.
 *
 * Each marker records the FIRST time something happened, so an already-set one
 * is left alone: `Ready` is re-entered every time a resumed step finishes, and
 * re-stamping `completedAt` there would move the completion time forward to the
 * last resume rather than the first arrival.
 *
 * Reading `existing` to compute this is not a read-modify-write of the state:
 * the state written is the client's, whole, and the compare-and-swap on
 * `revision` still decides whether this command lands at all. A command that
 * computed its markers against a row another writer has since moved fails the
 * swap and never writes them.
 *
 * `completedAt` is read off the posted PHASE rather than the event, because
 * every event that lands a run on `Ready` is a user answering something. Every
 * event but one: `defer_tour` is the client reporting that a tour it could not
 * SHOW ended by itself, and the reasons a tour cannot show include the
 * dashboard having failed to load — `DashboardContentState.Degraded` emits no
 * anchor to ring, exactly like the empty org the deferral was built for, and
 * the wire carries no reason that would tell the server which of the two it is.
 * So a deferral is an absence of evidence, not evidence of an arrival, and it
 * stamps nothing. That costs the empty-org reader a completion time until they
 * arrive at `Ready` again, which is the reader deferral exists to serve — the
 * `finish_tour` they post once their data lands stamps it, since Ready owes
 * nothing about how it was reached the second time. An unknown completion is
 * recoverable; a stamped one is durable and wrong.
 */
function markersFor(
  command: GuidedOnboardingTransitionRequest,
  existing: OnboardingAttemptRecord | null
): OnboardingAttemptMarkers {
  const now = new Date();
  const markers: OnboardingAttemptMarkers = {};
  if (
    command.event.type === OnboardingEvent.SkipAccount &&
    existing?.accountSkippedAt == null
  ) {
    markers.accountSkippedAt = now;
  }
  if (
    command.event.type === OnboardingEvent.DownloadDesktopApp &&
    existing?.desktopDownloadedAt == null
  ) {
    markers.desktopDownloadedAt = now;
  }
  if (
    command.event.type === OnboardingEvent.FinishTour &&
    existing?.tourCompletedAt == null
  ) {
    markers.tourCompletedAt = now;
  }
  if (
    command.state.phase === OnboardingPhase.Ready &&
    command.event.type !== OnboardingEvent.DeferTour &&
    existing?.completedAt == null
  ) {
    markers.completedAt = now;
  }
  return markers;
}
