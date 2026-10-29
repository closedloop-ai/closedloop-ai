/**
 * ISS-11036: the Desktop guided flow walked through the REAL snapshot and
 * transition services, as host Desktop, into an organization the server already
 * counts as onboarded.
 *
 * A Desktop guest walks Welcome and Session Discovery on the device, then
 * signs in, and `useGuestGuidedOnboardingHandoff` posts that run
 * as an `account_established` from Account. The settled fold answered that
 * handoff with `Ready`, so neither the organization step nor "Invite people you
 * build with" ever rendered. Every state posted here is the one the Desktop
 * client's machine (`onboarding-transitions.ts`) produces for its event, built
 * on the snapshot the server returned, as the client builds it; the machine is
 * in `packages/app`, which this package cannot import, and
 * `onboarding-cohorts.test.ts` pins its edges.
 */

import { KnownFlag } from "@repo/api/src/types/onboarding-phase";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  getUserExternalAccountProviders: vi.fn(),
  organizationHasSyncedSessionData: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: mocks.withDb,
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getUserExternalAccountProviders: mocks.getUserExternalAccountProviders,
  },
}));

vi.mock("@/app/agent-sessions/organization-synced-session-data", () => ({
  organizationHasSyncedSessionData: mocks.organizationHasSyncedSessionData,
}));

import { randomUUID } from "node:crypto";
import { resolvePendingOnboardingStep } from "@repo/api/src/types/onboarding-completion";
import {
  OnboardingEvent,
  type OnboardingEventInput,
} from "@repo/api/src/types/onboarding-events";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  ONBOARDING_STATE_VERSION,
  type PersistedOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  OnboardingHost,
  OnboardingPhase,
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import {
  createGuidedOnboardingDb,
  type FakeInstallationRow,
  type FakeUserRow,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-db";
import {
  CLERK_USER_A,
  EXPERIENCE_VARIANT,
  installationRow,
  LIVE_ATTEMPT_CREATED_AT,
  ORG_A,
  onboardedOrganizationRow,
  PRE_FOLD_ATTEMPT_CREATED_AT,
  USER_A,
  USER_A_TEAMMATE,
  userRow,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-fixtures";
import {
  expectAccepted,
  expectSnapshot,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-helpers";
import { guidedOnboardingSnapshotService } from "../snapshot-service";
import { guidedOnboardingTransitionService } from "../transition-service";

const Cohort = {
  FirstUser: "first user",
  ExistingMember: "existing organization member",
} as const;
type Cohort = (typeof Cohort)[keyof typeof Cohort];

const COHORT_USERS: Record<Cohort, FakeUserRow[]> = {
  [Cohort.FirstUser]: [userRow(USER_A, ORG_A)],
  [Cohort.ExistingMember]: [
    userRow(USER_A, ORG_A),
    userRow(USER_A_TEAMMATE, ORG_A),
  ],
};

const CLERK_PROVIDER: Record<AccountProvider, string[]> = {
  [AccountProvider.Email]: [],
  [AccountProvider.GitHub]: ["oauth_github"],
  [AccountProvider.Google]: ["oauth_google"],
};

/** The run a guest leaves on the device when it signs in from Account. */
const GUEST_ACCOUNT_STATE: PersistedOnboardingState = {
  version: ONBOARDING_STATE_VERSION,
  phase: OnboardingPhase.Account,
  history: [OnboardingPhase.Welcome, OnboardingPhase.SessionDiscovery],
  accountProvider: null,
  resuming: false,
  organizationEstablished: false,
};

/** The same guest on an ISS-10624-era build, which asked the sync step first. */
const LEGACY_GUEST_ACCOUNT_STATE: PersistedOnboardingState = {
  ...GUEST_ACCOUNT_STATE,
  history: [
    OnboardingPhase.Welcome,
    OnboardingPhase.SyncPolicy,
    OnboardingPhase.SessionDiscovery,
  ],
};

const COHORTS = [Cohort.FirstUser, Cohort.ExistingMember];
const PROVIDERS = [AccountProvider.GitHub, AccountProvider.Google];
const INVITE_EXITS = [
  OnboardingEvent.SendInvitations,
  OnboardingEvent.SkipInvitations,
] as const;

/** Desktop's `AfterInitialInvite`: GitHub auth already satisfied the step. */
const AFTER_INVITE: Record<AccountProvider, OnboardingPhase> = {
  [AccountProvider.Email]: OnboardingPhase.ConnectGitHub,
  [AccountProvider.GitHub]: OnboardingPhase.DashboardAvailable,
  [AccountProvider.Google]: OnboardingPhase.ConnectGitHub,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.No);
  // The fake store stamps a created row's `createdAt` from the clock, and the
  // fold branches on it; only `Date` is faked so the services' I/O is untouched.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(LIVE_ATTEMPT_CREATED_AT);
});

afterEach(() => {
  vi.useRealTimers();
});

function install(
  cohort: Cohort,
  provider: AccountProvider,
  installations: FakeInstallationRow[] = []
): void {
  const db = createGuidedOnboardingDb({
    installations,
    organizations: [onboardedOrganizationRow(ORG_A)],
    users: COHORT_USERS[cohort],
  });
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db.client)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db.client)
  );
  mocks.getUserExternalAccountProviders.mockResolvedValue(
    CLERK_PROVIDER[provider]
  );
}

