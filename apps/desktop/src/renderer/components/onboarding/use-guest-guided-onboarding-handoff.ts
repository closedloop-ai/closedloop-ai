import type { OnboardingAccountModes } from "@repo/api/src/types/onboarding-analytics";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import { restoreOnboardingState } from "@repo/api/src/types/onboarding-persistence";
import {
  type KnownFlag,
  OnboardingHost,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import {
  useGuidedOnboardingSnapshot,
  useGuidedOnboardingTransition,
} from "@repo/app/onboarding/hooks/use-guided-onboarding";
import { isGuidedOnboardingTransportFailure } from "@repo/app/onboarding/lib/guided-onboarding-event-support";
import { createAccountEstablishedEventForProvider } from "@repo/app/onboarding/lib/guided-onboarding-events";
import type { GuidedOnboardingRun } from "@repo/app/onboarding/lib/guided-onboarding-run";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearGuestGuidedOnboardingRecord,
  type GuestGuidedOnboardingRecord,
  readGuestGuidedOnboardingRecord,
} from "./guest-guided-onboarding-record";

/**
 * Carry a signed-out guest's guided onboarding run across the moment they sign
 * in, by handing it to a server attempt before the server becomes the source.
 *
 * THE DEFECT THIS EXISTS FOR. `useGuestGuidedOnboardingRun` is gated on
 * `canOfferAccount`, which goes false the instant the account settles. Without
 * this hook the mount falls straight back to the server run — and the server
 * has no attempt, because a guest never posts one, so `getSnapshot` reports
 * `attemptId: null` at the machine's first-run default of
 * `OnboardingPhase.Welcome`. That phase is blocking, so a newly created account
 * is shown Welcome and Session Discovery over again, having just completed
 * them. The local record was still on disk the whole
 * time; nothing read it.
 *
 * THE HANDOFF IS THE MACHINE'S OWN EDGE, not a bespoke import. What actually
 * happened is that an account was established from the Account phase, which is
 * an `account_established` transition the machine already defines — so the run
 * is posted as that transition, composed against the guest's stored state and
 * the server's MEASURED context. The server writes the client's state verbatim
 * and the compare-and-swap at `revision: 0` is what creates the row, so the new
 * attempt materialises at the position the guest reached rather than at a fresh
 * Welcome.
 *
 * It follows that the machine, not this hook, decides whether a handoff is
 * legitimate. A guest whose stored run is somewhere `account_established` is not
 * a defined edge from — one who skipped the account and later signed in from
 * the topbar, say — has that command REJECTED before it is sent, and the server
 * keeps the fresh run it would have had. That is the honest answer: an account
 * still owes the organization, sync and invite tail that a guest's local run
 * never covered, and seeding past it would hand a real account a Dashboard it
 * never earned. The one case this is here to fix is the one the guest actually
 * takes, and it is the one the machine accepts.
 *
 * WHILE THE HANDOFF IS IN FLIGHT the run reports `snapshot: null` with
 * `isLoading: true`. That is the seam's documented "this source has no run to
 * offer yet" — the dialog renders as restoring rather than flashing the very
 * Welcome screen being handed away, and the host cannot post against a snapshot
 * that does not exist. Reporting the LOCAL snapshot through this window would be
 * the easier thing and would be a lie: its context says
 * `accountStatus: Skipped` and `membership: FirstUser` about a reader who now
 * has an account.
 *
 * A LOST HANDOFF DOES NOT SWITCH SOURCES BACK (ISS-10340). Releasing the
 * mount on failure as well as success is what made a network blip replay
 * Welcome and Session Discovery: the host falls back to the server snapshot,
 * and for a brand-new account that is an absent attempt reporting a first run.
 * The composed handoff snapshot — the guest's state under the server's measured
 * context — becomes the run this hook KEEPS OFFERING instead, so the host reads
 * the guest's position back and the next accepted transition creates the row at
 * `revision: 0` exactly as the handoff would have. The position is held as a
 * run rather than seeded into the snapshot cache because the cache is not a
 * place a failed mutation can leave anything: the shared transition hook's own
 * `onError` invalidates that exact key first, so a seed written after it is
 * overwritten by the refetch it started, and `isInvalidated` outlives the write
 * either way.
 *
 * ONLY A LOST WRITE IS HELD. `onError` also carries the answers the server gave
 * ABOUT the command — a 400 refusal, a 409 the winning run already resolved,
 * and the client machine's own rejection of an `account_established` that is
 * not a defined edge from where this guest stopped. Holding the guest position
 * through one of those would cache a guest's state under an account context and
 * skip the organization, sync and invite tail an account still owes, or replace
 * the run that won a conflict with the stale revision-0 snapshot that lost it.
 * Those settle to the server snapshot, which is the reconciliation the shared
 * hook's invalidate-and-re-read already performs.
 *
 * THE HOLD IS RELEASED BY THE FIRST DETERMINATE ANSWER TO ANY EVENT POSTED
 * THROUGH IT, not only by a success. A lost write is lost precisely because its
 * fate is unknown, so the handoff it carried may well have COMMITTED — the
 * server then owns an attempt this hook never saw, and the reader's next event
 * against the held revision-0 snapshot comes back 409. Releasing only on
 * success would re-post revision 0 for that event and every one after it until
 * the host remounts, so the poster classifies its own failures the same way the
 * handoff does: a determinate answer drops the hold and the record and hands
 * the mount to the re-read the shared hook has already started, and only
 * another lost write keeps the position.
 *
 * THE HOLD BELONGS TO ONE IDENTITY. The desktop host is not keyed by account,
 * so it stays mounted across a sign-out and back in, or an organization switch.
 * A run held for the previous identity would win over the new one's snapshot
 * query and render the prior account's measured onboarding state, composing
 * every later transition from that stale context — so the hold carries the
 * `userId`/`organizationId` the handoff was built under and is both refused at
 * render and dropped outright once they change.
 *
 * Returns `undefined` for every reader with nothing to hand off — no local
 * record, or a handoff already settled — which is the ordinary case and costs
 * those mounts nothing.
 */
