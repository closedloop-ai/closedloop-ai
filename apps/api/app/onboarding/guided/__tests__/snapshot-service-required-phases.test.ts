/**
 * ISS-11073: Get Started reaching guided onboarding's required phases.
 *
 * A brand-new Web organization completes the legacy team/project wizard, that
 * wizard stamps `wizardCompletedAt`, and the guided snapshot accepted that
 * marker as completion of the GUIDED run — so Get Started went straight to the
 * dashboard tour with invitations never shown or skipped and the Desktop
 * download never offered.
 *
 * This is a TRANSITION/GATING contract, never a completion claim: nothing here
 * asserts that a deferred step became complete, and the Getting-started
 * checklist's own inputs are pinned as still unsatisfied after the transition.
 *
 * Every case drives the REAL service against the shared Prisma-semantics
 * double. The two cases that pin the gate's own effect — the fresh run's fold
 * and the organization step — each carry an OFF sibling, so neither can pass
 * merely because the gate is shut. The remaining cases pin arms the gate does
 * not change (the pre-cutoff inference), the replacement evidence itself, or a
 * context value that survives the read; those are ON-only by intent.
 */

import { KnownFlag } from "@repo/api/src/types/onboarding-phase";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  getUserExternalAccountProviders: vi.fn(),
  organizationHasSyncedSessionData: vi.fn(),
  resolveGuidedRequiredPhases: vi.fn(),
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

// The gate itself is PostHog's; what this file owns is what the service does
// with each answer. Both answers are exercised below.
vi.mock("../required-phases-gate", () => ({
  resolveGuidedRequiredPhases: mocks.resolveGuidedRequiredPhases,
}));

import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import { serializeOnboardingState } from "@repo/api/src/types/onboarding-persistence";
import {
  isBlockingPhase,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import {
  createGuidedOnboardingDb,
  type GuidedOnboardingDb,
  type GuidedOnboardingSeed,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-db";
import {
  attemptRow,
  CLERK_USER_A,
  currentEraOnboardedOrganizationRow,
  ORG_A,
  onboardedOrganizationRow,
  organizationRow,
  PRE_FOLD_ATTEMPT_CREATED_AT,
  projectRow,
  teamRow,
  transitionCommand,
  USER_A,
  USER_A_TEAMMATE,
  userRow,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-fixtures";
import { guidedOnboardingSnapshotService } from "../snapshot-service";
import { guidedOnboardingTransitionService } from "../transition-service";

const GUIDED_RUN_COMPLETED_AT = new Date("2026-09-21T00:00:00.000Z");

function install(seed: GuidedOnboardingSeed = {}): GuidedOnboardingDb {
  const db = createGuidedOnboardingDb({
    users: [userRow(USER_A, ORG_A)],
    organizations: [organizationRow(ORG_A)],
    ...seed,
  });
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db.client)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db.client)
  );
  return db;
}

function read(host: OnboardingHost = OnboardingHost.Web) {
  return guidedOnboardingSnapshotService.getSnapshot({
    organizationId: ORG_A,
    userId: USER_A,
    clerkUserId: CLERK_USER_A,
    host,
  });
}

function gate(enabled: boolean): void {
  mocks.resolveGuidedRequiredPhases.mockResolvedValue(enabled);
}

/** The organization a fresh Web signup reaches the dashboard as (ISS-11073). */
function freshOrganizationThroughLegacyWizard(): GuidedOnboardingSeed {
  return {
    organizations: [currentEraOnboardedOrganizationRow(ORG_A)],
    projects: [projectRow(ORG_A)],
    teams: [teamRow(ORG_A)],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserExternalAccountProviders.mockResolvedValue([]);
  mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.No);
  gate(false);
});

