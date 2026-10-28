/**
 * Serialization round-trip and the version-skew recovery contract.
 *
 * The load-bearing assertion in every failure case is that recovery lands on
 * Welcome — never on a completed phase. A failed read must not hand a user a
 * Dashboard they did not earn.
 *
 * The ONE exception, and it earns the Dashboard from the payload rather than
 * being trusted with it: a state the machine can only have produced by RESUMING
 * a step carries proof that the run already reached the Dashboard, so a host
 * that cannot render that step recovers to the settled run instead of a fresh
 * one. `cross-host recovery` below pins both halves.
 */

import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STATE_VERSION,
  OnboardingRestoreOutcome,
  restoreOnboardingState,
  restoreOnboardingStateFromJson,
  serializeOnboardingState,
} from "./onboarding-persistence.ts";
import {
  AccountProvider,
  createInitialOnboardingState,
  OnboardingHost,
  type OnboardingMachineState,
  OnboardingPhase,
} from "./onboarding-phase.ts";

/**
 * A genuinely reachable mid-flow state that both hosts render: a returning user
 * whose account was already established went straight from Welcome to the
 * organization choice, then on to invitations. The earlier fixture walked
 * Account -> InviteTeam, which the machine has no edge for, so it could not
 * survive the reachability check restore now applies.
 */
const midFlow: OnboardingMachineState = {
  phase: OnboardingPhase.InviteTeam,
  history: [OnboardingPhase.Welcome, OnboardingPhase.ChooseOrganization],
  accountProvider: AccountProvider.Email,
  resuming: false,
  organizationEstablished: true,
};

describe("round trip", () => {
  it("restores a state it serialized", () => {
    const restored = restoreOnboardingState(
      serializeOnboardingState(midFlow),
      OnboardingHost.Web
    );

    expect(restored).toEqual({
      state: midFlow,
      outcome: OnboardingRestoreOutcome.Restored,
    });
  });

  it("survives a JSON string trip", () => {
    const json = JSON.stringify(serializeOnboardingState(midFlow));

    expect(
      restoreOnboardingStateFromJson(json, OnboardingHost.Web).state
    ).toEqual(midFlow);
  });

  it("restores current-version rows written before accountProvider existed", () => {
    const restored = restoreOnboardingState(
      {
        version: ONBOARDING_STATE_VERSION,
        phase: midFlow.phase,
        history: midFlow.history,
        resuming: midFlow.resuming,
        organizationEstablished: midFlow.organizationEstablished,
      },
      OnboardingHost.Web
    );

    expect(restored).toEqual({
      state: { ...midFlow, accountProvider: null },
      outcome: OnboardingRestoreOutcome.Restored,
    });
  });

  it("preserves the resuming flag", () => {
    const resumed: OnboardingMachineState = {
      phase: OnboardingPhase.ConnectGitHub,
      history: [OnboardingPhase.DashboardAvailable],
      accountProvider: AccountProvider.Email,
      resuming: true,
      organizationEstablished: true,
    };

    expect(
      restoreOnboardingState(
        serializeOnboardingState(resumed),
        OnboardingHost.Desktop
      ).state
    ).toEqual(resumed);
  });
});

describe("absent state", () => {
  it.each([null, undefined])("treats %s as a first run", (raw) => {
    expect(restoreOnboardingState(raw, OnboardingHost.Web)).toEqual({
      state: createInitialOnboardingState(),
      outcome: OnboardingRestoreOutcome.Absent,
    });
  });

  it.each([null, undefined, "", "   "])(
    "treats %p JSON as a first run",
    (raw) => {
      expect(restoreOnboardingStateFromJson(raw, OnboardingHost.Web)).toEqual({
        state: createInitialOnboardingState(),
        outcome: OnboardingRestoreOutcome.Absent,
      });
    }
  );
});