export function useGuestGuidedOnboardingHandoff({
  accountMode,
  active,
  analysisStarted,
  onDashboardAvailable,
  organizationId,
  syncConsentRecorded,
  userId,
}: {
  /**
   * PRD-736 `account_mode` (ISS-10913). The handoff posts this device's ONLY
   * `account_established` for a converting guest, so without it that
   * completion carries no auth outcome at all. Taken from the caller, like the
   * identity above, so a host that mounts without an auth adapter cannot
   * silently reduce it to a constant.
   */
  accountMode: OnboardingAccountModes;
  /**
   * Whether an account has SETTLED on this device. The caller supplies it from
   * the authenticated status specifically, not from "not a guest": the states
   * in between own a sign-in that has not produced an account yet, and posting
   * an `account_established` for one would claim a fact nobody has measured.
   */
  active: boolean;
  /** Desktop-local analyzer state; the machine guards on it, so it is passed. */
  analysisStarted: boolean;
  /**
   * Where the shell sends a reader whose run reaches the Dashboard. Only the
   * HELD run posts through this hook, so this is the same wiring
   * `useGuestGuidedOnboardingRun` owns for the local run and the dialog host's
   * own poster owns for the server one; without it a held run that completes
   * would close the dialog onto whatever route the shell happened to be on.
   */
  onDashboardAvailable: () => void;
  /**
   * The organization the settled account is acting in, and the account itself.
   * Together they identify WHOSE run a held position describes; the hook never
   * reads them for anything else, and takes them from the caller rather than
   * from an auth adapter so a host that mounts without one cannot silently
   * reduce the check to a constant.
   */
  organizationId: string | null;
  /** Desktop-local consent record. Unknown never completes setup. */
  syncConsentRecorded: KnownFlag;
  /** See {@link organizationId}. */
  userId: string | null;
}): GuidedOnboardingRun | undefined {
  // Read ONCE, before the handoff can clear it. A live read would return null
  // the moment the write lands and collapse `pending` mid-flight, handing the
  // mount back while the request is still outstanding.
  //
  // Read when an account SETTLES, not at mount (ISS-11480). The host mounts at
  // app start, so a mount-time read handed off the position the guest was at
  // then — a step resumed later in the same session was posted from a stale
  // Dashboard phase and rejected, so the resumed position never reached the
  // server.
  const [capture, setCapture] = useState<RecordCapture | null>(() =>
    active ? { record: readGuestGuidedOnboardingRecord() } : null
  );
  if (active && capture === null) {
    setCapture({
      record: readGuestGuidedOnboardingRecord(),
    });
  }
  const record = capture?.record ?? null;
  const [settled, setSettled] = useState(false);
  // The composed handoff snapshot, kept as this hook's run after a LOST write,
  // under the identity it was built for. Not the cache: see the file docstring
  // for why a seed cannot survive there.
  const [held, setHeld] = useState<HeldHandoff | null>(null);
  const startedRef = useRef(false);
  // The host is not keyed by account, so a sign-out and a later sign-in reach
  // this same mount. Releasing the capture when the account goes lets the next
  // sign-in hand off whatever the guest reached in between.
  useEffect(() => {
    if (!active) {
      setCapture(null);
      setSettled(false);
      startedRef.current = false;
    }
  }, [active]);
  const pending = active && record !== null && !settled;
  const identityKey = identityKeyFor(userId, organizationId);

  // The same query key the host reads, so this shares that request rather than
  // issuing a second one; the host's own read is disabled while a run is
  // supplied, and re-enables against the cache this leaves behind.
  const { data: server } = useGuidedOnboardingSnapshot(OnboardingHost.Desktop, {
    enabled: pending,
  });
  const { mutate } = useGuidedOnboardingTransition({
    analysisStarted,
    experienceVariant: WorkspaceExperience.V2,
    host: OnboardingHost.Desktop,
    syncConsentRecorded,
  });

  // The held run's poster. Posts the reader's next event against the snapshot
  // the host hands back — the composed one, at `revision: 0` — so the accepted
  // transition CREATES the row the lost handoff would have, rather than
  // replaying the handoff command the machine has already moved past.
  const postHeldTransition = useCallback<GuidedOnboardingRun["postTransition"]>(
    (snapshot, event, callbacks) => {
      mutate(
        { analytics: callbacks?.analytics, event, snapshot },
        {
          onSettled: callbacks?.onSettled,
          onSuccess: (next) => {
            // The server owns the run now. Releasing the hold hands the mount
            // back to the host's own read, which resolves against the snapshot
            // the shared hook just wrote for this same key.
            clearGuestGuidedOnboardingRecord();
            setHeld(null);
            if (
              next !== null &&
              restoreOnboardingState(next.state, OnboardingHost.Desktop).state
                .phase === OnboardingPhase.DashboardAvailable
            ) {
              onDashboardAvailable();
            }
          },
          onError: (error) => {
            // A determinate answer to an event posted through the HELD run is
            // the server ruling on the position itself — most often the 409
            // owed to a handoff that committed before its response was lost.
            // Holding past it would post revision 0 again for every later
            // event until remount; the shared hook's `onError` has already
            // invalidated this key, so releasing hands the mount to that
            // re-read. Another lost write decides nothing and keeps the hold.
            if (!isGuidedOnboardingTransportFailure(error)) {
              clearGuestGuidedOnboardingRecord();
              setHeld(null);
            }
          },
        }
      );
    },
    [mutate, onDashboardAvailable]
  );

  useEffect(() => {
    if (record === null || !pending || server === undefined) {
      return;
    }
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    if (server.attemptId !== null) {
      // This account already owns a run. The local record describes a guest
      // this device has finished being, and replaying it over a server position
      // would move the account backwards.
      clearGuestGuidedOnboardingRecord();
      setSettled(true);
      return;
    }
    const bootstrapOrganizationCreated =
      organizationId !== null &&
      record.state.phase === OnboardingPhase.CreateOrganization;
    const command = handoffCommand(
      server,
      record,
      bootstrapOrganizationCreated
    );
    mutate(
      {
        ...command,
        alreadyCaptured:
          bootstrapOrganizationCreated && localRunAdvancedPast(record),
        analytics: { accountMode },
      },
      {
        // Only on success: a failed write leaves the record as the only surviving
        // description of where this guest was.
        onSuccess: () => {
          clearGuestGuidedOnboardingRecord();
          setSettled(true);
        },
        onError: (error) => {
          // ISS-10340. Settling was unconditional, so a failed write handed the
          // mount straight back to the server read — which for this brand-new
          // account is an absent attempt reporting a first run at Welcome, and
          // the guest who just finished Welcome and Session Discovery was shown
          // both again with their record sitting unread on disk.
          //
          // A LOST WRITE keeps the position, as this hook's own run. The composed
          // snapshot is the handoff's own — the guest's stored state under the
          // server's MEASURED context — so this is not the local snapshot the
          // file's docstring refuses to report: nothing here claims
          // `accountStatus: Skipped` about a reader who now has an account. The
          // record is deliberately left on disk: it is what lets a remount
          // re-attempt the handoff outright, and `server.attemptId` going
          // non-null is what clears it above.
          //
          // ANY DETERMINATE ANSWER settles to the server instead. A refusal, a
          // conflict, or the machine's own rejection is the server (or the
          // machine) ruling on this command, and holding a guest position through
          // one of those is the inverse defect — see the file docstring.
          if (isGuidedOnboardingTransportFailure(error)) {
            setHeld({ identityKey, snapshot: command.snapshot });
          }
          setSettled(true);
        },
      }
    );
  }, [
    accountMode,
    identityKey,
    mutate,
    organizationId,
    pending,
    record,
    server,
  ]);

  // Drop a hold the identity has moved past. The render below already refuses
  // to offer it, which is what keeps the prior account's state off the screen
  // on the very render the switch lands; this is what stops it coming back if
  // the reader returns to that identity later, by when the position is staler
  // still and the server owns whatever actually happened.
  useEffect(() => {
    setHeld((current) =>
      current === null || current.identityKey === identityKey ? current : null
    );
  }, [identityKey]);

  if (held !== null && held.identityKey === identityKey) {
    return {
      isLoading: false,
      postTransition: postHeldTransition,
      snapshot: held.snapshot,
    };
  }
  if (!pending) {
    return;
  }
  return {
    isLoading: true,
    postTransition: noTransitionWhileHandingOff,
    snapshot: null,
  };
}