describe("the legacy wizard marker and a fresh guided run", () => {
  it("no longer settles a guided run the reader has never started", async () => {
    gate(true);
    install(freshOrganizationThroughLegacyWizard());

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.Welcome);
    // The fixtures the acceptance criterion names: nothing downloaded, nobody
    // invited, and no synced data to buy a Skip with.
    expect(snapshot.context.desktopAppDownloaded).toBe(false);
    expect(snapshot.context.teamInvited).toBe(false);
    expect(snapshot.context.organizationHasSyncedSessionData).toBe(
      KnownFlag.No
    );
  });

  it("settles that same run when the gate is shut", async () => {
    install(freshOrganizationThroughLegacyWizard());

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.Ready);
  });

  /**
   * ISS-11073, tamsinb on #7854: `FirstUser` scoping protects a TEAMMATE, and
   * nothing about it protects a SOLO organization that already onboarded.
   *
   * The cohort: one person, organization created after the guided cutoff, legacy
   * wizard finished weeks ago, real synced session data since, and no guided
   * attempt row because the guided flow did not exist for them. Membership is
   * satisfied — every solo organization is its own first user — so without a
   * second condition the gate opening hands an already-productive reader a
   * full-screen Welcome takeover on their next dashboard load.
   *
   * Narrowed to the reading the ticket's own subject supports (a NEW EMPTY
   * organization) rather than deciding a re-onboarding question nobody asked:
   * measured synced session data is evidence the organization is already in use,
   * and the swap is withheld for it.
   */
  it("does not re-onboard a solo organization that is already in use", async () => {
    gate(true);
    mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.Yes);
    install(freshOrganizationThroughLegacyWizard());

    const snapshot = await read();

    // Positively settled, not merely "not Welcome": the reader keeps the run
    // the legacy marker already earned them.
    expect(snapshot.state.phase).toBe(OnboardingPhase.Ready);
    expect(isBlockingPhase(snapshot.state.phase)).toBe(false);
    expect(snapshot.state.history).toEqual([
      OnboardingPhase.DashboardAvailable,
    ]);
    // The discriminator is the organization's own use, not its headcount: this
    // reader is still the first user, exactly as the re-onboarded one is.
    expect(snapshot.context.membership).toBe(OrganizationMembership.FirstUser);
  });

  /**
   * The non-regressive direction on an UNREADABLE answer, and the reason it is
   * that direction. `KnownFlag.Unknown` is a failed or still-loading read, so it
   * is not evidence the organization is empty; treating it as such would put the
   * takeover back for the cohort above on any transient producer failure. The
   * cost of the other choice is one page load without the reconciled sequence,
   * which the gate's own fail-closed contract already accepts.
   */
  it("withholds the swap on an unreadable synced-data answer", async () => {
    gate(true);
    mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.Unknown);
    install(freshOrganizationThroughLegacyWizard());

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.Ready);
  });

  it("still settles a run the GUIDED flow itself recorded as complete", async () => {
    // The replacement evidence, exercised where the settled fold can actually
    // be observed: a row written before that fold shipped, so it stands in for
    // absent evidence rather than being kept as a live run.
    gate(true);
    install({
      attempts: [
        attemptRow({
          id: "attempt-1",
          completedAt: GUIDED_RUN_COMPLETED_AT,
          createdAt: PRE_FOLD_ATTEMPT_CREATED_AT,
        }),
      ],
      ...freshOrganizationThroughLegacyWizard(),
    });

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.Ready);
  });

  it("does not settle that run when the guided flow never completed it", async () => {
    gate(true);
    install({
      attempts: [
        attemptRow({ id: "attempt-1", createdAt: PRE_FOLD_ATTEMPT_CREATED_AT }),
      ],
      ...freshOrganizationThroughLegacyWizard(),
    });

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.Account);
  });

  it("still settles an existing member on the organization marker", async () => {
    // The org-level `wizardCompletedAt` settles the run for EVERY member;
    // `attempt.completedAt` is per (organization, user). Swapping one for the
    // other across the board would hand a blocking first-run takeover to every
    // teammate of an already-onboarded organization — the ISS-9916 inversion.
    // ISS-11073 is about a new EMPTY organization, so an existing member keeps
    // reading the organization marker with the gate ON.
    gate(true);
    install({
      users: [userRow(USER_A, ORG_A), userRow(USER_A_TEAMMATE, ORG_A)],
      ...freshOrganizationThroughLegacyWizard(),
    });

    const snapshot = await read();

    expect(snapshot.context.membership).toBe(
      OrganizationMembership.ExistingMember
    );
    // Asserted POSITIVELY — what the member actually gets, not merely the
    // absence of a takeover. A negative-only assertion here would be satisfied
    // by a state that renders nothing at all.
    expect(snapshot.state.phase).toBe(OnboardingPhase.Ready);
    expect(isBlockingPhase(snapshot.state.phase)).toBe(false);
    expect(snapshot.state.history).toEqual([
      OnboardingPhase.DashboardAvailable,
    ]);
    expect(snapshot.state.organizationEstablished).toBe(true);
  });

  it("leaves a pre-cutoff organization on the teams-and-projects inference", async () => {
    // "Returning historical organizations remain functional": the pre-cutoff
    // teams-and-projects arm still settles the run with the gate ON, which is
    // the position that could have changed it.
    gate(true);
    install({
      organizations: [onboardedOrganizationRow(ORG_A)],
      projects: [projectRow(ORG_A)],
      teams: [teamRow(ORG_A)],
    });

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.Ready);
  });
});