describe("unreadable state recovers to Welcome", () => {
  const unreadable: Record<string, unknown> = {
    "a future version": {
      version: ONBOARDING_STATE_VERSION + 1,
      phase: OnboardingPhase.InviteTeam,
      history: [],
      resuming: false,
    },
    "a past version": {
      version: ONBOARDING_STATE_VERSION - 1,
      phase: OnboardingPhase.InviteTeam,
      history: [],
      resuming: false,
    },
    "an unknown phase": {
      version: ONBOARDING_STATE_VERSION,
      phase: "phase_from_a_newer_build",
      history: [],
      resuming: false,
    },
    "an unknown phase in history": {
      version: ONBOARDING_STATE_VERSION,
      phase: OnboardingPhase.InviteTeam,
      history: ["phase_from_a_newer_build"],
      resuming: false,
    },
    "an unknown extra field": {
      version: ONBOARDING_STATE_VERSION,
      phase: OnboardingPhase.InviteTeam,
      history: [],
      resuming: false,
      stepAddedByANewerBuild: "invite_contractors",
    },
    "a missing field": {
      version: ONBOARDING_STATE_VERSION,
      phase: OnboardingPhase.InviteTeam,
      history: [],
    },
    "a wrong-typed field": {
      version: ONBOARDING_STATE_VERSION,
      phase: OnboardingPhase.InviteTeam,
      history: OnboardingPhase.Welcome,
      resuming: false,
    },
    "a primitive": 7,
    "an array": [],
  };

  it.each(Object.entries(unreadable))("recovers from %s", (_label, raw) => {
    const restored = restoreOnboardingState(raw, OnboardingHost.Desktop);

    expect(restored.outcome).toBe(OnboardingRestoreOutcome.Unreadable);
    expect(restored.state).toEqual(createInitialOnboardingState());
    expect(restored.state.phase).toBe(OnboardingPhase.Welcome);
  });

  it("recovers from malformed JSON rather than throwing", () => {
    const restored = restoreOnboardingStateFromJson(
      '{"version":1,"phase":',
      OnboardingHost.Web
    );

    expect(restored.outcome).toBe(OnboardingRestoreOutcome.Unreadable);
    expect(restored.state.phase).toBe(OnboardingPhase.Welcome);
  });

  it.each([
    OnboardingPhase.DashboardAvailable,
    OnboardingPhase.DashboardTour,
    OnboardingPhase.Ready,
  ])("never recovers into the completed phase %s", (completedPhase) => {
    const restored = restoreOnboardingState(
      {
        version: ONBOARDING_STATE_VERSION + 1,
        phase: completedPhase,
        history: [],
        resuming: false,
      },
      OnboardingHost.Web
    );

    expect(restored.state.phase).toBe(OnboardingPhase.Welcome);
  });
});

describe("cross-host recovery", () => {
  it("recovers a Web download gate opened on Desktop", () => {
    const restored = restoreOnboardingState(
      serializeOnboardingState({
        phase: OnboardingPhase.DownloadDesktop,
        history: [OnboardingPhase.Welcome],
        accountProvider: null,
        resuming: false,
        organizationEstablished: false,
      }),
      OnboardingHost.Desktop
    );

    expect(restored.outcome).toBe(OnboardingRestoreOutcome.UnreachableOnHost);
    expect(restored.state).toEqual(createInitialOnboardingState());
  });

  it.each([OnboardingPhase.SessionDiscovery, OnboardingPhase.SyncPolicy])(
    "recovers the Desktop-only phase %s opened on Web",
    (phase) => {
      const restored = restoreOnboardingState(
        serializeOnboardingState({
          phase,
          history: [],
          accountProvider: null,
          resuming: false,
          organizationEstablished: false,
        }),
        OnboardingHost.Web
      );

      expect(restored.outcome).toBe(OnboardingRestoreOutcome.UnreachableOnHost);
      expect(restored.state.phase).toBe(OnboardingPhase.Welcome);
    }
  );

  it("recovers when only the history holds an impossible phase", () => {
    const restored = restoreOnboardingState(
      serializeOnboardingState({
        phase: OnboardingPhase.InviteTeam,
        history: [
          OnboardingPhase.Welcome,
          OnboardingPhase.ChooseOrganization,
          OnboardingPhase.SyncPolicy,
        ],
        accountProvider: null,
        resuming: false,
        organizationEstablished: false,
      }),
      OnboardingHost.Web
    );

    expect(restored.outcome).toBe(OnboardingRestoreOutcome.UnreachableOnHost);
  });

  /**
   * ISS-11249 review (@whitlockk). A Desktop reader resuming the sync election
   * writes `{sync_policy, [dashboard_available], resuming}` to the run BOTH
   * hosts share. Web cannot render that phase, and the general fallback would
   * hand a reader who finished onboarding the blocking first-run takeover — then
   * post that fresh run over the Desktop one still mid-answer, losing the
   * completed run for good. The resumed shape proves the Dashboard was reached,
   * so Web keeps it.
   */
  it("keeps the settled run behind a resumed step the host cannot render", () => {
    const restored = restoreOnboardingState(
      serializeOnboardingState({
        phase: OnboardingPhase.SyncPolicy,
        history: [OnboardingPhase.DashboardAvailable],
        accountProvider: AccountProvider.Google,
        resuming: true,
        organizationEstablished: true,
      }),
      OnboardingHost.Web
    );

    expect(restored.outcome).toBe(OnboardingRestoreOutcome.UnreachableOnHost);
    expect(restored.state).toEqual({
      phase: OnboardingPhase.DashboardAvailable,
      history: [],
      accountProvider: AccountProvider.Google,
      resuming: false,
      organizationEstablished: true,
    });
  });

  /**
   * The falsifying half. `resuming` alone must not buy the Dashboard: this
   * payload sets the flag on a chain no resumed step can produce, so it is not
   * proof of anything and takes the conservative fresh run. Without this case a
   * guard that keyed on the flag alone would stay green.
   */
  it("still recovers a fresh run when resuming is set on an unreachable chain", () => {
    const restored = restoreOnboardingState(
      serializeOnboardingState({
        phase: OnboardingPhase.SyncPolicy,
        history: [OnboardingPhase.Welcome, OnboardingPhase.CreateOrganization],
        accountProvider: null,
        resuming: true,
        organizationEstablished: true,
      }),
      OnboardingHost.Web
    );

    expect(restored.outcome).toBe(OnboardingRestoreOutcome.UnreachableOnHost);
    expect(restored.state).toEqual(createInitialOnboardingState());
  });

  it("keeps a phase both hosts render", () => {
    const restored = restoreOnboardingState(
      serializeOnboardingState(midFlow),
      OnboardingHost.Desktop
    );

    expect(restored.outcome).toBe(OnboardingRestoreOutcome.Restored);
  });
});

