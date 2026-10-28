/**
 * ISS-10195 follow-up: the locally-governed guided onboarding run a signed-out
 * guest gets, because the server cannot answer for one.
 *
 * The folds under test are the ones that decide whether the modal is reachable
 * at all. An absent or unreadable record must mean NO RUN YET and never
 * "already finished" — the second would hide the modal from exactly the reader
 * this exists to reach, and would do it silently.
 */

import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import { restoreOnboardingState } from "@repo/api/src/types/onboarding-persistence";
import {
  AccountStatus,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import { isReachableOnboardingState } from "@repo/api/src/types/onboarding-reachability";
import {
  Surface,
  type SurfaceAnalyticsCapture,
} from "@repo/api/src/types/surface-analytics";
import { resetOnboardingFlowSessionForTests } from "@repo/app/onboarding/lib/onboarding-flow-session";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
  desktopGuestGuidedOnboardingStorageKey,
} from "../../dashboard/dashboard-storage-keys";
import { useGuestGuidedOnboardingRun } from "../use-guest-guided-onboarding-run";

// The production read reaches `globalThis.localStorage` through
// `dashboard-storage-keys`, so the store is stubbed there rather than behind a
// module seam — a seam would let this suite pass against a reader that never
// touches storage at all. Same reasoning as `guest-tour-record.test.ts`.
beforeEach(() => {
  stubLocalStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useGuestGuidedOnboardingRun", () => {
  it("offers no run when the reader is not a settled guest", () => {
    const { result } = renderRun({ active: false });

    expect(result.current).toBeUndefined();
  });

  it("starts a guest with no record at Welcome", () => {
    const { result } = renderRun();

    expect(phaseOf(result.current)).toBe(OnboardingPhase.Welcome);
    expect(result.current?.snapshot?.revision).toBe(0);
    expect(result.current?.snapshot?.attemptId).toBeNull();
    expect(result.current?.isLoading).toBe(false);
  });

  it("reports the guest's own unknowns rather than inventing measurements", () => {
    const { result } = renderRun();
    const context = result.current?.snapshot?.context;

    // `Unknown` never grants a skip; a `false` here would assert a measurement
    // nobody took, which is what the snapshot service refuses to do.
    expect(context?.organizationHasSyncedSessionData).toBe(KnownFlag.Unknown);
    expect(context?.githubConnected).toBe(false);
    // Directly observable: this code is executing inside the desktop app.
    expect(context?.desktopAppDownloaded).toBe(true);
    // ISS-11480: the account is outstanding, which is what lets it be resumed.
    expect(context?.accountStatus).toBe(AccountStatus.Skipped);
  });

  it("carries the install's own tour record into the run", () => {
    localStorage.setItem(dashboardTourSeenStorageKey, "1");

    const { result } = renderRun();

    expect(result.current?.snapshot?.context.tourCompleted).toBe(true);
  });

  it("resumes the phase a stored record left off at", () => {
    seedRecord(OnboardingPhase.SessionDiscovery, [OnboardingPhase.Welcome], 3);

    const { result } = renderRun();

    expect(phaseOf(result.current)).toBe(OnboardingPhase.SessionDiscovery);
    expect(result.current?.snapshot?.revision).toBe(3);
  });

  it("folds an unreadable record to a first run, never to a finished one", () => {
    localStorage.setItem(desktopGuestGuidedOnboardingStorageKey, "{not json");

    const { result } = renderRun();

    expect(phaseOf(result.current)).toBe(OnboardingPhase.Welcome);
  });

  it("advances and persists an accepted transition", () => {
    const { result } = renderRun();
    const snapshot = result.current?.snapshot;

    act(() => {
      result.current?.postTransition(snapshot!, {
        type: OnboardingEvent.Start,
      });
    });

    expect(phaseOf(result.current)).toBe(OnboardingPhase.SessionDiscovery);
    expect(result.current?.snapshot?.revision).toBe(1);
    expect(
      localStorage.getItem(desktopGuestGuidedOnboardingStorageKey)
    ).toContain(OnboardingPhase.SessionDiscovery);
  });

  it("leaves the run untouched when the machine rejects the event", () => {
    const { result } = renderRun();
    const snapshot = result.current?.snapshot;

    act(() => {
      // Not allowed from Welcome; the machine rejects it.
      result.current?.postTransition(snapshot!, {
        type: OnboardingEvent.ContinueFromDiscovery,
      });
    });

    expect(phaseOf(result.current)).toBe(OnboardingPhase.Welcome);
    expect(result.current?.snapshot?.revision).toBe(0);
    expect(
      localStorage.getItem(desktopGuestGuidedOnboardingStorageKey)
    ).toBeNull();
  });

  // ISS-10502 (PRD-736 D4): a guest transition never reaches the server
  // poster's capture site, so the guest run must capture at its own acceptance.
  it("captures the funnel events for an accepted guest transition, carrying the outcome", () => {
    resetOnboardingFlowSessionForTests();
    const capture = vi.fn<SurfaceAnalyticsCapture>();
    seedRecord(OnboardingPhase.SessionDiscovery, [OnboardingPhase.Welcome], 2);
    const { result } = renderRun({}, capture);

    act(() => {
      result.current?.postTransition(
        result.current.snapshot!,
        { type: OnboardingEvent.ContinueFromDiscovery },
        { analytics: { harnessesDetectedCount: 1, sessionsFoundCount: 7 } }
      );
    });

    const completed = capture.mock.calls.filter(
      ([event]) => event === OnboardingAnalyticsEvent.StepCompleted
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]?.[1]).toMatchObject({
      [OnboardingAnalyticsProperty.Step]: OnboardingPhase.SessionDiscovery,
      [OnboardingAnalyticsProperty.SessionsFoundCount]: 7,
      [OnboardingAnalyticsProperty.HarnessesDetectedCount]: 1,
    });
    expect(
      capture.mock.calls.filter(
        ([event]) => event === OnboardingAnalyticsEvent.StepViewed
      )
    ).toHaveLength(1);
    resetOnboardingFlowSessionForTests();
  });

  it("captures nothing for a rejected guest transition", () => {
    resetOnboardingFlowSessionForTests();
    const capture = vi.fn<SurfaceAnalyticsCapture>();
    const { result } = renderRun({}, capture);

    act(() => {
      // Not allowed from Welcome; the machine rejects it.
      result.current?.postTransition(result.current.snapshot!, {
        type: OnboardingEvent.ContinueFromDiscovery,
      });
    });

    expect(capture).not.toHaveBeenCalled();
    resetOnboardingFlowSessionForTests();
  });

  describe("a guest this install has already onboarded (ISS-11480)", () => {
    beforeEach(() => {
      localStorage.setItem(dashboardOnboardedStorageKey, "1");
    });

    it("hands a returning guest with no record the closed dashboard, unpersisted", () => {
      const { result } = renderRun();

      // ISS-10195: never a Welcome takeover for a returning install.
      expect(phaseOf(result.current)).toBe(OnboardingPhase.DashboardAvailable);
      expect(result.current?.snapshot?.revision).toBe(0);
      expect(
        localStorage.getItem(desktopGuestGuidedOnboardingStorageKey)
      ).toBeNull();
    });

    it("restores a returning guest's stored record as it is", () => {
      seedRecord(
        OnboardingPhase.DashboardTour,
        [OnboardingPhase.DashboardAvailable],
        4
      );

      const { result } = renderRun();

      expect(phaseOf(result.current)).toBe(OnboardingPhase.DashboardTour);
      expect(result.current?.snapshot?.revision).toBe(4);
    });

    it.each([
      ["no record", () => undefined],
      [
        "a record parked on the tour",
        () =>
          seedRecord(
            OnboardingPhase.DashboardTour,
            [OnboardingPhase.DashboardAvailable],
            3
          ),
      ],
    ])("resumes the account step from %s", (_label, seed) => {
      seed();
      const { result } = renderRun();
      const before = result.current?.snapshot?.revision ?? 0;

      act(() => {
        result.current?.postTransition(result.current.snapshot!, {
          step: PendingOnboardingStep.CreateAccount,
          type: OnboardingEvent.ResumePendingStep,
        });
      });

      const state = stateOf(result.current);
      expect(state).toMatchObject({
        history: [OnboardingPhase.DashboardAvailable],
        phase: OnboardingPhase.Account,
        resuming: true,
      });
      expect(state && isReachableOnboardingState(state)).toBe(true);
      // One accepted transition, one write: the fold is not persisted.
      expect(result.current?.snapshot?.revision).toBe(before + 1);
      expect(
        localStorage.getItem(desktopGuestGuidedOnboardingStorageKey)
      ).toContain(`"resuming":true`);
    });

    it("moves the synthesized record on the host's own dashboard entry without a funnel event", () => {
      resetOnboardingFlowSessionForTests();
      const capture = vi.fn<SurfaceAnalyticsCapture>();
      const { result } = renderRun({}, capture);

      act(() => {
        result.current?.postTransition(result.current.snapshot!, {
          type: OnboardingEvent.DashboardEntered,
        });
      });

      expect(phaseOf(result.current)).toBe(OnboardingPhase.DashboardTour);
      expect(capture).not.toHaveBeenCalled();
      resetOnboardingFlowSessionForTests();
    });

    it("reads the tour record at the transition, not at mount", () => {
      const { result } = renderRun();
      // The run sits on the non-blocking Dashboard, so the tour can finish
      // after this mount read the record.
      localStorage.setItem(dashboardTourSeenStorageKey, "1");

      act(() => {
        result.current?.postTransition(result.current.snapshot!, {
          type: OnboardingEvent.DashboardEntered,
        });
      });

      expect(phaseOf(result.current)).toBe(OnboardingPhase.Ready);
    });

    it("captures the resume alone, never the edges folded ahead of it", () => {
      resetOnboardingFlowSessionForTests();
      const capture = vi.fn<SurfaceAnalyticsCapture>();
      const { result } = renderRun({}, capture);

      act(() => {
        result.current?.postTransition(result.current.snapshot!, {
          step: PendingOnboardingStep.CreateAccount,
          type: OnboardingEvent.ResumePendingStep,
        });
      });

      const steps = capture.mock.calls.map(
        ([event, properties]) =>
          `${event}:${String(properties?.[OnboardingAnalyticsProperty.Step])}`
      );
      expect(steps).toEqual([
        `${OnboardingAnalyticsEvent.StepViewed}:${OnboardingPhase.Account}`,
      ]);
      resetOnboardingFlowSessionForTests();
    });
  });

  it("offers no run when the store cannot answer whether this is a first run", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      removeItem: () => undefined,
      setItem: () => undefined,
    });

    const { result } = renderRun();

    expect(result.current).toBeUndefined();
  });

  it("hands off to the dashboard when the run reaches it", () => {
    const onDashboardAvailable = vi.fn();
    seedRecord(
      OnboardingPhase.Account,
      [OnboardingPhase.Welcome, OnboardingPhase.SessionDiscovery],
      2
    );
    const { result } = renderRun({ onDashboardAvailable });

    act(() => {
      // Desktop-only, and the guest's exit without an account.
      result.current?.postTransition(result.current.snapshot!, {
        type: OnboardingEvent.SkipAccount,
      });
    });

    expect(phaseOf(result.current)).toBe(OnboardingPhase.DashboardAvailable);
    expect(onDashboardAvailable).toHaveBeenCalledTimes(1);
  });
});

