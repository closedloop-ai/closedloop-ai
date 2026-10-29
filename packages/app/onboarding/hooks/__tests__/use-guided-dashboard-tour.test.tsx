/**
 * PLN-1875 Steps 8 and 9 — what the dashboard tour asks the guided-onboarding
 * run, what it refuses to ask, and which of the two exits it records.
 *
 * The gate is the interesting half of Step 8. Only a settled v2 can ever open
 * this tour, so a read issued on any other tree is a request per dashboard visit
 * for an answer nothing could act on — and the program is closed by default, so
 * that is every visit today.
 *
 * Step 9's half is the asymmetry. `tourRequested` is the RUN's trigger and
 * `tourStanding` is what a surface with its own trigger should DO — and the two
 * fail safe in opposite directions, which is why neither is derived from the
 * other. An unread run makes `tourRequested` false, so web stays silent while a
 * read is in flight; the same run makes `tourStanding` `Unread` rather than
 * `Owed`, so desktop's latching arm waits instead of spending its one shot. A
 * run that ANSWERS with no completion record is `Owed`, which is how desktop's
 * legacy and offline branches keep running their own first-launch tour.
 * The two writes are gated on the run alone: a device that already has the tour
 * locally must still be able to tell the server it finished, or the other device
 * would keep offering it forever.
 */

import {
  OnboardingEvent,
  type OnboardingEventInput,
} from "@repo/api/src/types/onboarding-events";
import type { GuidedOnboardingTransitionRequest } from "@repo/api/src/types/onboarding-guided";
import { OnboardingHost } from "@repo/api/src/types/onboarding-phase";
import type { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { DashboardTourStanding } from "../../lib/dashboard-tour-completion";
import { clearGuidedOnboardingEventRefusals } from "../../lib/guided-onboarding-event-support";
import { useGuidedDashboardTour } from "../use-guided-dashboard-tour";
import {
  createGuidedQueryClient,
  createGuidedWrapper,
  dashboardAvailableSnapshot,
  legacyCompleteSnapshot,
  readySnapshot,
  STAMPED_RUN_VARIANT,
  tourSnapshot,
} from "./guided-onboarding.test-helpers";

const mockApiClient = { get: vi.fn(), post: vi.fn() };

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Module-level, so a refusal driven by one case would prime every later one in
  // this worker — green in file order, red run alone.
  clearGuidedOnboardingEventRefusals();
  mockApiClient.get.mockResolvedValue(tourSnapshot());
  mockApiClient.post.mockResolvedValue(null);
});

function renderTour({
  identity,
  localSeen = false,
  queryClient = createGuidedQueryClient(),
}: {
  /**
   * The signed-in identity the tree resolves to. Defaults to a real one;
   * `{ userId: null }` is the signed-out or provider-less tree, which is what
   * `useOptionalAuthSnapshot` falls back to with no auth provider mounted.
   */
  identity?: { isLoaded?: boolean; userId?: string | null };
  localSeen?: boolean;
  queryClient?: QueryClient;
} = {}) {
  const withIdentity = createGuidedWrapper(queryClient, identity);
  const wrapper = ({ children }: { children: ReactNode }) =>
    withIdentity({ children });
  return renderHook(
    () =>
      useGuidedDashboardTour({
        analysisStarted: false,
        host: OnboardingHost.Web,
        localSeen,
      }),
    { wrapper }
  );
}

/** The status the transition route answers for a command it will not accept. */
const REFUSED_STATUS = 400;
/** ...and the one it answers for a command composed against a dead revision. */
const CONFLICT_STATUS = 409;

/** The command the hook posted, for the one write under test. */
function postedCommand(): GuidedOnboardingTransitionRequest {
  const [, command] = mockApiClient.post.mock.calls[0] as [
    string,
    GuidedOnboardingTransitionRequest,
  ];
  return command;
}

/** Every event the hook put on the wire, in order. */
function postedEvents(): OnboardingEventInput[] {
  return mockApiClient.post.mock.calls.map(
    ([, command]) => (command as GuidedOnboardingTransitionRequest).event
  );
}

/**
 * Wait until the mutation cache reports exactly `statuses`.
 *
 * Read off the cache rather than timed: the second write in the skew cases below
 * is only meaningful once the first has FAILED and the refusal has been
 * recorded, and nothing else observable says that has happened yet.
 */