/**
 * ISS-8349 review (T2/T6). Shape validity and host validity between them still
 * admit states no run of the machine can produce. Restoring one bypasses the
 * blocking flow it claims to be past, so it takes the same safe recovery as an
 * unreadable payload. These payloads all carry the CURRENT version and pass the
 * schema and the host check.
 */
describe("impossible-state recovery", () => {
  function currentVersionPayload(state: OnboardingMachineState) {
    return serializeOnboardingState(state);
  }

  it("recovers Ready with an empty history, on both resuming values", () => {
    for (const resuming of [true, false]) {
      const payload = currentVersionPayload({
        phase: OnboardingPhase.Ready,
        history: [],
        accountProvider: AccountProvider.Email,
        resuming,
        organizationEstablished: true,
      });
      // The payload really is shape-valid and current-version.
      expect(payload.version).toBe(ONBOARDING_STATE_VERSION);

      const restored = restoreOnboardingState(payload, OnboardingHost.Web);

      expect(restored.outcome).toBe(OnboardingRestoreOutcome.UnreachableState);
      expect(restored.state).toEqual(createInitialOnboardingState());
    }
  });

  it("recovers a history that skips an edge the machine cannot take", () => {
    const restored = restoreOnboardingState(
      currentVersionPayload({
        phase: OnboardingPhase.InviteTeam,
        history: [OnboardingPhase.Welcome, OnboardingPhase.Account],
        accountProvider: AccountProvider.Email,
        resuming: false,
        organizationEstablished: false,
      }),
      OnboardingHost.Web
    );

    expect(restored.outcome).toBe(OnboardingRestoreOutcome.UnreachableState);
    expect(restored.state.phase).toBe(OnboardingPhase.Welcome);
  });

  it("recovers a resuming flag set outside a resumed step", () => {
    const restored = restoreOnboardingState(
      currentVersionPayload({
        phase: OnboardingPhase.InviteTeam,
        history: [OnboardingPhase.Welcome, OnboardingPhase.ChooseOrganization],
        accountProvider: AccountProvider.Email,
        resuming: true,
        organizationEstablished: true,
      }),
      OnboardingHost.Web
    );

    expect(restored.outcome).toBe(OnboardingRestoreOutcome.UnreachableState);
    expect(restored.state.phase).toBe(OnboardingPhase.Welcome);
  });

  it("still restores a genuine resumed step", () => {
    const resumed: OnboardingMachineState = {
      phase: OnboardingPhase.InviteTeam,
      history: [OnboardingPhase.DashboardAvailable],
      accountProvider: AccountProvider.Email,
      resuming: true,
      organizationEstablished: true,
    };
    const restored = restoreOnboardingState(
      currentVersionPayload(resumed),
      OnboardingHost.Web
    );

    expect(restored).toEqual({
      state: resumed,
      outcome: OnboardingRestoreOutcome.Restored,
    });
  });

  it("recovers an impossible state that arrived as JSON", () => {
    const json = JSON.stringify(
      currentVersionPayload({
        phase: OnboardingPhase.Ready,
        history: [],
        accountProvider: null,
        resuming: false,
        organizationEstablished: false,
      })
    );

    expect(
      restoreOnboardingStateFromJson(json, OnboardingHost.Desktop).outcome
    ).toBe(OnboardingRestoreOutcome.UnreachableState);
  });
});