function renderRun(
  overrides: Partial<Parameters<typeof useGuestGuidedOnboardingRun>[0]> = {},
  capture?: SurfaceAnalyticsCapture
) {
  return renderHook(
    () =>
      useGuestGuidedOnboardingRun({
        active: true,
        analysisStarted: true,
        onDashboardAvailable: vi.fn(),
        syncConsentRecorded: KnownFlag.Yes,
        ...overrides,
      }),
    capture === undefined
      ? undefined
      : {
          wrapper: ({ children }) => (
            <SurfaceAnalyticsProvider
              capture={capture}
              surface={Surface.Desktop}
            >
              {children}
            </SurfaceAnalyticsProvider>
          ),
        }
  );
}

function phaseOf(
  run: ReturnType<typeof useGuestGuidedOnboardingRun>
): OnboardingPhase | undefined {
  return stateOf(run)?.phase;
}

function stateOf(run: ReturnType<typeof useGuestGuidedOnboardingRun>) {
  const state = run?.snapshot?.state;
  if (!state) {
    return;
  }
  return restoreOnboardingState(state, OnboardingHost.Desktop).state;
}

function seedRecord(
  phase: OnboardingPhase,
  history: OnboardingPhase[],
  revision: number
): void {
  localStorage.setItem(
    desktopGuestGuidedOnboardingStorageKey,
    JSON.stringify({
      revision,
      state: {
        accountProvider: null,
        history,
        organizationEstablished: false,
        phase,
        resuming: false,
        version: 1,
      },
    })
  );
}
