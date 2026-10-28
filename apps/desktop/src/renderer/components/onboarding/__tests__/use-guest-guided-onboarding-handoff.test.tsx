/**
 * ISS-10195 follow-up: a guest's guided onboarding run must survive the moment
 * they sign in.
 *
 * The defect these pin: `useGuestGuidedOnboardingRun` goes `undefined` as soon
 * as the account settles, the server has no attempt for a brand-new account, so
 * it answers a first run at Welcome — and the guest who just finished Welcome
 * and Session Discovery is shown both again while their local record sits
 * unread on disk. The fix is a handoff, so what is asserted here is the COMMAND
 * that carries the stored position onto the server, the record lifecycle around
 * it, and — ISS-10340 — what a FAILED handoff leaves the host to read.
 */

import { OnboardingAccountMode } from "@repo/api/src/types/onboarding-analytics";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import { serializeOnboardingState } from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  createInitialOnboardingState,
  KnownFlag,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { ApiError } from "@repo/app/shared/api/api-error";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import { desktopGuestGuidedOnboardingStorageKey } from "../../dashboard/dashboard-storage-keys";
import { useGuestGuidedOnboardingHandoff } from "../use-guest-guided-onboarding-handoff";
import {
  firstRunServerSnapshot,
  ORG_ID,
  seedDashboardRecord,
  seedGuestRecord,
  seedResumedAccountRecord,
  USER_ID,
} from "./guest-guided-onboarding-handoff-fixtures";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  onDashboardAvailable: vi.fn(),
  useGuidedOnboardingSnapshot: vi.fn(),
  useGuidedOnboardingTransition: vi.fn(),
}));

// `importOriginal` so everything else in the module — the query keys, the
// refusal predicates the hook classifies with — stays real; only the two hooks
// this suite drives by hand are stubbed.
vi.mock(
  "@repo/app/onboarding/hooks/use-guided-onboarding",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/onboarding/hooks/use-guided-onboarding")
    >()),
    useGuidedOnboardingSnapshot: mocks.useGuidedOnboardingSnapshot,
    useGuidedOnboardingTransition: mocks.useGuidedOnboardingTransition,
  })
);

vi.mock("@repo/app/shared/auth/use-auth-snapshot", () => ({
  useOptionalAuthSnapshot: () => ({
    getToken: () => Promise.resolve(null),
    isLoaded: true,
    orgId: ORG_ID,
    userId: USER_ID,
  }),
}));