function readDesktop(): Promise<GuidedOnboardingSnapshot> {
  return guidedOnboardingSnapshotService.getSnapshot({
    organizationId: ORG_A,
    userId: USER_A,
    clerkUserId: CLERK_USER_A,
    host: OnboardingHost.Desktop,
  });
}

/** The machine's `advance`: leave `from`'s phase on history and move on. */
function advance(
  from: PersistedOnboardingState,
  phase: OnboardingPhase,
  patch: Partial<PersistedOnboardingState> = {}
): PersistedOnboardingState {
  return {
    ...from,
    phase,
    history: [...from.history, from.phase],
    resuming: false,
    ...patch,
  };
}

/** The machine's `transitionBack`: pop the tail, keep everything else. */
function back(from: PersistedOnboardingState): PersistedOnboardingState {
  const previous = from.history.at(-1);
  if (previous === undefined) {
    throw new Error("Back needs a phase to return to");
  }
  return { ...from, phase: previous, history: from.history.slice(0, -1) };
}

async function post(
  revision: number,
  event: OnboardingEventInput,
  state: PersistedOnboardingState
): Promise<GuidedOnboardingSnapshot> {
  const result = await guidedOnboardingTransitionService.apply({
    organizationId: ORG_A,
    userId: USER_A,
    clerkUserId: CLERK_USER_A,
    command: {
      commandId: randomUUID(),
      event,
      experienceVariant: EXPERIENCE_VARIANT,
      host: OnboardingHost.Desktop,
      revision,
      state,
    },
  });
  return expectSnapshot(expectAccepted(result));
}

/**
 * Sign in from the guest's Account step and continue until the run leaves the
 * organization step, recording the phase the server answers each post with.
 */
async function signInAndWalkToInvite(
  cohort: Cohort,
  provider: AccountProvider
): Promise<{
  answered: OnboardingPhase[];
  atInvite: GuidedOnboardingSnapshot;
}> {
  const server = await readDesktop();
  const organizationPhase =
    cohort === Cohort.FirstUser
      ? OnboardingPhase.CreateOrganization
      : OnboardingPhase.ChooseOrganization;
  let current = await post(
    server.revision,
    { type: OnboardingEvent.AccountEstablished, provider },
    advance(GUEST_ACCOUNT_STATE, organizationPhase, {
      accountProvider: provider,
    })
  );
  const answered = [current.state.phase];
  if (current.state.phase === OnboardingPhase.ChooseOrganization) {
    current = await post(
      current.revision,
      { type: OnboardingEvent.OrganizationReady },
      advance(current.state, OnboardingPhase.SyncPolicy, {
        organizationEstablished: true,
      })
    );
    answered.push(current.state.phase);
    current = await post(
      current.revision,
      { type: OnboardingEvent.ContinueFromSyncPolicy },
      advance(current.state, OnboardingPhase.InviteTeam)
    );
    answered.push(current.state.phase);
  }
  return { answered, atInvite: current };
}

