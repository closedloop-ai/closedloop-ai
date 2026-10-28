"use client";

/**
 * @file use-guided-onboarding.ts
 * @description The client for the server-owned guided onboarding run
 * (PLN-1875 Step 8): the snapshot a host reads and the transition it posts.
 *
 * ISS-8375 shipped the service with no consumer — nothing under `apps/app`,
 * `packages/app`, or `apps/desktop/src` referenced `onboarding/guided` — so
 * every host that wanted the phase had to invent one. This is that one client,
 * in the shared package because both shells need it.
 */

import type { OnboardingStatus } from "@repo/api/src/types/onboarding";
import type { OnboardingEventInput } from "@repo/api/src/types/onboarding-events";
import type {
  GuidedOnboardingSnapshot,
  GuidedOnboardingTransitionRequest,
} from "@repo/api/src/types/onboarding-guided";
import {
  GUIDED_ONBOARDING_SNAPSHOT_PATH,
  GUIDED_ONBOARDING_TRANSITION_PATH,
  guidedOnboardingSnapshotSchema,
} from "@repo/api/src/types/onboarding-guided";
import {
  restoreOnboardingState,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  isBlockingPhase,
  KnownFlag,
  type OnboardingHost,
} from "@repo/api/src/types/onboarding-phase";
import {
  type QueryClient,
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";
import { useOptionalAuthSnapshot } from "../../shared/auth/use-auth-snapshot";
import { mutationToastMeta } from "../../shared/query/query-client";
import {
  isGuidedOnboardingCommandRefusal,
  markGuidedOnboardingEventRefused,
} from "../lib/guided-onboarding-event-support";
import type { OnboardingTransitionAnalyticsOutcome } from "../lib/onboarding-funnel-analytics";
import {
  chooseActiveOrganization,
  organizationActiveFlag,
  transitionOnboarding,
} from "../lib/onboarding-transitions";
import { onboardingKeys } from "./use-onboarding";
import { useOnboardingFunnelAnalytics } from "./use-onboarding-analytics";

/** Matches `useOnboardingStatus`: a run does not change without a transition. */
const SNAPSHOT_STALE_TIME_MS = 5 * 60 * 1000;

export const guidedOnboardingKeys = {
  all: ["onboarding", "guided"] as const,
  /**
   * Namespaced by the identity the snapshot describes AND by the host it was
   * resolved for, for the reason `onboardingKeys.status` is namespaced by user
   * and org: the browser `QueryClient` is a module-level singleton, so an
   * unnamespaced entry answers for the next account in the same tab. The host
   * belongs in the key too — the server resolves a persisted phase against the
   * host that asked (`restoreOnboardingState`), so the same run legitimately
   * reads differently on web and desktop.
   */
  snapshot: (
    host: OnboardingHost,
    orgId: string | null,
    userId: string | null
  ) => [...guidedOnboardingKeys.all, "snapshot", host, orgId, userId] as const,
};

/**
 * Read this caller's guided onboarding run.
 *
 * The body is PARSED, never cast. `apiClient.get<T>` types the envelope's
 * `data` and asserts nothing about it at runtime, and this crosses a deploy
 * boundary — a browser holding yesterday's bundle talks to today's API. A
 * snapshot this build cannot read fails the query rather than reaching a
 * consumer as a half-understood phase, which lands every consumer on the same
 * "no phase" branch they already take while the read is in flight.
 */
export function useGuidedOnboardingSnapshot(
  host: OnboardingHost,
  options?: Omit<
    UseQueryOptions<GuidedOnboardingSnapshot>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();
  const { isLoaded, orgId, userId } = useOptionalAuthSnapshot();

  return useQuery({
    queryKey: guidedOnboardingKeys.snapshot(host, orgId, userId),
    queryFn: async () => {
      const body = await apiClient.get<unknown>(
        `${GUIDED_ONBOARDING_SNAPSHOT_PATH}?host=${encodeURIComponent(host)}`
      );
      return guidedOnboardingSnapshotSchema.parse(body);
    },
    staleTime: SNAPSHOT_STALE_TIME_MS,
    ...options,
    // After the spread, so a caller can narrow the gate but never widen it —
    // the same placement and the same reason as `useOnboardingStatus`. Firing
    // before the shell's identity hydrates caches the signed-in user's run
    // under the shared `userId: null` slot.
    enabled: isLoaded && userId !== null && (options?.enabled ?? true),
  });
}

export type GuidedOnboardingTransitionInput = {
  /** The snapshot this command is composed against; supplies the revision. */
  snapshot: GuidedOnboardingSnapshot;
  event: OnboardingEventInput;
  /**
   * Host-supplied step-outcome facts for the PRD-736 funnel events — the
   * counts the machine cannot see (e.g. how many invitations were sent).
   */
  analytics?: OnboardingTransitionAnalyticsOutcome;
  /**
   * The caller's own local run already accepted THIS transition and captured
   * it there; this command only carries it to the server, so it is posted
   * without a second capture (ISS-12423, PRD-793 AC-001.4).
   */
  alreadyCaptured?: boolean;
};

/**
 * Post one accepted transition, and write the run the server answers with back
 * into the snapshot cache.
 *
 * The machine runs HERE, before the request, because the endpoint's contract is
 * "the state the client's machine produced" — the server validates the state it
 * is handed rather than deriving one. An event the machine rejects from this
 * phase is never sent: a rejected command is a stale read or a caller bug, and
 * posting it would spend a revision on a 400.
 */
export function useGuidedOnboardingTransition({
  analysisStarted,
  experienceVariant,
  host,
  syncConsentRecorded = KnownFlag.Unknown,
}: {
  /**
   * Whether local analysis has begun. Deliberately the CALLER's to state: the
   * snapshot omits it because the server cannot see it (it is desktop-local
   * analyzer state), so a hook that defaulted it would put the same invented
   * `false` on the wire that the wire contract exists to keep off it.
   */
  analysisStarted: boolean;
  /** Desktop-local sync-consent recovery fact. Unknown never completes setup. */
  syncConsentRecorded?: KnownFlag;
  /**
   * The experience variant this host is running. Persisted on CREATE only, so
   * for a run already in flight the server keeps the variant it started with —
   * this value is what stamps a run the transition itself creates.
   */
  experienceVariant: string;
  host: OnboardingHost;
}) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const auth = useOptionalAuthSnapshot();
  const { orgId, userId } = auth;
  const { captureTransition } = useOnboardingFunnelAnalytics(host);

  return useMutation({
    mutationFn: async ({
      alreadyCaptured = false,
      analytics,
      event,
      snapshot,
    }: GuidedOnboardingTransitionInput) => {
      const organizationActive = organizationActiveFlag(auth);
      const priorState = chooseActiveOrganization(
        restoreOnboardingState(snapshot.state, host).state,
        organizationActive
      );
      const context = {
        ...snapshot.context,
        analysisStarted,
        host,
        organizationActive,
        syncConsentRecorded,
      };
      const result = transitionOnboarding(priorState, event, context);
      if (result.status === "rejected") {
        throw new Error(
          `Guided onboarding rejected ${event.type}: ${result.reason}`
        );
      }
      // PRD-736 (ISS-10500): the funnel is instrumented at THIS one site — the
      // machine's acceptance — so events cannot drift from the product flow. A
      // later server 409 re-reads the run; analytics stays a best-effort record
      // of what the user did, not of what persisted.
      if (!alreadyCaptured) {
        captureTransition({
          context,
          event,
          nextState: result.state,
          outcome: analytics,
          priorState,
        });
      }
      const command: GuidedOnboardingTransitionRequest = {
        // Minted per call, and mutations here do not auto-retry, so one call is
        // exactly one command. Re-delivering the SAME id is what the server
        // treats as a no-op; a fresh id per attempt would not be.
        commandId: globalThis.crypto.randomUUID(),
        event,
        experienceVariant: snapshot.experienceVariant ?? experienceVariant,
        host,
        revision: snapshot.revision,
        state: serializeOnboardingState(result.state),
      };
      const body = await apiClient.post<unknown>(
        GUIDED_ONBOARDING_TRANSITION_PATH,
        command
      );
      return body === null ? null : guidedOnboardingSnapshotSchema.parse(body);
    },
    /**
     * A failed transition is SILENT, and this is where that is decided.
     *
     * The shared client toasts every unhandled mutation failure, and this one is
     * bookkeeping the reader never asked for — `finish_tour` posts on the beat
     * they press Done. The generic "Operation failed · The operation did not
     * complete" names nothing they did and offers nothing they can retry, in
     * their first hour in the product, and a stale revision across two tabs is
     * enough to reach it.
     *
     * What is silenced, stated once: the run does not advance, so the tour is
     * offered again on the next visit. That is the honest degradation of a lost
     * write — the reader is never told the tour was recorded when it was not.
     */
    meta: mutationToastMeta({ suppressDefaultErrorToast: true }),
    // Snapshot the identity at CALL time: mutation callbacks are refreshed on
    // every render, so a success handler reading the live snapshot would write
    // the response under whichever identity is active at RESOLVE time.
    onMutate: () => ({ orgId, userId }),
    /**
     * A failed transition RE-READS the run, which is the half of stale-revision
     * reconciliation this step owes.
     *
     * The failure that matters is the 409: the server has already moved past
     * the revision this command was composed against. Leaving the cache alone
     * left the superseded record fresh for the whole {@link
     * SNAPSHOT_STALE_TIME_MS} window, so an SPA return read `dashboard_tour`
     * straight back out of it and offered the tour again — and every retry in
     * that window was composed against the same dead revision.
     *
     * Invalidating rather than adopting the snapshot that 409 carries: the
     * conflict body's `data` is `null` whenever the server could not compose
     * one, so a re-read is the fallback either way, and parsing a payload
     * inside an error handler buys a second way to fail for no recovery the
     * re-read does not already give. Unconditional, because a 500 or a dropped
     * connection says nothing about the run either, and a cached revision the
     * client cannot trust is exactly what this is here to drop.
     *
     * A RE-READ IS NOT ENOUGH WHEN THE API REFUSED THE COMMAND ITSELF. The run
     * comes back UNCHANGED from a 400, so a caller that arms off the phase arms
     * again on the next visit and posts the same doomed command — which is what
     * a client one deploy ahead of the API does with `defer_tour`. The refusal
     * is recorded so that caller can stop; see
     * `guided-onboarding-event-support.ts` for why a 400 is the only status
     * worth recording.
     */
    onError: (error, input, context) => {
      if (isGuidedOnboardingCommandRefusal(error)) {
        markGuidedOnboardingEventRefused(input.event.type);
      }
      queryClient.invalidateQueries({
        queryKey: guidedOnboardingKeys.snapshot(
          host,
          context?.orgId ?? orgId,
          context?.userId ?? userId
        ),
      });
    },
    onSuccess: (snapshot, _input, context) => {
      const key = guidedOnboardingKeys.snapshot(
        host,
        context.orgId,
        context.userId
      );
      if (snapshot === null) {
        // The write settled durably and the server then failed to compose the
        // result. That is "nothing was measured", not "the run is now false", so
        // nothing is written into the cache and the next read comes from the
        // server.
        queryClient.invalidateQueries({ queryKey: key });
        return;
      }
      queryClient.setQueryData(key, snapshot);
      resetStatusLeftIncomplete(queryClient, host, snapshot, context);
    },
  });
}

/**
 * A run that has just left its blocking takeover is complete for
 * `/onboarding/status` too (ISS-10988), but a status read cached before its last
 * step still says `wizardCompleted: false` — and `OnboardingGuard` routes the
 * Dashboard handoff that follows on that cached answer, straight back to
 * `/onboarding`. Reset, not invalidate: an invalidated query keeps serving the
 * stale answer while it refetches, and the guard redirects on it; a reset one
 * has no answer until the server's lands. Runs before the per-call `onSuccess`
 * that performs the handoff.
 */
function resetStatusLeftIncomplete(
  queryClient: QueryClient,
  host: OnboardingHost,
  snapshot: GuidedOnboardingSnapshot,
  identity: { orgId: string | null; userId: string | null }
) {
  if (
    isBlockingPhase(restoreOnboardingState(snapshot.state, host).state.phase)
  ) {
    return;
  }
  const statusKey = onboardingKeys.status(identity.orgId, identity.userId);
  if (
    queryClient.getQueryData<OnboardingStatus>(statusKey)?.wizardCompleted !==
    false
  ) {
    return;
  }
  queryClient.resetQueries({ queryKey: statusKey });
}
