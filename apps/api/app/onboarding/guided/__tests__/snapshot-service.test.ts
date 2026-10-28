/**
 * ISS-8375: what the guided onboarding snapshot is allowed to say.
 *
 * These cases drive the REAL service against the shared Prisma-semantics
 * double, so the `where` clauses and the producer wiring are what decides them.
 */

import {
  canSkipDesktopDownload,
  listPendingOnboardingSteps,
} from "@repo/api/src/types/onboarding-completion";
import {
  KnownFlag,
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

// Mocked so the tri-state is under the case's control. The production module
// swallows its own failures by design and can only ever be coaxed into
// `Unknown` through a database error, which would not distinguish it from any
// other producer failing.
vi.mock("@/app/agent-sessions/organization-synced-session-data", () => ({
  organizationHasSyncedSessionData: mocks.organizationHasSyncedSessionData,
}));

import {
  ONBOARDING_STATE_VERSION,
  OnboardingRestoreOutcome,
  type PersistedOnboardingState,
  restoreOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { GitHubInstallationStatus } from "@repo/database";
import {
  createGuidedOnboardingDb,
  type GuidedOnboardingDb,
  type GuidedOnboardingSeed,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-db";
import {
  attemptRow,
  CLERK_USER_A,
  computeTargetRow,
  currentEraOnboardedOrganizationRow,
  currentEraOrganizationRow,
  EXPERIENCE_VARIANT,
  githubUserConnectionRow,
  installationRow,
  ORG_A,
  ORG_B,
  onboardedOrganizationRow,
  organizationRow,
  PRE_FOLD_ATTEMPT_CREATED_AT,
  persistedAccountState,
  persistedDownloadDesktopState,
  persistedPostResumeDashboardState,
  persistedResumedConnectGitHubState,
  projectRow,
  teamRow,
  USER_A,
  USER_A_TEAMMATE,
  userRow,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-fixtures";
import { guidedOnboardingSnapshotService } from "../snapshot-service";

const INVITES_SENT_AT = "2026-08-01T00:00:00.000Z";

function install(seed: GuidedOnboardingSeed = {}): GuidedOnboardingDb {
  const db = createGuidedOnboardingDb({
    users: [userRow(USER_A, ORG_A)],
    organizations: [organizationRow(ORG_A)],
    ...seed,
  });
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
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

describe("guidedOnboardingSnapshotService.getSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserExternalAccountProviders.mockResolvedValue([]);
    mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.No);
  });

  it("reports a first run without creating a row", async () => {
    const db = install();

    const snapshot = await read();

    expect(snapshot.attemptId).toBeNull();
    expect(snapshot.context.githubDataConnectionStatusMeasured).toBe(true);
    expect(snapshot.revision).toBe(0);
    expect(snapshot.experienceVariant).toBeNull();
    expect(snapshot.restoreOutcome).toBe(OnboardingRestoreOutcome.Absent);
    expect(snapshot.state.phase).toBe(OnboardingPhase.Welcome);
    // The read must not materialize the run: the first accepted transition owns
    // that, and a GET that wrote would hand every drive-by page load a row.
    expect(db.attempts).toHaveLength(0);
    expect(db.delegates.onboardingAttempt.writes).toHaveLength(0);
  });

  it("returns the persisted run and its compare-and-swap token", async () => {
    install({
      attempts: [attemptRow({ id: "attempt-1", revision: 7 })],
    });

    const snapshot = await read();

    expect(snapshot.attemptId).toBe("attempt-1");
    expect(snapshot.revision).toBe(7);
    expect(snapshot.experienceVariant).toBe(EXPERIENCE_VARIANT);
    expect(snapshot.restoreOutcome).toBe(OnboardingRestoreOutcome.Restored);
    expect(snapshot.state).toEqual(persistedAccountState());
  });

  it("recovers an unreadable persisted state to a FRESH run, never a finished one", async () => {
    install({
      attempts: [
        attemptRow({
          id: "attempt-1",
          // A key this build does not know: the strict schema refuses the whole
          // payload rather than persisting a half-understood run.
          state: { ...persistedAccountState(), somethingNewer: true },
        }),
      ],
    });

    const snapshot = await read();

    expect(snapshot.restoreOutcome).toBe(OnboardingRestoreOutcome.Unreadable);
    expect(snapshot.state.phase).toBe(OnboardingPhase.Welcome);
    expect(snapshot.state.history).toEqual([]);
    expect(snapshot.state.organizationEstablished).toBe(false);
  });

  it("recovers a state whose version this build cannot read", async () => {
    install({
      attempts: [
        attemptRow({
          id: "attempt-1",
          state: { ...persistedAccountState(), version: 99 },
        }),
      ],
    });

    const snapshot = await read();

    expect(snapshot.restoreOutcome).toBe(OnboardingRestoreOutcome.Unreadable);
    expect(snapshot.state.phase).toBe(OnboardingPhase.Welcome);
  });

  it("recovers a Web-only phase read on Desktop", async () => {
    install({
      attempts: [
        attemptRow({ id: "attempt-1", state: persistedDownloadDesktopState() }),
      ],
    });

    const onWeb = await read(OnboardingHost.Web);
    const onDesktop = await read(OnboardingHost.Desktop);

    // The counterfactual matters: without it the assertion would pass against a
    // service that recovered every state regardless of host.
    expect(onWeb.restoreOutcome).toBe(OnboardingRestoreOutcome.Restored);
    expect(onWeb.state.phase).toBe(OnboardingPhase.DownloadDesktop);
    expect(onDesktop.restoreOutcome).toBe(
      OnboardingRestoreOutcome.UnreachableOnHost
    );
    expect(onDesktop.state.phase).toBe(OnboardingPhase.Welcome);
  });
});

describe("guidedOnboardingSnapshotService.getSnapshot — guard inputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserExternalAccountProviders.mockResolvedValue([]);
    mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.No);
  });

  it("derives membership from the active member count", async () => {
    install({
      users: [userRow(USER_A, ORG_A), userRow(USER_A_TEAMMATE, ORG_A)],
    });

    const snapshot = await read();

    expect(snapshot.context.membership).toBe(
      OrganizationMembership.ExistingMember
    );
  });

  // ISS-12482 v2 defines the signal by headcount — "`ExistingMember` when the
  // organization has more than one active user" — so ORG_A's own first user is
  // offered the skip from the moment a teammate goes active. Whether that is the
  // intended reading of "first user" is escalated on PR #8814 thread
  // 4274384023; this case turns a change of definition into a red.
  it("offers the download skip to the organization's first user once a teammate is active", async () => {
    install({
      users: [userRow(USER_A, ORG_A), userRow(USER_A_TEAMMATE, ORG_A)],
      attempts: [
        attemptRow({ id: "attempt-1", state: persistedDownloadDesktopState() }),
      ],
    });

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.DownloadDesktop);
    expect(snapshot.context.membership).toBe(
      OrganizationMembership.ExistingMember
    );
    expect(canSkipDesktopDownload(snapshot.context)).toBe(true);
  });

  it("ignores a deactivated member for membership", async () => {
    install({
      users: [
        userRow(USER_A, ORG_A),
        userRow(USER_A_TEAMMATE, ORG_A, /* active */ false),
      ],
    });

    const snapshot = await read();

    expect(snapshot.context.membership).toBe(OrganizationMembership.FirstUser);
  });

  // ISS-11670, operator ruling 2026-09-30: each new user is prompted to invite
  // teammates regardless of what the rest of the org has done. The two cases
  // below are the counterfactuals for the org-scoped answer this replaced —
  // both used to assert `true` and are the exact states that were granting the
  // step to a reader who had done nothing.
  it("does not claim teamInvited from the active member count", async () => {
    install({
      users: [userRow(USER_A, ORG_A), userRow(USER_A_TEAMMATE, ORG_A)],
      attempts: [attemptRow({ id: "attempt-1" })],
    });

    const snapshot = await read();

    expect(snapshot.context.membership).toBe(
      OrganizationMembership.ExistingMember
    );
    expect(snapshot.context.teamInvited).toBe(false);
  });

  it("does not claim teamInvited from the organization's invites-sent record", async () => {
    install({
      organizations: [organizationRow(ORG_A, INVITES_SENT_AT)],
      attempts: [attemptRow({ id: "attempt-1" })],
    });

    const snapshot = await read();

    expect(snapshot.context.teamInvited).toBe(false);
  });

  it("reports teamInvited from this reader's own run marker", async () => {
    install({
      // Both org-scoped signals absent, so only the per-user marker can carry
      // this: a single active member and no org invites-sent record.
      attempts: [attemptRow({ id: "attempt-1", invitesSentAt: new Date() })],
    });

    const snapshot = await read();

    expect(snapshot.context.membership).toBe(OrganizationMembership.FirstUser);
    expect(snapshot.context.teamInvited).toBe(true);
  });

  it("leaves the invite step outstanding for a reader who has not sent invitations", async () => {
    // The consequence the ruling is actually about: `isStepOutstanding` reads
    // `!teamInvited`, so the org-scoped answer used to take the step off this
    // reader's checklist entirely rather than merely mislabelling it.
    install({
      users: [userRow(USER_A, ORG_A), userRow(USER_A_TEAMMATE, ORG_A)],
      attempts: [attemptRow({ id: "attempt-1" })],
    });

    const snapshot = await read();

    expect(
      listPendingOnboardingSteps({
        ...snapshot.context,
        analysisStarted: true,
        host: OnboardingHost.Web,
        organizationActive: KnownFlag.Unknown,
        syncConsentRecorded: KnownFlag.No,
      })
    ).toContain(PendingOnboardingStep.InviteTeam);
  });

  /*
   * The other half of the same ruling pair, and the one the backfill buys.
   * Operator ruling 2026-09-30: "no, onboared users should not get re-prompted"
   * / "Backfill invites sent at or we'll run into #1 which we don't want". The
   * row below is the post-backfill shape for a reader who finished their run —
   * `completedAt` set, `invitesSentAt` stamped from it by the migration's
   * `UPDATE ... SET "invites_sent_at" = "completed_at"` — and it is seeded in
   * the SAME two-member org as the case above, so the exclusion has to come
   * from the marker rather than from a quieter fixture.
   */
  it("takes the invite step off the checklist of a reader whose completed run was backfilled", async () => {
    const completedAt = new Date("2026-09-25T00:00:00.000Z");
    install({
      users: [userRow(USER_A, ORG_A), userRow(USER_A_TEAMMATE, ORG_A)],
      attempts: [
        attemptRow({
          id: "attempt-1",
          completedAt,
          invitesSentAt: completedAt,
        }),
      ],
    });

    const snapshot = await read();

    expect(snapshot.context.teamInvited).toBe(true);
    expect(
      listPendingOnboardingSteps({
        ...snapshot.context,
        analysisStarted: true,
        host: OnboardingHost.Web,
        organizationActive: KnownFlag.Unknown,
        syncConsentRecorded: KnownFlag.No,
      })
    ).not.toContain(PendingOnboardingStep.InviteTeam);
  });

  /*
   * And the scope of the backfill, from the read side: a run still in flight is
   * a new user, so a `completedAt` this reader does not have must not be
   * inferred. A blanket stamp would pass the case above and silently suppress
   * the prompt the ticket exists to restore, which is why the unstamped
   * completed-less row is asserted here rather than only in the migration guard.
   */
  it("keeps the invite step for a reader whose run has not completed", async () => {
    install({
      users: [userRow(USER_A, ORG_A), userRow(USER_A_TEAMMATE, ORG_A)],
      attempts: [attemptRow({ id: "attempt-1", completedAt: null })],
    });

    const snapshot = await read();

    expect(snapshot.context.teamInvited).toBe(false);
    expect(
      listPendingOnboardingSteps({
        ...snapshot.context,
        analysisStarted: true,
        host: OnboardingHost.Web,
        organizationActive: KnownFlag.Unknown,
        syncConsentRecorded: KnownFlag.No,
      })
    ).toContain(PendingOnboardingStep.InviteTeam);
  });

  /*
   * COHORT 3 of the ruled three, and the one the ticket exists for.
   *
   * After the migration's existing-user backfill, a reader with NO attempt row
   * is by construction a user created AFTER it — a genuine new signup. They are
   * prompted on their own merits: two active members in an established
   * organization, and neither the member count nor the org's own invites-sent
   * record satisfies the step.
   *
   * The fold below is also the measurement that killed the alternative design.
   * `hasFinishedOnboarding` answers TRUE for this reader — it is org-scoped on
   * both arms — so an exclusion keyed on it would suppress the prompt here, and
   * this reader is ISS-11670 defect 3 by name: "a new user joining an
   * established org is never prompted at all". A future gate that quietly
   * re-adopts the org-scoped answer goes red here.
   */
  it("still offers the invite step to a reader with no run, in an established org", async () => {
    install({
      attempts: [],
      users: [userRow(USER_A, ORG_A), userRow(USER_A_TEAMMATE, ORG_A)],
      // A team and a project on a pre-guided organization are what
      // `isOnboardingWizardCompleted` infers a finished org from, so this reader
      // is folded to Ready and the sidebar card projects its checklist.
      teams: [{ id: "team-1", organizationId: ORG_A }],
      projects: [{ id: "project-1", organizationId: ORG_A }],
    });

    const snapshot = await read();

    expect(snapshot.attemptId).toBeNull();
    expect(snapshot.state.phase).toBe(OnboardingPhase.Ready);
    expect(snapshot.context.teamInvited).toBe(false);
    expect(
      listPendingOnboardingSteps({
        ...snapshot.context,
        analysisStarted: true,
        host: OnboardingHost.Web,
        organizationActive: KnownFlag.Unknown,
        syncConsentRecorded: KnownFlag.No,
      })
    ).toContain(PendingOnboardingStep.InviteTeam);
  });

  /*
   * COHORT 1: an existing user the migration's INSERT reached. Operator ruling
   * 2026-09-30: "actually, nevermind - let's do a backfill for existing users to
   * set it; that's the most appropriate."
   *
   * The row below is that backfill's output, verbatim from the migration —
   * `settledOnboardingState`'s own serialized shape, `revision: 0`, and the
   * marker set. Seeded in the SAME established two-member org as cohort 3 above,
   * so the exclusion has to come from the row rather than from a quieter
   * fixture. It also pins that the synthetic state RESTORES: anything the
   * restorer rejected would recover to `Welcome`, which is blocking, and hand
   * every existing user a full-screen first run.
   */
  it("takes the invite step off an existing reader the backfill gave a run row", async () => {
    const backfilledAt = new Date("2026-09-30T18:00:00.000Z");
    install({
      users: [userRow(USER_A, ORG_A), userRow(USER_A_TEAMMATE, ORG_A)],
      teams: [{ id: "team-1", organizationId: ORG_A }],
      projects: [{ id: "project-1", organizationId: ORG_A }],
      attempts: [
        attemptRow({
          id: "attempt-backfilled",
          revision: 0,
          state: {
            version: 1,
            phase: OnboardingPhase.Ready,
            history: [OnboardingPhase.DashboardAvailable],
            accountProvider: null,
            resuming: false,
            organizationEstablished: true,
          },
          invitesSentAt: backfilledAt,
          createdAt: backfilledAt,
        }),
      ],
    });

    const snapshot = await read();

    expect(snapshot.restoreOutcome).toBe(OnboardingRestoreOutcome.Restored);
    expect(snapshot.state.phase).toBe(OnboardingPhase.Ready);
    expect(snapshot.context.teamInvited).toBe(true);
    expect(
      listPendingOnboardingSteps({
        ...snapshot.context,
        analysisStarted: true,
        host: OnboardingHost.Web,
        organizationActive: KnownFlag.Unknown,
        syncConsentRecorded: KnownFlag.No,
      })
    ).not.toContain(PendingOnboardingStep.InviteTeam);
  });

  it("counts the caller's own active GitHub grant as connected with no installation", async () => {
    // ISS-11246. The onboarding step's CTA opens a PERSONAL Clerk OAuth link and
    // never the org App install, so an installation-only predicate left the
    // deferred-step card offering "Connect GitHub" forever to a reader who had
    // already done exactly what it asked. Drive the real service against the
    // grant row the CTA actually writes.
    install({
      githubUserConnections: [githubUserConnectionRow(ORG_A, USER_A)],
    });

    const snapshot = await read();

    expect(snapshot.context.githubConnected).toBe(true);
  });

  it("does not count another member's grant, a revoked one, or one without repo scope", async () => {
    // The widening is the CALLER's own usable grant and nothing else: a
    // predicate that answered `true` for any of these would mark the step done
    // for a reader whose GitHub data is not reachable.
    install({
      users: [userRow(USER_A, ORG_A), userRow(USER_A_TEAMMATE, ORG_A)],
      githubUserConnections: [githubUserConnectionRow(ORG_A, USER_A_TEAMMATE)],
    });
    const teammateOnly = await read();

    install({
      githubUserConnections: [
        githubUserConnectionRow(ORG_A, USER_A, { revokedAt: new Date() }),
      ],
    });
    const revoked = await read();

    install({
      githubUserConnections: [
        githubUserConnectionRow(ORG_A, USER_A, { scopes: ["read:user"] }),
      ],
    });
    const insufficientScope = await read();

    expect(teammateOnly.context.githubConnected).toBe(false);
    expect(revoked.context.githubConnected).toBe(false);
    expect(insufficientScope.context.githubConnected).toBe(false);
  });

  it("reads the GitHub installation once per snapshot, not once per predicate term", async () => {
    // The grant read goes through `resolveGitHubDataConnectionStatus`, which
    // runs its OWN ACTIVE installation query unless `hasActiveInstallation` is
    // supplied. The sibling read here is strictly wider and is ORed with it, so
    // the resolver's copy would be a second pooled connection per snapshot —
    // and every transition response composes one.
    const db = install({
      installations: [installationRow(ORG_A)],
      githubUserConnections: [githubUserConnectionRow(ORG_A, USER_A)],
    });

    const snapshot = await read();

    // Presence beside the count: the delegate this asserts on is genuinely the
    // one the snapshot reads, so `1` is a real ceiling and not an unresolved
    // locator.
    expect(snapshot.context.githubConnected).toBe(true);
    expect(db.delegates.gitHubInstallation.findFirst).toHaveBeenCalledTimes(1);
  });

  it("counts a suspended GitHub installation as connected and no installation as not", async () => {
    install({
      installations: [
        installationRow(ORG_A, GitHubInstallationStatus.SUSPENDED),
      ],
    });
    const connected = await read();

    install({
      installations: [
        installationRow(ORG_A, GitHubInstallationStatus.UNINSTALLED),
      ],
    });
    const uninstalled = await read();

    expect(connected.context.githubConnected).toBe(true);
    expect(uninstalled.context.githubConnected).toBe(false);
  });

  it("ignores the cloud sentinel compute target for desktopAppDownloaded", async () => {
    install({
      computeTargets: [
        computeTargetRow(ORG_A, USER_A, /* isCloudSentinel */ true),
      ],
    });
    const sentinelOnly = await read();

    install({ computeTargets: [computeTargetRow(ORG_A, USER_A)] });
    const realDevice = await read();

    expect(sentinelOnly.context.desktopAppDownloaded).toBe(false);
    expect(realDevice.context.desktopAppDownloaded).toBe(true);
  });

  it("does not tick desktopAppDownloaded from a teammate's install", async () => {
    install({
      computeTargets: [computeTargetRow(ORG_A, USER_A_TEAMMATE)],
    });

    const snapshot = await read();

    expect(snapshot.context.desktopAppDownloaded).toBe(false);
  });

  it("honours the download marker before the device has registered", async () => {
    install({
      attempts: [
        attemptRow({ id: "attempt-1", desktopDownloadedAt: new Date() }),
      ],
    });

    const snapshot = await read();

    expect(snapshot.context.desktopAppDownloaded).toBe(true);
  });

  it("reads tourCompleted from the run's own marker", async () => {
    install({ attempts: [attemptRow({ id: "attempt-1" })] });
    const untouched = await read();

    install({
      attempts: [attemptRow({ id: "attempt-1", tourCompletedAt: new Date() })],
    });
    const marked = await read();

    expect(untouched.context.tourCompleted).toBe(false);
    expect(marked.context.tourCompleted).toBe(true);
  });

  /*
   * ISS-11256, a DELIBERATE behavior change: this used to report
   * `AccountStatus.Skipped` whenever `accountSkippedAt` was set. Only an
   * authenticated principal can reach either guided route, so every writer of
   * that marker already held an account and every reader still does — the marker
   * records a past deferral and can never mean the account is absent. Because it
   * is write-once, the old reading was permanent, which is the checklist loop
   * this case's second and third assertions pin.
   */
  it("reports an established account even after the run skipped the step", async () => {
    install({
      attempts: [attemptRow({ id: "attempt-1", accountSkippedAt: new Date() })],
    });

    const desktop = await read(OnboardingHost.Desktop);

    // The checklist consequence, not just the enum: this is the projection
    // `guided-getting-started-card` builds, and its FIRST entry is the item the
    // card offers. Under the old derivation `CreateAccount` outranked every
    // outstanding step here (`PENDING_STEP_RANK` = 1) and resuming it re-entered
    // `OnboardingPhase.Account`.
    const checklist = listPendingOnboardingSteps({
      ...desktop.context,
      analysisStarted: true,
      host: OnboardingHost.Desktop,
      organizationActive: KnownFlag.Unknown,
      syncConsentRecorded: KnownFlag.No,
    });

    // Checklist first, deliberately: an `expect` that fails stops the case, so
    // asserting the enum ahead of the consequence would leave the consequence
    // unproven under the very mutation it exists to catch.
    expect(checklist).not.toContain(PendingOnboardingStep.CreateAccount);
    expect(checklist[0]).toBe(PendingOnboardingStep.ConnectGitHub);
    expect(desktop.context.accountStatus).toBe(AccountStatus.Established);
  });

  it("maps Clerk's OAuth providers onto the account provider, GitHub first", async () => {
    install();
    mocks.getUserExternalAccountProviders.mockResolvedValue([
      "oauth_google",
      "oauth_github",
    ]);
    const both = await read();

    mocks.getUserExternalAccountProviders.mockResolvedValue(["oauth_google"]);
    const googleOnly = await read();

    mocks.getUserExternalAccountProviders.mockResolvedValue(["oauth_gitlab"]);
    const unknownProvider = await read();

    mocks.getUserExternalAccountProviders.mockResolvedValue(["oauth_email"]);
    const emailProvider = await read();

    expect(both.context.accountProvider).toBe(AccountProvider.GitHub);
    expect(googleOnly.context.accountProvider).toBe(AccountProvider.Google);
    expect(unknownProvider.context.accountProvider).toBeNull();
    expect(emailProvider.context.accountProvider).toBeNull();
  });

  it("preserves the stored email account action across snapshot refreshes", async () => {
    install({
      attempts: [
        attemptRow({
          id: "attempt-1",
          state: {
            ...persistedAccountState(),
            accountProvider: AccountProvider.Email,
          },
        }),
      ],
    });
    mocks.getUserExternalAccountProviders.mockResolvedValue(["oauth_email"]);

    const snapshot = await read();

    expect(snapshot.state.accountProvider).toBe(AccountProvider.Email);
    expect(snapshot.context.accountProvider).toBe(AccountProvider.Email);
  });
});