async function waitForSettledMutations(
  queryClient: QueryClient,
  statuses: readonly string[]
): Promise<void> {
  await waitFor(() =>
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.status)
    ).toEqual(statuses)
  );
}

async function callAndSettle(write: () => void): Promise<void> {
  await act(async () => {
    write();
    await Promise.resolve();
  });
}

describe("useGuidedDashboardTour", () => {
  it("owes the tour to a run parked on it", async () => {
    const { result } = renderTour();

    await waitFor(() => expect(result.current.tourRequested).toBe(true));
  });

  it("stops owing the tour once the run records it completed", async () => {
    mockApiClient.get.mockResolvedValue(readySnapshot({ tourCompleted: true }));
    const { result } = renderTour();

    await waitFor(() =>
      expect(result.current.tourStanding).toBe(DashboardTourStanding.Done)
    );
    expect(result.current.tourRequested).toBe(false);
  });

  it("owes nothing to an account whose settled run was never stored", async () => {
    // ISS-9916, and the user-flow half of it. The organization finished
    // onboarding before the guided flow shipped, so the server reports a
    // synthetic settled run with no `OnboardingAttempt` behind it. That is the
    // same resting phase and the same absent completion record as the deferred
    // case below, which is exactly why the phase cannot decide this: without
    // the stored-run distinction the account reaches its dashboard and is
    // handed a six-step spotlight it never asked for.
    mockApiClient.get.mockResolvedValue(legacyCompleteSnapshot());
    const { result } = renderTour();

    // Anchored on a SETTLED read, not on the request having been issued. While
    // the snapshot is in flight `phase` is null and `tourRequested` is false for
    // a reason that has nothing to do with this contract — the assertion below
    // would then hold no matter what the arm does. `Owed` is reachable only once
    // `runRead` is true, so it proves the legacy-complete snapshot landed.
    await waitFor(() =>
      expect(result.current.tourStanding).toBe(DashboardTourStanding.Owed)
    );
    expect(result.current.tourRequested).toBe(false);
  });

  it("still owes the tour to a run that deferred it", async () => {
    // The same resting phase as the case above; only the completion record
    // differs, so nothing but that record can decide this. This is the
    // zero-session reader who reached Ready and is still owed the tour.
    mockApiClient.get.mockResolvedValue(
      readySnapshot({ tourCompleted: false })
    );
    const { result } = renderTour();

    await waitFor(() => expect(result.current.tourRequested).toBe(true));
    expect(result.current.tourStanding).toBe(DashboardTourStanding.Owed);
  });

  it("still owes the tour to a run parked short of it", async () => {
    // The state every production run actually rests in: the blocking flow is
    // finished and nothing posts `dashboard_entered` to route it on. The run is
    // NOT asking — web opens its tour by itself only when the run asks, so it
    // must stay shut until the run routes the reader to it — and it has not
    // completion either, so desktop's own first-launch trigger still owes the
    // tour. Reading "the run is not asking" as done here is what latched that
    // tour off for good. What the run is asking does NOT decide whether a
    // completion from here can be RECORDED; that is
    // `canRecordDashboardTourCompletion`, and conflating the two dropped the
    // desktop write.
    mockApiClient.get.mockResolvedValue(dashboardAvailableSnapshot());
    const { result } = renderTour();

    await waitFor(() =>
      expect(result.current.tourStanding).toBe(DashboardTourStanding.Owed)
    );
    expect(result.current.tourRequested).toBe(false);
  });

  it("has no answer at all while the run is still being read", async () => {
    // The first commit, before the request resolves. `Owed` here would open
    // desktop's tour over a reader the very next commit may report as finished,
    // and `Done` would retire it on a read that has said nothing — so the
    // standing has to be neither until the read lands.
    let pendingRead: ((value: unknown) => void) | undefined;
    mockApiClient.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingRead = resolve;
        })
    );
    const { result } = renderTour();

    expect(result.current.tourStanding).toBe(DashboardTourStanding.Unread);

    // The same read, landed: the standing resolves rather than staying stuck.
    await act(async () => {
      pendingRead?.(readySnapshot({ tourCompleted: true }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(result.current.tourStanding).toBe(DashboardTourStanding.Done)
    );
  });

  it("waits only on a read that was actually issued", async () => {
    // The two situations `isPending` collapses into one value, mounted from the
    // SAME settled-v2 tree with the SAME fixture so nothing but the identity
    // gate separates them. That gate is not this hook's to model:
    // `useGuidedOnboardingSnapshot` ANDs `isLoaded && userId !== null` on top of
    // the `enabled` passed down, so treating this hook's own half as the whole
    // of it left the second arm `Unread` with no request ever issued — a wait on
    // a read that can neither resolve nor fail, which is the shape that latched
    // desktop's arm shut for the life of the install.
    let pendingRead: ((value: unknown) => void) | undefined;
    mockApiClient.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingRead = resolve;
        })
    );

    const inFlight = renderTour();
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
    expect(inFlight.result.current.tourStanding).toBe(
      DashboardTourStanding.Unread
    );

    const signedOut = renderTour({
      identity: { userId: null },
    });

    // Still ONE call across both trees: the second issued none. The call count
    // is what makes the arms distinguishable rather than a shared fixture value
    // — only one of these two has a request that could ever answer, and only
    // that one may wait.
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
    expect(signedOut.result.current.tourStanding).toBe(
      DashboardTourStanding.Owed
    );

    // Settle the in-flight read so the first tree is not torn down mid-request.
    await act(async () => {
      pendingRead?.(readySnapshot({ tourCompleted: true }));
      await Promise.resolve();
    });
  });

  it("is done on a device that has already seen it, whatever the run says", async () => {
    const { result } = renderTour({
      localSeen: true,
    });

    // The RUN is still asking — the same-device record is what ends it here, and
    // asserting both is what tells the two records apart.
    await waitFor(() => expect(result.current.tourRequested).toBe(true));
    expect(result.current.tourStanding).toBe(DashboardTourStanding.Done);
  });

  it("records the tour as finished", async () => {
    mockApiClient.get.mockResolvedValue(
      tourSnapshot({ experienceVariant: STAMPED_RUN_VARIANT })
    );
    const { result } = renderTour();
    await waitFor(() => expect(result.current.tourRequested).toBe(true));

    await act(async () => {
      result.current.finishTour();
      await vi.waitFor(() => expect(mockApiClient.post).toHaveBeenCalled());
    });

    expect(postedCommand().event).toEqual({
      type: OnboardingEvent.FinishTour,
    });
    // The variant the RUN was stamped with wins over the one this host is
    // running: the server persists it on CREATE only, so a command composed
    // against a run already in flight echoes the variant that run started with.
    expect(postedCommand().experienceVariant).toBe(STAMPED_RUN_VARIANT);
  });

  it("records a completion even on a device that already had it locally", async () => {
    // The local flag suppresses SHOWING, never REPORTING. Gating the write on it
    // too would leave a desktop replay unrecorded and web offering the tour for
    // good.
    const { result } = renderTour({
      localSeen: true,
    });
    // Wait on the RUN landing, not on the standing — the local flag makes that
    // `Done` on the first commit, before there is any run to write against.
    await waitFor(() => expect(result.current.tourRequested).toBe(true));
    expect(result.current.tourStanding).toBe(DashboardTourStanding.Done);

    await act(async () => {
      result.current.finishTour();
      await vi.waitFor(() => expect(mockApiClient.post).toHaveBeenCalled());
    });

    expect(postedCommand().event).toEqual({
      type: OnboardingEvent.FinishTour,
    });
  });

  it("records a run that showed nothing as deferred, never as finished", async () => {
    const { result } = renderTour();
    await waitFor(() => expect(result.current.tourRequested).toBe(true));

    await act(async () => {
      result.current.deferTour();
      await vi.waitFor(() => expect(mockApiClient.post).toHaveBeenCalled());
    });

    expect(postedCommand().event).toEqual({ type: OnboardingEvent.DeferTour });
  });

  it("records a completion against a run that had already deferred its tour", async () => {
    // The zero-session reader whose data finally arrived: at rest on Ready, tour
    // still owed, and this is the write that retires it.
    mockApiClient.get.mockResolvedValue(
      readySnapshot({ tourCompleted: false })
    );
    const { result } = renderTour();
    await waitFor(() => expect(result.current.tourRequested).toBe(true));

    await act(async () => {
      result.current.finishTour();
      await vi.waitFor(() => expect(mockApiClient.post).toHaveBeenCalled());
    });

    expect(postedCommand().event).toEqual({
      type: OnboardingEvent.FinishTour,
    });
  });

  it("does not re-defer a run that has already left the tour phase", async () => {
    // Their dashboard is still empty on a later visit. The run already exited
    // the phase, so there is nothing to record — and posting would spend a
    // revision on a command the machine refuses.
    //
    // NOT-POSTING is not the contract, for the same reason the last case in this
    // file states: the machine refuses `defer_tour` from `Ready` a second time
    // downstream, so a `post` assertion alone stays green with the guard gone.
    // What the guard buys is that no mutation RUNS — read off the mutation cache,
    // which records one the instant `mutate` is called. A `defaultOptions`
    // `onError` cannot see it: `useMutation`'s own `onError` overrides the
    // default rather than composing with it, and this hook defines one.
    mockApiClient.get.mockResolvedValue(
      readySnapshot({ tourCompleted: false })
    );
    const queryClient = createGuidedQueryClient();
    const { result } = renderTour({
      queryClient,
    });
    await waitFor(() => expect(result.current.tourRequested).toBe(true));

    await callAndSettle(() => result.current.deferTour());

    expect(mockApiClient.post).not.toHaveBeenCalled();
    expect(queryClient.getMutationCache().getAll()).toEqual([]);
  });

  it("stops re-posting a deferral this API refused outright", async () => {
    // Version skew: `apps/app` and `apps/api` deploy separately, so this build
    // can reach an API whose event schema predates `defer_tour` and rejects it
    // at 400. The re-read that follows returns the run UNCHANGED — still parked
    // on the tour — so the arm fires again on the reader's next visit and posts
    // the same doomed command, forever. That is the trap this step closed,
    // re-entered through skew.
    mockApiClient.post.mockRejectedValue(
      new ApiError("Invalid request body", REFUSED_STATUS)
    );
    const queryClient = createGuidedQueryClient();
    const { result } = renderTour({
      queryClient,
    });
    await waitFor(() => expect(result.current.tourRequested).toBe(true));

    await callAndSettle(() => result.current.deferTour());
    await waitForSettledMutations(queryClient, ["error"]);

    // The same reader, the same still-empty dashboard, one visit later.
    await callAndSettle(() => result.current.deferTour());

    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
    // And it degraded to posting NOTHING, never to the completion: `finish_tour`
    // would retire a tour this reader was never shown, which is the trade the
    // whole step refuses.
    expect(postedEvents()).toEqual([{ type: OnboardingEvent.DeferTour }]);
  });

  it("retries a deferral the API only failed to carry", async () => {
    // The counterfactual, and the status is the ONLY thing that differs from the
    // case above — same event, same run, same fixture. A 409 is a stale revision
    // the client reconciles from and a later attempt can land; latching on it
    // would leave the zero-session reader parked on the tour for the session
    // over a conflict that had already resolved itself.
    mockApiClient.post.mockRejectedValue(
      new ApiError("stale_revision", CONFLICT_STATUS)
    );
    const queryClient = createGuidedQueryClient();
    const { result } = renderTour({
      queryClient,
    });
    await waitFor(() => expect(result.current.tourRequested).toBe(true));

    await callAndSettle(() => result.current.deferTour());
    await waitForSettledMutations(queryClient, ["error"]);

    await callAndSettle(() => result.current.deferTour());

    expect(mockApiClient.post).toHaveBeenCalledTimes(2);
  });

  it("starts no write at all before a run has been read", async () => {
    // The read is in flight on the first commit, and `finishTour` is handed to a
    // component that can call it. NOT-POSTING is not the contract here — a
    // command composed against no run is refused a second time downstream, by
    // the machine, so a `post` assertion alone stays green with the guard gone.
    // What the guard buys is that no mutation RUNS: without it the reader gets
    // the shared client's failed-mutation toast for an action they never took.
    //
    // Read off the mutation cache rather than a `defaultOptions` `onError`, which
    // this hook's own `onError` overrides rather than composes with — so the
    // spy this case used to carry could never have fired either way.
    const queryClient = createGuidedQueryClient();
    let pendingRead: ((value: unknown) => void) | undefined;
    mockApiClient.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingRead = resolve;
        })
    );
    const { result } = renderTour({
      queryClient,
    });

    await callAndSettle(() => result.current.finishTour());

    expect(mockApiClient.post).not.toHaveBeenCalled();
    expect(queryClient.getMutationCache().getAll()).toEqual([]);
    // Settle the in-flight read so the hook is not torn down mid-request.
    await act(() => {
      pendingRead?.(tourSnapshot());
      return Promise.resolve();
    });
  });
});