// The production read reaches `globalThis.localStorage` through
// `dashboard-storage-keys`, so the store is stubbed there rather than behind a
// module seam — a seam would let this suite pass against a reader that never
// touches storage at all.
beforeEach(() => {
  stubLocalStorage();
  vi.clearAllMocks();
  mocks.useGuidedOnboardingTransition.mockReturnValue({
    isPending: false,
    mutate: mocks.mutate,
  });
  mocks.useGuidedOnboardingSnapshot.mockReturnValue({
    data: firstRunServerSnapshot(),
    isLoading: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useGuestGuidedOnboardingHandoff", () => {
  it("offers no run and posts nothing when this install was never a guest", () => {
    const { result } = renderHandoff();

    expect(result.current).toBeUndefined();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("offers no run and posts nothing while no account has settled", () => {
    seedGuestRecord();

    const { result } = renderHandoff({ active: false });

    expect(result.current).toBeUndefined();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("holds the mount as restoring while the handoff is in flight", () => {
    seedGuestRecord();

    const { result } = renderHandoff();

    // Not the local snapshot: its context says there is no account, which is no
    // longer true of this reader. `null` is the honest answer, and it keeps the
    // dialog from flashing the Welcome step being handed away.
    expect(result.current?.snapshot).toBeNull();
    expect(result.current?.isLoading).toBe(true);
  });

  it("posts the stored guest position against the server's measured context", () => {
    seedGuestRecord();

    renderHandoff();

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const [command] = mocks.mutate.mock.calls[0];
    // The guest's position, not the server's fresh Welcome — this is the whole
    // regression.
    expect(command.snapshot.state.phase).toBe(OnboardingPhase.Account);
    expect(command.snapshot.state.history).toEqual([
      OnboardingPhase.Welcome,
      OnboardingPhase.SessionDiscovery,
    ]);
    // Revision 0 is what makes the transition service CREATE the row instead of
    // arbitrating a conflict.
    expect(command.snapshot.revision).toBe(0);
    // The context stays the server's measured one.
    expect(command.snapshot.context.accountStatus).toBe(
      AccountStatus.Established
    );
    expect(command.event).toEqual({
      provider: AccountProvider.GitHub,
      type: OnboardingEvent.AccountEstablished,
    });
  });

  /**
   * ISS-11480: the host mounts at app start, long before a guest who resumes
   * the Account step signs in. A mount-time read handed off the Dashboard
   * position instead, which the machine rejects, so the resumed step and the
   * organization tail after it never reached the server.
   */
  it("hands off the position the guest reached by sign-in, not the one at mount", () => {
    seedDashboardRecord();
    const { rerender } = renderHandoff({ active: false });

    seedResumedAccountRecord();
    rerender({ active: true });

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const [command] = mocks.mutate.mock.calls[0];
    expect(command.event.type).toBe(OnboardingEvent.AccountEstablished);
    expect(command.snapshot.state).toMatchObject({
      history: [OnboardingPhase.DashboardAvailable],
      phase: OnboardingPhase.Account,
      resuming: true,
    });
  });

  it("hands off again after a sign-out and a later sign-in on the same mount", () => {
    seedGuestRecord();
    const { rerender } = renderHandoff();
    act(() => {
      settleMutation({ success: true });
    });

    rerender({ active: false });
    seedResumedAccountRecord();
    rerender({ active: true });

    expect(mocks.mutate).toHaveBeenCalledTimes(2);
    const [command] = mocks.mutate.mock.calls[1];
    expect(command.snapshot.state).toMatchObject({
      phase: OnboardingPhase.Account,
      resuming: true,
    });
  });

  it("drops the local record once the server has accepted the run", () => {
    seedGuestRecord();
    const { result, rerender } = renderHandoff();

    act(() => {
      settleMutation({ success: true });
    });
    rerender();

    expect(
      localStorage.getItem(desktopGuestGuidedOnboardingStorageKey)
    ).toBeNull();
    // Source switched: the host re-enables its own server read.
    expect(result.current).toBeUndefined();
  });

  it("keeps the local record when the handoff is lost, and stops retrying", () => {
    seedGuestRecord();
    const { rerender } = renderHandoff();

    act(() => {
      settleMutation({ error: lostWrite() });
    });
    rerender();

    // The only durable description of where this guest was. Dropping it here
    // would turn a recoverable lost write into discarded progress.
    expect(
      localStorage.getItem(desktopGuestGuidedOnboardingStorageKey)
    ).not.toBeNull();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  /**
   * ISS-10340: a failed handoff must not replay steps the guest finished.
   *
   * Settling was unconditional, so the mount was handed back to the server read
   * on failure — and for this brand-new account that read is an absent attempt
   * at Welcome. What these pin is that the guest's POSITION is what the host
   * reads back instead, under the server's measured context, so the next
   * accepted transition still creates the row at `revision: 0`.
   */
  it("leaves the guest's position as the run the host reads when the write is lost", () => {
    seedGuestRecord();
    const { result, rerender } = renderHandoff();

    act(() => {
      settleMutation({ error: lostWrite() });
    });
    rerender();

    const held = result.current?.snapshot;
    // The guest's position, not the server's fresh Welcome — the whole point.
    expect(held?.state.phase).toBe(OnboardingPhase.Account);
    expect(held?.state.history).toEqual([
      OnboardingPhase.Welcome,
      OnboardingPhase.SessionDiscovery,
    ]);
    // Still the server's measured context, so nothing here claims this reader
    // has no account.
    expect(held?.context.accountStatus).toBe(AccountStatus.Established);
    // Revision 0 is what makes the reader's next transition CREATE the row the
    // lost handoff would have.
    expect(held?.revision).toBe(0);
    // Offered as a run, not a loading frame: the dialog renders the step the
    // guest is actually on rather than restoring forever.
    expect(result.current?.isLoading).toBe(false);
  });

  /**
   * ISS-10339 review: `onError` is not only lost writes.
   *
   * A determinate answer — the API refusing the command, a 409 whose winner the
   * shared hook re-reads, or the client machine rejecting an
   * `account_established` that is not an edge from where this guest stopped —
   * is the server (or the machine) ruling on this command. Holding the guest
   * position through one of those caches a guest's state under an account
   * context and skips the organization, sync and invite tail the account still
   * owes, or replaces the run that won a conflict with the one that lost it.
   */
  it.each([
    ["a refusal", () => new ApiError("refused", 400)],
    ["a conflict", () => new ApiError("stale revision", 409)],
    ["the machine's own rejection", () => new Error("rejected")],
  ])("hands the mount back to the server on %s", (_label, makeError) => {
    seedGuestRecord();
    const { result, rerender } = renderHandoff();

    act(() => {
      settleMutation({ error: makeError() });
    });
    rerender();

    expect(result.current).toBeUndefined();
  });

  it("holds nothing when the handoff succeeds", () => {
    seedGuestRecord();
    const { result, rerender } = renderHandoff();

    act(() => {
      settleMutation({ success: true });
    });
    rerender();

    // The server owns the run now and answered with it; re-offering the pre-
    // transition snapshot over that response would move the account backwards.
    expect(result.current).toBeUndefined();
  });

  it("posts the reader's next event against the held position, then releases", () => {
    seedGuestRecord();
    const { result, rerender } = renderHandoff();

    act(() => {
      settleMutation({ error: lostWrite() });
    });
    rerender();

    const held = result.current?.snapshot;
    if (!held) {
      throw new Error("expected a held run");
    }
    act(() => {
      result.current?.postTransition(
        held,
        {
          provider: AccountProvider.GitHub,
          type: OnboardingEvent.AccountEstablished,
        },
        // ISS-10502: the held poster forwards the caller's step-outcome facts
        // to the shared transition hook's capture site.
        { analytics: { invitesSentCount: 3 } }
      );
    });

    expect(mocks.mutate).toHaveBeenCalledTimes(2);
    const [command] = mocks.mutate.mock.calls[1];
    // Against the HELD snapshot at revision 0, so the accepted transition
    // CREATES the row the lost handoff would have.
    expect(command.snapshot.revision).toBe(0);
    expect(command.snapshot.state.phase).toBe(OnboardingPhase.Account);
    expect(command.analytics).toEqual({ invitesSentCount: 3 });

    act(() => {
      mocks.mutate.mock.calls[1][1].onSuccess(serverRunAtDashboard());
    });
    rerender();

    // Released: the host re-enables its own read against the snapshot the
    // shared transition hook just wrote for this key.
    expect(result.current).toBeUndefined();
    expect(
      localStorage.getItem(desktopGuestGuidedOnboardingStorageKey)
    ).toBeNull();
    expect(mocks.onDashboardAvailable).toHaveBeenCalledTimes(1);
  });

  /**
   * ISS-10339 review: a LOST write can still have COMMITTED.
   *
   * The handoff's response was lost, so this mount holds revision 0 — but the
   * server recorded the attempt, and the reader's next event against that held
   * snapshot is answered 409. Releasing only on success re-posts revision 0 for
   * that event and every one after it until the host remounts.
   */
  it("releases the held position once an event finds the server already owns the run", () => {
    seedGuestRecord();
    const { result, rerender } = renderHandoff();

    act(() => {
      settleMutation({ error: lostWrite() });
    });
    rerender();
    const held = result.current?.snapshot;
    if (!held) {
      throw new Error("expected a held run");
    }

    act(() => {
      result.current?.postTransition(held, {
        provider: AccountProvider.GitHub,
        type: OnboardingEvent.AccountEstablished,
      });
    });
    act(() => {
      settleMutation({ error: new ApiError("stale revision", 409) }, 1);
    });
    rerender();

    // Source handed back, so the host's own read resolves against the run the
    // shared hook's invalidate-and-re-read just fetched.
    expect(result.current).toBeUndefined();
    // And the record no longer describes anything: the server owns this
    // position, so a relaunch must not re-attempt the handoff.
    expect(
      localStorage.getItem(desktopGuestGuidedOnboardingStorageKey)
    ).toBeNull();
  });

  it("keeps the held position when an event is lost in transport too", () => {
    seedGuestRecord();
    const { result, rerender } = renderHandoff();

    act(() => {
      settleMutation({ error: lostWrite() });
    });
    rerender();
    const held = result.current?.snapshot;
    if (!held) {
      throw new Error("expected a held run");
    }

    act(() => {
      result.current?.postTransition(held, {
        provider: AccountProvider.GitHub,
        type: OnboardingEvent.AccountEstablished,
      });
    });
    act(() => {
      settleMutation({ error: lostWrite() }, 1);
    });
    rerender();

    // Nothing was decided, so releasing here would hand the mount to the same
    // absent-attempt Welcome this whole path exists to stop replaying.
    expect(result.current?.snapshot?.state.phase).toBe(OnboardingPhase.Account);
    expect(
      localStorage.getItem(desktopGuestGuidedOnboardingStorageKey)
    ).not.toBeNull();
  });

  /**
   * ISS-10339 review: the desktop host is not keyed by account, so it stays
   * mounted across a sign-out and back in and across an organization switch. A
   * hold left from the previous identity wins over the new one's snapshot query
   * and renders the prior account's measured onboarding state.
   */
  it.each([
    ["the organization changes", { organizationId: "org_other" }],
    ["the account changes", { userId: "user_other" }],
  ])("drops the held position when %s underneath it", (_label, switched) => {
    seedGuestRecord();
    const { result, rerender } = renderHandoff();

    act(() => {
      settleMutation({ error: lostWrite() });
    });
    rerender();
    // Positive control on the same locator: the hold IS offered to the identity
    // it was composed for, so the assertion below can only be the switch.
    expect(result.current?.snapshot?.state.phase).toBe(OnboardingPhase.Account);

    rerender(switched);

    expect(result.current).toBeUndefined();
  });

  it("posts nothing when the account already owns a server run", () => {
    seedGuestRecord();
    mocks.useGuidedOnboardingSnapshot.mockReturnValue({
      data: {
        ...firstRunServerSnapshot(),
        attemptId: "attempt-1",
        revision: 4,
      },
      isLoading: false,
    });

    const { result, rerender } = renderHandoff();
    rerender();

    // Replaying a guest record over a run the account already moved through
    // would move it backwards.
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(
      localStorage.getItem(desktopGuestGuidedOnboardingStorageKey)
    ).toBeNull();
    expect(result.current).toBeUndefined();
  });

  it("holds the mount rather than posting before the server read arrives", () => {
    seedGuestRecord();
    mocks.useGuidedOnboardingSnapshot.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    const { result } = renderHandoff();

    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(result.current?.isLoading).toBe(true);
  });
});

function renderHandoff(overrides: HandoffOverrides = {}) {
  return renderHook(
    // Defaulted to the initial overrides so a bare `rerender()` re-renders the
    // same props rather than silently resetting them to this helper's baseline.
    (props: HandoffOverrides = overrides) =>
      useGuestGuidedOnboardingHandoff({
        accountMode: [OnboardingAccountMode.SignedIn],
        active: true,
        analysisStarted: true,
        onDashboardAvailable: mocks.onDashboardAvailable,
        organizationId: ORG_ID,
        syncConsentRecorded: KnownFlag.Yes,
        userId: USER_ID,
        ...props,
      }),
    { initialProps: overrides }
  );
}

type HandoffOverrides = Partial<
  Parameters<typeof useGuestGuidedOnboardingHandoff>[0]
>;

/** Run the callbacks the hook handed `mutate`, the way react-query would. */
function settleMutation(
  {
    error,
    success,
  }: {
    error?: unknown;
    success?: boolean;
  },
  // Which posted command to answer. `0` is the handoff itself; a later index is
  // an event the reader posted through the run this hook held.
  call = 0
): void {
  const [, callbacks] = mocks.mutate.mock.calls[call];
  if (success) {
    callbacks.onSuccess?.();
  } else {
    callbacks.onError?.(error);
  }
  callbacks.onSettled?.();
}

/**
 * A write whose fate nobody knows. `createApiClient` mints a network failure
 * and a client deadline at status 0, which is what makes this — and not a 4xx —
 * the case the guest's position is held through.
 */
function lostWrite(): ApiError {
  return new ApiError("Network error", 0);
}

/** What the server answers once the run reaches the end. */
function serverRunAtDashboard(): GuidedOnboardingSnapshot {
  return {
    ...firstRunServerSnapshot(),
    attemptId: "attempt-1",
    revision: 1,
    state: {
      ...serializeOnboardingState(createInitialOnboardingState()),
      history: [OnboardingPhase.DashboardAvailable, OnboardingPhase.InviteTeam],
      organizationEstablished: true,
      phase: OnboardingPhase.DashboardAvailable,
    },
  };
}

/**
 * ISS-10913. This handoff posts a converting guest's ONLY
 * `account_established`, so `account_mode` has to ride it — otherwise the one
 * desktop completion that matters most carries no auth outcome at all.
 */
describe("account_mode on the handoff (ISS-10913)", () => {
  it("carries the caller's folded auth facts on the handoff command", () => {
    seedGuestRecord();

    renderHandoff({
      accountMode: [
        OnboardingAccountMode.Created,
        OnboardingAccountMode.SignedIn,
      ],
    });

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const [command] = mocks.mutate.mock.calls[0];
    expect(command.analytics).toEqual({
      accountMode: [
        OnboardingAccountMode.Created,
        OnboardingAccountMode.SignedIn,
      ],
    });
  });

  it("carries an unknown fold rather than dropping the property", () => {
    // The version-skew case: an auth state from a gateway that predates the
    // additive field folds to `["unknown"]`, and that still has to be reported.
    seedGuestRecord();

    renderHandoff({ accountMode: [OnboardingAccountMode.Unknown] });

    const [command] = mocks.mutate.mock.calls[0];
    expect(command.analytics).toEqual({
      accountMode: [OnboardingAccountMode.Unknown],
    });
  });
});