/**
 * ISS-9916: an account that already finished onboarding is not on a first run.
 *
 * The defect these pin is not cosmetic. Every phase but the last three is a
 * blocking phase, the guided dialog opens on any of them, and the machine's
 * default for an account with no attempt row is `Welcome` — so before this
 * guard, every account that onboarded before ISS-8375 shipped got a full-screen
 * first-run takeover over the authenticated shell on load, which is what took
 * the stage `@smoke` lane down for a day.
 *
 * The negative control is the sibling suite's "reports a first run without
 * creating a row": an organization with no wizard record, no teams and no
 * projects still starts at `Welcome`, so these cases cannot pass by suppressing
 * the run for everyone.
 */
describe("guidedOnboardingSnapshotService.getSnapshot — already onboarded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserExternalAccountProviders.mockResolvedValue([]);
    mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.No);
  });

  it("reports a settled run for an organization that completed the wizard", async () => {
    const db = install({ organizations: [onboardedOrganizationRow(ORG_A)] });

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.Ready);
    // Nothing was stored, and `restoreOutcome` describes the STORED payload.
    expect(snapshot.restoreOutcome).toBe(OnboardingRestoreOutcome.Absent);
    expect(db.attempts).toHaveLength(0);
    // The wire field the client reads to tell this settled run apart from one
    // that genuinely deferred its tour: same phase, same absent completion
    // record, and only the missing row separates them. Reporting an id here
    // would arm the dashboard tour for every legacy-complete organization —
    // `isDashboardTourRequestedByRun`, ISS-9916.
    expect(snapshot.attemptId).toBeNull();
  });

  it("reports a settled run for a legacy organization with no wizard record", async () => {
    // Created before the wizard could record a completion, so the
    // teams-and-projects inference is the only evidence there could be.
    install({
      organizations: [organizationRow(ORG_A)],
      projects: [projectRow(ORG_A)],
      teams: [teamRow(ORG_A)],
    });

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.Ready);
  });

  it("does not treat teams alone, or projects alone, as onboarding", async () => {
    install({
      organizations: [organizationRow(ORG_A)],
      teams: [teamRow(ORG_A)],
    });
    const teamsOnly = await read();

    install({
      organizations: [organizationRow(ORG_A)],
      projects: [projectRow(ORG_A)],
    });
    const projectsOnly = await read();

    expect(teamsOnly.state.phase).toBe(OnboardingPhase.Welcome);
    expect(projectsOnly.state.phase).toBe(OnboardingPhase.Welcome);
  });

  it("does not count another organization's teams and projects", async () => {
    install({
      organizations: [organizationRow(ORG_A)],
      projects: [projectRow(ORG_B)],
      teams: [teamRow(ORG_B)],
    });

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.Welcome);
  });

  it("settles a run already parked on a blocking phase", async () => {
    // The stage shape: a persisted row left mid-wizard by an earlier load. The
    // guard has to reach it too, or the account stays behind the dialog forever.
    // Written before the fold shipped, which is when such a load could happen.
    const db = install({
      attempts: [
        attemptRow({
          id: "attempt-1",
          revision: 4,
          createdAt: PRE_FOLD_ATTEMPT_CREATED_AT,
        }),
      ],
      organizations: [onboardedOrganizationRow(ORG_A)],
    });

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.Ready);
    // A GET still never writes: the stored row keeps its blocking phase.
    expect(db.delegates.onboardingAttempt.writes).toHaveLength(0);
    expect(snapshot.revision).toBe(4);
  });

  it("settles a live run the reading host cannot restore", async () => {
    // ISS-11036 keeps a live run; a row this host recovers to a fresh Welcome is
    // not the reader's position, so the absent-evidence fold still applies.
    install({
      attempts: [
        attemptRow({
          id: "attempt-1",
          state: persistedDownloadDesktopState(),
        }),
      ],
      organizations: [onboardedOrganizationRow(ORG_A)],
    });

    const snapshot = await read(OnboardingHost.Desktop);

    expect(snapshot.restoreOutcome).toBe(
      OnboardingRestoreOutcome.UnreachableOnHost
    );
    expect(snapshot.state.phase).toBe(OnboardingPhase.Ready);
  });

  it("keeps a live run the fold used to hide at the step it stopped on", async () => {
    // ISS-11036: a Desktop guest's handoff into a finished organization, written
    // after the fold shipped and never advanced because the fold answered it
    // with Ready. The reader's own unfinished run, not a stale takeover.
    install({
      attempts: [
        attemptRow({
          id: "attempt-1",
          state: persistedOrganizationStepState(
            OnboardingPhase.ChooseOrganization
          ),
        }),
      ],
      organizations: [onboardedOrganizationRow(ORG_A)],
    });

    const snapshot = await read(OnboardingHost.Desktop);

    expect(snapshot.state.phase).toBe(OnboardingPhase.ChooseOrganization);
  });

  it("keeps a live run an ISS-10624-era Desktop build stored in its own order", async () => {
    install({
      attempts: [
        attemptRow({
          id: "attempt-1",
          state: persistedOrganizationStepState(
            OnboardingPhase.ChooseOrganization,
            [
              OnboardingPhase.Welcome,
              OnboardingPhase.SyncPolicy,
              OnboardingPhase.SessionDiscovery,
              OnboardingPhase.Account,
            ]
          ),
        }),
      ],
      organizations: [onboardedOrganizationRow(ORG_A)],
    });

    const snapshot = await read(OnboardingHost.Desktop);

    expect(snapshot.restoreOutcome).toBe(OnboardingRestoreOutcome.Restored);
    expect(snapshot.state.phase).toBe(OnboardingPhase.ChooseOrganization);
  });

  it("reads a live CreateOrganization run as that step done on Web too", async () => {
    install({
      attempts: [
        attemptRow({
          id: "attempt-1",
          state: persistedOrganizationStepState(
            OnboardingPhase.CreateOrganization,
            [OnboardingPhase.Welcome]
          ),
        }),
      ],
      organizations: [onboardedOrganizationRow(ORG_A)],
    });

    const snapshot = await read(OnboardingHost.Web);

    expect(snapshot.state.phase).toBe(OnboardingPhase.InviteTeam);
    expect(snapshot.state.history).toEqual([
      OnboardingPhase.Welcome,
      OnboardingPhase.CreateOrganization,
    ]);
    expect(
      restoreOnboardingState(snapshot.state, OnboardingHost.Web).outcome
    ).toBe(OnboardingRestoreOutcome.Restored);
  });

  it("does not infer onboarding from teams and projects after the wizard shipped", async () => {
    // ISS-10339. The other side of the boundary the case above covers: this
    // organization is new enough to have carried a completion marker, so the
    // absence of one is information rather than a gap — and folding on the
    // inference instead suppressed the dialog for it permanently, since the
    // fold is recomputed on every read.
    install({
      organizations: [currentEraOrganizationRow(ORG_A)],
      projects: [projectRow(ORG_A)],
      teams: [teamRow(ORG_A)],
    });

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.Welcome);
  });

  it("folds a post-cutoff organization on the completion marker alone", async () => {
    // ISS-10339. The post-cutoff arm that still folds, and the one every other
    // folding case in this file misses: they all seed
    // `onboardedOrganizationRow`, which is pre-cutoff, so nothing pinned that
    // the marker by itself is enough on the new side of the boundary. No team
    // and no project row here — the inference is refused for this era, so the
    // marker is the only thing that can produce the fold.
    install({ organizations: [currentEraOnboardedOrganizationRow(ORG_A)] });

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.Ready);
  });

  it("leaves a step resumed from the completion card alone", async () => {
    // The Continue path, which the settled fold must not reach: the card
    // dispatches `ResumePendingStep`, that writes a phase-backed `resuming`
    // run, and the settle comes straight back through `getSnapshot`. Folding
    // it to `Ready` closes the dialog the click just opened and re-offers the
    // same step, so the user can never finish it.
    install({
      attempts: [
        attemptRow({
          id: "attempt-1",
          state: persistedResumedConnectGitHubState(),
        }),
      ],
      organizations: [onboardedOrganizationRow(ORG_A)],
    });

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.ConnectGitHub);
    expect(snapshot.state.resuming).toBe(true);
  });

  it("leaves a finished resumed step on DashboardAvailable", async () => {
    // The exit from the Continue path. Every transition response is composed
    // through `getSnapshot`, so folding this to `Ready` means the host never
    // observes `DashboardAvailable` and never runs `onDashboardAvailable` —
    // the dashboard handoff the machine still owes is skipped silently.
    install({
      attempts: [
        attemptRow({
          id: "attempt-1",
          state: persistedPostResumeDashboardState(),
        }),
      ],
      organizations: [onboardedOrganizationRow(ORG_A)],
    });

    const snapshot = await read();

    expect(snapshot.state.phase).toBe(OnboardingPhase.DashboardAvailable);
  });

  it("reports a settled run the CLIENT can restore, not one it recovers to Welcome", async () => {
    install({ organizations: [onboardedOrganizationRow(ORG_A)] });

    const snapshot = await read();
    const restored = restoreOnboardingState(snapshot.state, OnboardingHost.Web);

    // `Ready` with an empty history is unreachable, and the client re-parses
    // this exact payload. A settled state that failed here would recover to a
    // fresh `Welcome` in the browser and reopen the dialog it exists to close.
    expect(restored.outcome).toBe(OnboardingRestoreOutcome.Restored);
    expect(restored.state.phase).toBe(OnboardingPhase.Ready);
  });
});

/** A live run parked on an organization step, as a Desktop guest hands it off. */
function persistedOrganizationStepState(
  phase: OnboardingPhase,
  history: OnboardingPhase[] = [
    OnboardingPhase.Welcome,
    OnboardingPhase.SessionDiscovery,
    OnboardingPhase.Account,
  ]
): PersistedOnboardingState {
  return {
    version: ONBOARDING_STATE_VERSION,
    phase,
    history,
    accountProvider: null,
    resuming: false,
    organizationEstablished: false,
  };
}