/**
 * The transition command that moves the guest's stored position onto the
 * server: the account's own measured context, carrying the guest's state.
 *
 * `revision` rides along from the server snapshot and is `0` for the absent
 * attempt this is only ever built for, which is the value the transition
 * service requires before it will CREATE a row rather than arbitrate a
 * conflict.
 */
function handoffCommand(
  server: GuidedOnboardingSnapshot,
  record: GuestGuidedOnboardingRecord,
  bootstrapOrganizationCreated: boolean
) {
  return {
    event: bootstrapOrganizationCreated
      ? { type: OnboardingEvent.OrganizationReady }
      : createAccountEstablishedEventForProvider(
          server.context.accountProvider
        ),
    snapshot: { ...server, state: record.state },
  };
}

/**
 * Unreachable, and required by the seam's type.
 *
 * A run reporting `snapshot: null` cannot be posted against: the host's
 * `postCurrentTransition` returns early without a snapshot, and every other
 * caller of the poster is guarded on one. There is nothing for this to do and
 * nothing it could honestly do — the run it would post is the one currently
 * being handed to the server.
 */
function noTransitionWhileHandingOff(): void {
  return;
}

/** Distinguishes a captured `null` record from a record not yet read. */
type RecordCapture = {
  record: GuestGuidedOnboardingRecord | null;
};

/** A held handoff position, tagged with the identity it was composed for. */
type HeldHandoff = {
  identityKey: string;
  snapshot: GuidedOnboardingSnapshot;
};

/**
 * One comparable value for "whose run is this". Both halves participate: an
 * organization switch keeps `userId` and changes the measured context the run
 * is composed against, and a sign-out and back in can land on the same
 * organization as a different member.
 */
function identityKeyFor(
  userId: string | null,
  organizationId: string | null
): string {
  return `${userId ?? ""}\u0000${organizationId ?? ""}`;
}

/**
 * Whether the guest run accepted a transition after `captured` was read. For
 * the bootstrap organization handoff that transition is the guest run's own
 * OrganizationReady: main pushes the authenticated session before the
 * create-organization bridge call returns, so the handoff reads the record
 * still on CreateOrganization, and the guest run then accepts and captures the
 * same step. The handoff carries it to the server without capturing it again
 * (ISS-12423).
 */
function localRunAdvancedPast(captured: GuestGuidedOnboardingRecord): boolean {
  const current = readGuestGuidedOnboardingRecord();
  return current !== null && current.revision > captured.revision;
}
