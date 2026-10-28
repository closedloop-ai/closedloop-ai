/**
 * ISS-8349 review (T2/T6). A shape-valid, host-valid persisted state can still
 * be one no run of the machine could produce, and restoring such a state walks
 * the user past the blocking setup it claims to be finished with.
 *
 * The constants in `onboarding-reachability.ts` describe the machine in
 * `onboarding-transitions.ts`, and this file is what stops them drifting from
 * it: `derives every edge...` sweeps every phase, event, and context
 * combination and fails if the written-down graph disagrees with the machine,
 * and `accepts every state...` walks the machine from its initial state and
 * fails if the predicate would reject a run that genuinely happened.
 */

import {
  OnboardingEvent,
  type OnboardingEventInput,
} from "@repo/api/src/types/onboarding-events";
import {
  ONBOARDING_STATE_VERSION,
  OnboardingRestoreOutcome,
  restoreOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  createInitialOnboardingState,
  KnownFlag,
  type OnboardingContext,
  OnboardingHost,
  type OnboardingMachineState,
  OnboardingPhase,
  OrganizationMembership,
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import {
  isReachableOnboardingState,
  ONBOARDING_HISTORY_ROOTS,
  PHASE_EDGES,
} from "@repo/api/src/types/onboarding-reachability";
import { describe, expect, it } from "vitest";
import { transitionOnboarding } from "../onboarding-transitions";

const ALL_PHASES: readonly OnboardingPhase[] = Object.values(OnboardingPhase);

/**
 * The `organizationActive` values each membership can hold. An existing member
 * is in the organization by definition, so only a first user is ever without
 * one (ISS-11090).
 */
const ACTIVE_ORGANIZATION_BY_MEMBERSHIP: Record<
  OrganizationMembership,
  readonly KnownFlag[]
> = {
  [OrganizationMembership.FirstUser]: [KnownFlag.Yes, KnownFlag.No],
  [OrganizationMembership.ExistingMember]: [KnownFlag.Yes],
};

/** Every context the guards can distinguish. */
function everyContext(): readonly OnboardingContext[] {
  const contexts: OnboardingContext[] = [];
  for (const host of Object.values(OnboardingHost)) {
    for (const membership of Object.values(OrganizationMembership)) {
      for (const accountStatus of Object.values(AccountStatus)) {
        for (const accountProvider of [
          ...Object.values(AccountProvider),
          null,
        ]) {
          for (const githubConnected of [true, false]) {
            for (const desktopAppDownloaded of [true, false]) {
              for (const organizationHasSyncedSessionData of Object.values(
                KnownFlag
              )) {
                for (const teamInvited of [true, false]) {
                  for (const analysisStarted of [true, false]) {
                    for (const tourCompleted of [true, false]) {
                      for (const syncConsentRecorded of Object.values(
                        KnownFlag
                      )) {
                        for (const organizationActive of ACTIVE_ORGANIZATION_BY_MEMBERSHIP[
                          membership
                        ]) {
                          contexts.push({
                            host,
                            membership,
                            accountStatus,
                            accountProvider,
                            githubConnected,
                            desktopAppDownloaded,
                            organizationHasSyncedSessionData,
                            teamInvited,
                            analysisStarted,
                            tourCompleted,
                            syncConsentRecorded,
                            organizationActive,
                          });
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return contexts;
}

/** Every dispatchable event, including one per payload variant. */
function everyEvent(): readonly OnboardingEventInput[] {
  const events: OnboardingEventInput[] = [];
  for (const type of Object.values(OnboardingEvent)) {
    if (type === OnboardingEvent.AccountEstablished) {
      for (const provider of Object.values(AccountProvider)) {
        events.push({ type, provider });
      }
    } else if (type === OnboardingEvent.ResumePendingStep) {
      for (const step of Object.values(PendingOnboardingStep)) {
        events.push({ type, step });
      }
    } else {
      events.push({ type });
    }
  }
  return events;
}

const CONTEXTS = everyContext();
const EVENTS = everyEvent();

function stateKey(state: OnboardingMachineState): string {
  return [
    state.phase,
    state.history.join(","),
    state.accountProvider,
    state.resuming,
    state.organizationEstablished,
  ].join("|");
}

describe("the reachability graph matches the machine", () => {
  it("derives every edge and root the machine can take", () => {
    const edges = new Map<OnboardingPhase, Set<OnboardingPhase>>(
      ALL_PHASES.map((phase) => [phase, new Set<OnboardingPhase>()])
    );
    // A fresh run starts here; every other root has to be produced by a
    // transition that rewrites history rather than appending to it.
    const roots = new Set<OnboardingPhase>([
      createInitialOnboardingState().phase,
    ]);

    for (const phase of ALL_PHASES) {
      for (const resuming of [true, false]) {
        for (const organizationEstablished of [true, false]) {
          const from: OnboardingMachineState = {
            phase,
            history: [],
            accountProvider: null,
            resuming,
            organizationEstablished,
          };
          for (const event of EVENTS) {
            for (const context of CONTEXTS) {
              const result = transitionOnboarding(from, event, context);
              if (result.status !== "moved") {
                continue;
              }
              const { history, phase: destination } = result.state;
              if (history.length === 1 && history[0] === phase) {
                edges.get(phase)?.add(destination);
                continue;
              }
              if (history.length === 0) {
                continue;
              }
              // History was rewritten, not appended: its head is a root and the
              // whole rewritten chain is a set of edges in its own right.
              const head = history[0];
              if (head !== undefined) {
                roots.add(head);
              }
              let previous = head;
              for (const step of history.slice(1)) {
                if (previous !== undefined) {
                  edges.get(previous)?.add(step);
                }
                previous = step;
              }
              if (previous !== undefined) {
                edges.get(previous)?.add(destination);
              }
            }
          }
        }
      }
    }

    const derived: Record<string, readonly OnboardingPhase[]> = {};
    for (const [phase, destinations] of edges) {
      derived[phase] = [...destinations].sort();
    }
    const written: Record<string, readonly OnboardingPhase[]> = {};
    for (const phase of ALL_PHASES) {
      written[phase] = [...PHASE_EDGES[phase]].sort();
    }

    expect(derived).toEqual(written);
    expect([...roots].sort()).toEqual([...ONBOARDING_HISTORY_ROOTS].sort());
  }, 120_000);

  it("accepts every state a real walk of the machine can reach", () => {
    // Bounded so the walk terminates: history grows without limit through the
    // Dashboard/resume cycle, and seven is well past the longest real run.
    const maxHistory = 7;
    const seen = new Set<string>();
    const initial = createInitialOnboardingState();
    const queue: OnboardingMachineState[] = [initial];
    seen.add(stateKey(initial));
    const rejected: string[] = [];

    while (queue.length > 0) {
      const state = queue.pop();
      if (!state) {
        break;
      }
      if (!isReachableOnboardingState(state)) {
        rejected.push(stateKey(state));
      }
      if (state.history.length >= maxHistory) {
        continue;
      }
      for (const event of EVENTS) {
        for (const context of CONTEXTS) {
          const result = transitionOnboarding(state, event, context);
          if (result.status !== "moved") {
            continue;
          }
          const key = stateKey(result.state);
          if (!seen.has(key)) {
            seen.add(key);
            queue.push(result.state);
          }
        }
      }
    }

    expect(rejected).toEqual([]);
    // Guards the walk itself: a machine that stopped moving would vacuously
    // satisfy the assertion above.
    expect(seen.size).toBeGreaterThan(100);
    // Cap unchanged at ISS-11249. The two SyncPolicy resume edges grow the
    // enumerated set by 3.7% (measured: 1074 states / 38.2s before, 1114 / 42.3s
    // after), so the existing 300s still leaves ~7x headroom and stays a real
    // regression detector. An earlier timeout here was host load, not the graph.
  }, 300_000);
});

describe("impossible but well-typed states", () => {
  it("rejects a non-blocking phase reached with no history at all", () => {
    for (const phase of [
      OnboardingPhase.Ready,
      OnboardingPhase.DashboardTour,
    ]) {
      for (const resuming of [true, false]) {
        expect(
          isReachableOnboardingState({
            phase,
            history: [],
            accountProvider: null,
            resuming,
            organizationEstablished: false,
          })
        ).toBe(false);
      }
    }
  });

  it("rejects a history that skips an edge the machine has no route for", () => {
    expect(
      isReachableOnboardingState({
        // Account never reaches InviteTeam directly; the organization step sits
        // between them on both hosts.
        phase: OnboardingPhase.InviteTeam,
        history: [OnboardingPhase.Welcome, OnboardingPhase.Account],
        accountProvider: null,
        resuming: false,
        organizationEstablished: false,
      })
    ).toBe(false);
  });

  it("rejects a history rooted at a phase no run can start from", () => {
    expect(
      isReachableOnboardingState({
        phase: OnboardingPhase.Ready,
        history: [OnboardingPhase.DashboardTour],
        accountProvider: null,
        resuming: false,
        organizationEstablished: false,
      })
    ).toBe(false);
  });

  it("rejects resuming outside a resumed step", () => {
    // `DashboardTour`, and the choice is load-bearing. ISS-11249 made the sync
    // choice resumable, so the `SyncPolicy` fixture this replaced now describes a
    // legitimate resumed step. The obvious substitute — an organization phase —
    // is WORSE than useless here: `isWalkableChain` rejects it first, because
    // `PHASE_EDGES[DashboardAvailable]` has no organization edge, so `resuming`
    // never reaches the predicate this case is named for and deleting
    // `RESUMABLE_PHASES.includes(...)` leaves it green. `DashboardTour` IS an
    // edge target of `DashboardAvailable` and is not resumable, so this fixture
    // clears the chain check and fails on the `resuming` invariant alone.
    expect(
      isReachableOnboardingState({
        phase: OnboardingPhase.DashboardTour,
        history: [OnboardingPhase.DashboardAvailable],
        accountProvider: null,
        resuming: true,
        organizationEstablished: true,
      })
    ).toBe(false);
    expect(
      isReachableOnboardingState({
        phase: OnboardingPhase.Account,
        history: [OnboardingPhase.Welcome, OnboardingPhase.SessionDiscovery],
        accountProvider: null,
        resuming: true,
        organizationEstablished: false,
      })
    ).toBe(false);
  });

  it("refuses a Desktop chain whose move is in neither edge table", () => {
    expect(
      restoreOnboardingState(
        storedDesktopRun(OnboardingPhase.InviteTeam, [
          OnboardingPhase.Welcome,
          OnboardingPhase.SessionDiscovery,
          OnboardingPhase.Account,
          // Account never moves straight to the sync step in either order.
          OnboardingPhase.SyncPolicy,
        ]),
        OnboardingHost.Desktop
      ).outcome
    ).toBe(OnboardingRestoreOutcome.UnreachableState);
  });

  it("accepts the genuine resumed-step state", () => {
    expect(
      isReachableOnboardingState({
        phase: OnboardingPhase.Account,
        history: [OnboardingPhase.DashboardAvailable],
        accountProvider: null,
        resuming: true,
        organizationEstablished: false,
      })
    ).toBe(true);
  });
});

describe("the ISS-10890 Desktop order", () => {
  it("restores a run paused at the sync step after the organization step", () => {
    expect(
      restoreOnboardingState(
        storedDesktopRun(OnboardingPhase.SyncPolicy, [
          OnboardingPhase.Welcome,
          OnboardingPhase.SessionDiscovery,
          OnboardingPhase.Account,
          OnboardingPhase.CreateOrganization,
        ]),
        OnboardingHost.Desktop
      ).outcome
    ).toBe(OnboardingRestoreOutcome.Restored);
  });

  it("restores a finished run at Ready", () => {
    expect(
      restoreOnboardingState(
        storedDesktopRun(OnboardingPhase.Ready, [
          OnboardingPhase.Welcome,
          OnboardingPhase.SessionDiscovery,
          OnboardingPhase.Account,
          OnboardingPhase.ChooseOrganization,
          OnboardingPhase.SyncPolicy,
          OnboardingPhase.InviteTeam,
          OnboardingPhase.DashboardAvailable,
          OnboardingPhase.DashboardTour,
        ]),
        OnboardingHost.Desktop
      ).outcome
    ).toBe(OnboardingRestoreOutcome.Restored);
  });
});

/**
 * ISS-10624-era Desktop builds (since 2026-09-18) still store and post the
 * sync step right after Welcome, so their runs must keep restoring.
 */
describe("the ISS-10624 Desktop order, from builds already installed", () => {
  it("restores a run paused at the sync step right after Welcome", () => {
    expect(
      restoreOnboardingState(
        storedDesktopRun(OnboardingPhase.SyncPolicy, [OnboardingPhase.Welcome]),
        OnboardingHost.Desktop
      ).outcome
    ).toBe(OnboardingRestoreOutcome.Restored);
  });

  it("restores a run paused at the organization step", () => {
    expect(
      restoreOnboardingState(
        storedDesktopRun(OnboardingPhase.CreateOrganization, [
          OnboardingPhase.Welcome,
          OnboardingPhase.SyncPolicy,
          OnboardingPhase.SessionDiscovery,
          OnboardingPhase.Account,
        ]),
        OnboardingHost.Desktop
      ).outcome
    ).toBe(OnboardingRestoreOutcome.Restored);
  });

  it("restores a finished run at Ready", () => {
    expect(
      restoreOnboardingState(
        storedDesktopRun(OnboardingPhase.Ready, [
          OnboardingPhase.Welcome,
          OnboardingPhase.SyncPolicy,
          OnboardingPhase.SessionDiscovery,
          OnboardingPhase.Account,
          OnboardingPhase.CreateOrganization,
          OnboardingPhase.InviteTeam,
          OnboardingPhase.DashboardAvailable,
          OnboardingPhase.DashboardTour,
        ]),
        OnboardingHost.Desktop
      ).outcome
    ).toBe(OnboardingRestoreOutcome.Restored);
  });
});

function storedDesktopRun(
  phase: OnboardingPhase,
  history: readonly OnboardingPhase[]
) {
  return {
    version: ONBOARDING_STATE_VERSION,
    phase,
    history,
    accountProvider: null,
    resuming: false,
    organizationEstablished: true,
  };
}