describe("the organization step and an organization that already exists", () => {
  it("reports a first run past it, at invitations", async () => {
    // ISS-11073: this snapshot is org-scoped, so a reader who reaches it has an
    // organization and `create_organization` would ask for a second one.
    gate(true);
    install({
      attempts: [
        attemptRow({
          id: "attempt-1",
          state: serializeOnboardingState({
            accountProvider: null,
            history: [OnboardingPhase.Welcome],
            organizationEstablished: false,
            phase: OnboardingPhase.CreateOrganization,
            resuming: false,
          }),
        }),
      ],
    });

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.InviteTeam);
    expect(snapshot.state.history).toEqual([
      OnboardingPhase.Welcome,
      OnboardingPhase.CreateOrganization,
    ]);
    expect(snapshot.state.organizationEstablished).toBe(true);
  });

  it("does not reverse a Back out of invitations", async () => {
    // The fold produces `InviteTeam` from `CreateOrganization`, and
    // `transitionBack` pops to `CreateOrganization` while PRESERVING
    // `organizationEstablished`. Folding that forward again would hand the
    // reader back the screen they just left, on the very response meant to
    // confirm the Back. It reports one step further back instead — the phase
    // they left for the skipped step.
    gate(true);
    install({
      attempts: [
        attemptRow({
          id: "attempt-1",
          state: serializeOnboardingState({
            accountProvider: null,
            history: [OnboardingPhase.Welcome],
            organizationEstablished: true,
            phase: OnboardingPhase.CreateOrganization,
            resuming: false,
          }),
        }),
      ],
    });

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.Welcome);
    expect(snapshot.state.history).toEqual([]);
    expect(snapshot.state.organizationEstablished).toBe(false);
  });

  it("keeps asking for the organization when the gate is shut", async () => {
    install({
      attempts: [
        attemptRow({
          id: "attempt-1",
          state: serializeOnboardingState({
            accountProvider: null,
            history: [OnboardingPhase.Welcome],
            organizationEstablished: false,
            phase: OnboardingPhase.CreateOrganization,
            resuming: false,
          }),
        }),
      ],
    });

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.CreateOrganization);
  });
});

describe("team/project completion, then Start", () => {
  it("reaches invitations rather than the dashboard", async () => {
    // The span the acceptance criterion names: legacy team/project completion →
    // fresh guided snapshot → Start → the next snapshot.
    gate(true);
    const db = install(freshOrganizationThroughLegacyWizard());

    const first = await read();
    expect(first.state.phase).toBe(OnboardingPhase.Welcome);

    const result = await guidedOnboardingTransitionService.apply({
      organizationId: ORG_A,
      userId: USER_A,
      clerkUserId: CLERK_USER_A,
      command: transitionCommand({
        event: { type: OnboardingEvent.Start },
        revision: first.revision,
        state: serializeOnboardingState({
          accountProvider: null,
          history: [OnboardingPhase.Welcome],
          organizationEstablished: false,
          phase: OnboardingPhase.CreateOrganization,
          resuming: false,
        }),
      }),
    });

    expect(result.ok).toBe(true);
    const next = await read();
    expect(next.state.phase).toBe(OnboardingPhase.InviteTeam);

    // NOT a false-completion claim. The deferred Getting-started checklist is
    // correctly still incomplete: nothing was downloaded, nobody was invited,
    // and the run recorded no completion of its own. The transition moved the
    // reader to the step that is owed, and claimed nothing about it.
    expect(next.context.desktopAppDownloaded).toBe(false);
    expect(next.context.teamInvited).toBe(false);
    const row = db.attempts[0];
    expect(row?.desktopDownloadedAt ?? null).toBeNull();
    expect(row?.completedAt ?? null).toBeNull();
    expect(row?.tourCompletedAt ?? null).toBeNull();
  });

  it("goes straight to a settled dashboard run when the gate is shut", async () => {
    install(freshOrganizationThroughLegacyWizard());

    const first = await read();

    expect(first.state.phase).toBe(OnboardingPhase.Ready);
  });

  it("reports an unknown synced-data answer as unknown, not as a measured no", async () => {
    // The input half of "unknown/error is not false": the producer's tri-state
    // survives this read rather than being flattened to a measured negative.
    // The consumer is the required-phase swap in this same service, which
    // demands a MEASURED `No`; what is pinned here is only that this read hands
    // it `Unknown`.
    gate(true);
    mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.Unknown);
    install(freshOrganizationThroughLegacyWizard());

    const snapshot = await read();

    expect(snapshot.context.organizationHasSyncedSessionData).toBe(
      KnownFlag.Unknown
    );
  });
});
