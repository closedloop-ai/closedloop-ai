/**
 * PLN-1875 Step 8 — the guided-onboarding client ISS-8375's service shipped
 * without.
 *
 * The two things worth pinning here are the ones a cast would hide: the snapshot
 * is PARSED, so a body this build cannot read fails the query instead of
 * reaching a host as a half-understood phase; and the transition posts the state
 * the CLIENT's machine produced against the revision it read, which is the whole
 * contract the endpoint validates against.
 */

import { conflictBody } from "@repo/api/src/types/common";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import type { GuidedOnboardingTransitionRequest } from "@repo/api/src/types/onboarding-guided";
import { GUIDED_ONBOARDING_STALE_REVISION_ERROR } from "@repo/api/src/types/onboarding-guided";
import { serializeOnboardingState } from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  OnboardingHost,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import {
  guidedOnboardingKeys,
  useGuidedOnboardingSnapshot,
  useGuidedOnboardingTransition,
} from "../use-guided-onboarding";
import {
  createGuidedQueryClient,
  createGuidedWrapper,
  EXPERIENCE_VARIANT,
  ORG_A,
  STAMPED_RUN_VARIANT,
  tourSnapshot,
  USER_A,
} from "./guided-onboarding.test-helpers";

const mockApiClient = { get: vi.fn(), post: vi.fn() };