describe("Desktop guided onboarding into an already-onboarded organization", () => {
  for (const cohort of COHORTS) {
    for (const provider of PROVIDERS) {
      it(`shows the invite step after the sign-in handoff (${cohort}, ${provider})`, async () => {
        install(cohort, provider);

        const { answered } = await signInAndWalkToInvite(cohort, provider);

        // The first user's organization exists and is onboarded, so its
        // create step reads as done; the existing member still chooses.
        expect(answered).toEqual(
          cohort === Cohort.FirstUser
            ? [OnboardingPhase.InviteTeam]
            : [
                OnboardingPhase.ChooseOrganization,
                OnboardingPhase.SyncPolicy,
                OnboardingPhase.InviteTeam,
              ]
        );
      });

      for (const exit of INVITE_EXITS) {
        it(`leaves the invite step on ${exit} through its defined edge (${cohort}, ${provider})`, async () => {
          install(cohort, provider);
          const { atInvite } = await signInAndWalkToInvite(cohort, provider);

          const after = await post(
            atInvite.revision,
            { type: exit },
            advance(atInvite.state, AFTER_INVITE[provider])
          );

          expect(after.state.phase).toBe(AFTER_INVITE[provider]);
          expect(after.state.history.at(-1)).toBe(OnboardingPhase.InviteTeam);
        });
      }
    }
  }

  it("takes Back from the first user's invite step to Account, then forward again", async () => {
    install(Cohort.FirstUser, AccountProvider.GitHub);
    const { atInvite } = await signInAndWalkToInvite(
      Cohort.FirstUser,
      AccountProvider.GitHub
    );

    const backed = await post(
      atInvite.revision,
      { type: OnboardingEvent.Back },
      back(atInvite.state)
    );
    expect(backed.state.phase).toBe(OnboardingPhase.Account);

    const forward = await post(
      backed.revision,
      {
        type: OnboardingEvent.AccountEstablished,
        provider: AccountProvider.GitHub,
      },
      advance(backed.state, OnboardingPhase.CreateOrganization)
    );

    expect(forward.state.phase).toBe(OnboardingPhase.InviteTeam);
  });

  it("accepts a handoff posted by an ISS-10624-era Desktop build", async () => {
    install(Cohort.ExistingMember, AccountProvider.GitHub);
    const server = await readDesktop();

    const handedOff = await post(
      server.revision,
      {
        type: OnboardingEvent.AccountEstablished,
        provider: AccountProvider.GitHub,
      },
      advance(LEGACY_GUEST_ACCOUNT_STATE, OnboardingPhase.ChooseOrganization, {
        accountProvider: AccountProvider.GitHub,
      })
    );
    const atInvite = await post(
      handedOff.revision,
      { type: OnboardingEvent.OrganizationReady },
      advance(handedOff.state, OnboardingPhase.InviteTeam, {
        organizationEstablished: true,
      })
    );

    expect(handedOff.state.phase).toBe(OnboardingPhase.ChooseOrganization);
    expect(atInvite.state.phase).toBe(OnboardingPhase.InviteTeam);
    expect(atInvite.state.history).toEqual([
      ...LEGACY_GUEST_ACCOUNT_STATE.history,
      OnboardingPhase.Account,
      OnboardingPhase.ChooseOrganization,
    ]);
  });

  it("still settles a handoff written before the fold shipped", async () => {
    // The same walk on the other side of the cutoff: the absent-evidence fold
    // ISS-9916 added still answers it, so the cutoff is what keeps the run.
    vi.setSystemTime(PRE_FOLD_ATTEMPT_CREATED_AT);
    install(Cohort.ExistingMember, AccountProvider.GitHub);

    const { answered } = await signInAndWalkToInvite(
      Cohort.ExistingMember,
      AccountProvider.GitHub
    );

    expect(answered).toEqual([OnboardingPhase.Ready]);
  });

  it("keeps a skipped invitation on the Getting started card and resumes it", async () => {
    // First user: the only cohort whose invitation can still be outstanding,
    // since an existing member's teammate already counts as invited. GitHub is
    // connected so the invitation is the step the card offers.
    install(Cohort.FirstUser, AccountProvider.GitHub, [installationRow(ORG_A)]);
    const { atInvite } = await signInAndWalkToInvite(
      Cohort.FirstUser,
      AccountProvider.GitHub
    );
    const dashboard = await post(
      atInvite.revision,
      { type: OnboardingEvent.SkipInvitations },
      advance(atInvite.state, OnboardingPhase.DashboardAvailable)
    );
    const tour = await post(
      dashboard.revision,
      { type: OnboardingEvent.DashboardEntered },
      advance(dashboard.state, OnboardingPhase.DashboardTour)
    );
    const ready = await post(
      tour.revision,
      { type: OnboardingEvent.FinishTour },
      advance(tour.state, OnboardingPhase.Ready)
    );

    const offered = resolvePendingOnboardingStep({
      ...ready.context,
      analysisStarted: true,
      host: OnboardingHost.Desktop,
      organizationActive: KnownFlag.Yes,
      syncConsentRecorded: KnownFlag.Yes,
    });
    const resumed = await post(
      ready.revision,
      {
        type: OnboardingEvent.ResumePendingStep,
        step: PendingOnboardingStep.InviteTeam,
      },
      {
        ...ready.state,
        phase: OnboardingPhase.InviteTeam,
        history: [OnboardingPhase.DashboardAvailable],
        resuming: true,
      }
    );

    expect(ready.state.phase).toBe(OnboardingPhase.Ready);
    expect(offered).toBe(PendingOnboardingStep.InviteTeam);
    expect(resumed.state.phase).toBe(OnboardingPhase.InviteTeam);
    expect(resumed.state.resuming).toBe(true);
  });
});