/** The machine's refusal, surfaced by the mutation rather than posted. */
const REJECTED_BACK = /rejected back/;

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useGuidedOnboardingSnapshot", () => {
  it("reads the run for the host it was asked about", async () => {
    const queryClient = createGuidedQueryClient();
    mockApiClient.get.mockResolvedValue(tourSnapshot());

    const { result } = renderHook(
      () => useGuidedOnboardingSnapshot(OnboardingHost.Web),
      { wrapper: createGuidedWrapper(queryClient) }
    );

    await waitFor(() =>
      expect(result.current.data?.state.phase).toBe(
        OnboardingPhase.DashboardTour
      )
    );
    // The server resolves a persisted phase against the host that asked, so a
    // request that dropped the host would be answered for the wrong surface.
    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/onboarding/guided/snapshot?host=web"
    );
    // ... and the same run legitimately reads differently per host, so the two
    // answers cannot share one cache slot.
    expect(
      queryClient.getQueryData(
        guidedOnboardingKeys.snapshot(OnboardingHost.Web, ORG_A, USER_A)
      )
    ).toBeDefined();
    expect(
      queryClient.getQueryData(
        guidedOnboardingKeys.snapshot(OnboardingHost.Desktop, ORG_A, USER_A)
      )
    ).toBeUndefined();
  });

  it("fails the read rather than handing over a snapshot it cannot parse", async () => {
    const queryClient = createGuidedQueryClient();
    // A phase this build does not know: the exact shape a browser holding
    // yesterday's bundle meets after a deploy. `apiClient.get<T>` asserts
    // nothing at runtime, so without the parse this reaches a host as a live
    // phase and arms whatever branches on it.
    mockApiClient.get.mockResolvedValue(
      tourSnapshot({
        state: { ...tourSnapshot().state, phase: "reticulating_splines" },
      } as never)
    );

    const { result } = renderHook(
      () => useGuidedOnboardingSnapshot(OnboardingHost.Web),
      { wrapper: createGuidedWrapper(queryClient) }
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it("does not read anything before the shell's identity hydrates", async () => {
    const queryClient = createGuidedQueryClient();

    const { result } = renderHook(
      () => useGuidedOnboardingSnapshot(OnboardingHost.Web),
      {
        wrapper: createGuidedWrapper(queryClient, {
          isLoaded: false,
          orgId: null,
          userId: null,
        }),
      }
    );

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });
});

describe("useGuidedOnboardingTransition", () => {
  function renderTransition(queryClient = createGuidedQueryClient()) {
    const view = renderHook(
      () =>
        useGuidedOnboardingTransition({
          analysisStarted: false,
          experienceVariant: EXPERIENCE_VARIANT,
          host: OnboardingHost.Web,
        }),
      { wrapper: createGuidedWrapper(queryClient) }
    );
    return { queryClient, view };
  }

  it("posts the state its own machine produced, against the revision it read", async () => {
    mockApiClient.post.mockResolvedValue(null);
    const snapshot = tourSnapshot({ experienceVariant: STAMPED_RUN_VARIANT });
    const { view } = renderTransition();

    await act(async () => {
      await view.result.current.mutateAsync({
        event: { type: OnboardingEvent.FinishTour },
        snapshot,
      });
    });

    const [path, command] = mockApiClient.post.mock.calls[0] as [
      string,
      GuidedOnboardingTransitionRequest,
    ];
    expect(path).toBe("/onboarding/guided/transition");
    // Finishing the tour ADVANCES the run to Ready. Echoing the snapshot's own
    // state back would post a command claiming the phase never moved.
    expect(command.state.phase).toBe(OnboardingPhase.Ready);
    expect(command.state.history).toContain(OnboardingPhase.DashboardTour);
    // The compare-and-swap token. A hardcoded `0` here is accepted by the
    // request schema and rejected by the server as stale, on every call.
    expect(command.revision).toBe(snapshot.revision);
    expect(command.event).toEqual({ type: OnboardingEvent.FinishTour });
    expect(command.host).toBe(OnboardingHost.Web);
    // The variant the RUN was stamped with wins over the one this host is
    // running: the server persists it on CREATE only, so a command composed
    // against a run already in flight echoes the variant that run started with.
    expect(command.experienceVariant).toBe(STAMPED_RUN_VARIANT);
  });

  it("stamps a run it creates with the variant this host is running", async () => {
    // The other half of that precedence, and the half nothing else covers: a
    // snapshot with no variant is a run the server has not created yet, so
    // there is nothing to keep and the caller's value is what gets persisted.
    // Falling back to the snapshot's `null` would fail the request schema,
    // which requires a non-empty string.
    mockApiClient.post.mockResolvedValue(null);
    const { view } = renderTransition();

    await act(async () => {
      await view.result.current.mutateAsync({
        event: { type: OnboardingEvent.FinishTour },
        snapshot: tourSnapshot({ experienceVariant: null }),
      });
    });

    const [, command] = mockApiClient.post.mock.calls[0] as [
      string,
      GuidedOnboardingTransitionRequest,
    ];
    expect(command.experienceVariant).toBe(EXPERIENCE_VARIANT);
  });

  it("never posts an event its machine rejects from this phase", async () => {
    // `Back` is refused out of the tour by the machine (a finished run must not
    // walk backwards into setup). Posting it anyway would spend a revision on a
    // command the server answers 400.
    const { view } = renderTransition();

    await act(async () => {
      await expect(
        view.result.current.mutateAsync({
          event: { type: OnboardingEvent.Back },
          snapshot: tourSnapshot(),
        })
      ).rejects.toThrow(REJECTED_BACK);
    });

    expect(mockApiClient.post).not.toHaveBeenCalled();
  });

  it("writes the run the server answered with into the caller's cache", async () => {
    const finished = tourSnapshot({ revision: 8 });
    mockApiClient.post.mockResolvedValue(finished);
    const { queryClient, view } = renderTransition();

    await act(async () => {
      await view.result.current.mutateAsync({
        event: { type: OnboardingEvent.FinishTour },
        snapshot: tourSnapshot(),
      });
    });

    expect(
      queryClient.getQueryData(
        guidedOnboardingKeys.snapshot(OnboardingHost.Web, ORG_A, USER_A)
      )
    ).toEqual(finished);
  });

  it("re-reads rather than caching an answer the server could not compose", async () => {
    // A `null` body means the write settled DURABLY and the snapshot after it
    // could not be built. Writing that null into the cache would present "we
    // measured nothing" as "there is no run", which is the state the endpoint's
    // own contract exists to keep apart.
    mockApiClient.post.mockResolvedValue(null);
    const queryClient = createGuidedQueryClient();
    const key = guidedOnboardingKeys.snapshot(
      OnboardingHost.Web,
      ORG_A,
      USER_A
    );
    queryClient.setQueryData(key, tourSnapshot());
    const { view } = renderTransition(queryClient);

    await act(async () => {
      await view.result.current.mutateAsync({
        event: { type: OnboardingEvent.FinishTour },
        snapshot: tourSnapshot(),
      });
    });

    expect(queryClient.getQueryData(key)).toEqual(tourSnapshot());
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("re-reads the run after a transition the server refused as stale", async () => {
    // A 409 says the server has already moved past the revision this command
    // was composed against. The cached snapshot is the superseded one, and it
    // stays FRESH for the full stale-time window, so an SPA return read
    // `dashboard_tour` straight back out of it and offered the tour again — and
    // every retry in that window carried the same dead revision.
    const superseded = tourSnapshot();
    mockApiClient.post.mockRejectedValue(
      new ApiError(GUIDED_ONBOARDING_STALE_REVISION_ERROR, 409, {
        data: conflictBody(
          GUIDED_ONBOARDING_STALE_REVISION_ERROR,
          tourSnapshot({ revision: 9 })
        ),
      })
    );
    const queryClient = createGuidedQueryClient();
    const key = guidedOnboardingKeys.snapshot(
      OnboardingHost.Web,
      ORG_A,
      USER_A
    );
    queryClient.setQueryData(key, superseded);
    const { view } = renderTransition(queryClient);

    await act(async () => {
      await expect(
        view.result.current.mutateAsync({
          event: { type: OnboardingEvent.FinishTour },
          snapshot: superseded,
        })
      ).rejects.toThrow(GUIDED_ONBOARDING_STALE_REVISION_ERROR);
    });

    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    // Invalidated, not reconciled: the snapshot the 409 carried is deliberately
    // NOT adopted, so the entry still holds the superseded run until the re-read
    // lands. Full stale-revision reconciliation is a later step.
    expect(queryClient.getQueryData(key)).toEqual(superseded);
  });
});

/**
 * ISS-11090 review: `orgId` is null for a signed-in session with no active
 * organization, and ALSO while auth loads, when signed out, and with no auth
 * provider. Only the first is "no organization", and it is the only one that
 * may send a first user to the create step, since that is the step that makes
 * one.
 */
describe("the organization step a first user's account lands on", () => {
  it.each([
    {
      auth: {},
      expected: OnboardingPhase.ChooseOrganization,
      identity: "signed in to an organization",
    },
    {
      auth: { isLoaded: false, orgId: null },
      expected: OnboardingPhase.ChooseOrganization,
      identity: "still loading",
    },
    {
      auth: { orgId: null, userId: null },
      expected: OnboardingPhase.ChooseOrganization,
      identity: "signed out",
    },
    {
      auth: { orgId: null },
      expected: OnboardingPhase.CreateOrganization,
      identity: "signed in with no organization",
    },
  ])("posts $expected for a session $identity", async ({ auth, expected }) => {
    mockApiClient.post.mockResolvedValue(null);
    const { result } = renderHook(
      () =>
        useGuidedOnboardingTransition({
          analysisStarted: false,
          experienceVariant: EXPERIENCE_VARIANT,
          host: OnboardingHost.Web,
        }),
      { wrapper: createGuidedWrapper(createGuidedQueryClient(), auth) }
    );

    await act(async () => {
      await result.current.mutateAsync({
        event: {
          provider: AccountProvider.GitHub,
          type: OnboardingEvent.AccountEstablished,
        },
        snapshot: tourSnapshot({
          state: serializeOnboardingState({
            accountProvider: null,
            history: [OnboardingPhase.Welcome],
            organizationEstablished: false,
            phase: OnboardingPhase.Account,
            resuming: false,
          }),
        }),
      });
    });

    const [, command] = mockApiClient.post.mock.calls[0] as [
      string,
      GuidedOnboardingTransitionRequest,
    ];
    expect(command.state.phase).toBe(expected);
  });
});
