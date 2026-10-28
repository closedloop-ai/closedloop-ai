/**
 * ISS-8375 concurrency and marker semantics for the transition service, driven
 * against the shared Prisma-semantics double so the compare-and-swap is decided
 * by a real `where` and a real row count.
 */

import { KnownFlag } from "@repo/api/src/types/onboarding-phase";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  getUserExternalAccountProviders: vi.fn(),
  organizationHasSyncedSessionData: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: mocks.withDb,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: mocks.logError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
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
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import {
  GUIDED_ONBOARDING_MAX_REVISION,
  type GuidedOnboardingTransitionRequest,
  ONBOARDING_REVISION_COLUMN_MAX,
} from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  OnboardingHost,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { Status } from "@repo/api/src/types/result";
import {
  createGuidedOnboardingDb,
  type FakeAttemptRow,
  type GuidedOnboardingDb,
  type GuidedOnboardingSeed,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-db";
import {
  attemptRow,
  CLERK_USER_A,
  EXPERIENCE_VARIANT,
  githubUserConnectionRow,
  ORG_A,
  organizationRow,
  persistedAccountState,
  persistedDownloadDesktopState,
  persistedReadyState,
  persistedSyncPolicyAfterOrganizationState,
  transitionCommand,
  USER_A,
  unreachableReadyState,
  userRow,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-fixtures";
import {
  expectAccepted,
  expectRejected,
  expectSnapshot,
  settledAs,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-helpers";
import { guidedOnboardingSnapshotService } from "../snapshot-service";
import {
  GuidedTransitionOutcome,
  guidedOnboardingTransitionService,
} from "../transition-service";

const ATTEMPT_ID = "attempt-1";
const SEEDED_REVISION = 3;
const OTHER_VARIANT = "web-master-v3";

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

function apply(command: GuidedOnboardingTransitionRequest) {
  return guidedOnboardingTransitionService.apply({
    organizationId: ORG_A,
    userId: USER_A,
    clerkUserId: CLERK_USER_A,
    command,
  });
}

function onlyRow(db: GuidedOnboardingDb): FakeAttemptRow {
  const row = db.attempts[0];
  if (!row) {
    throw new Error("expected the run to exist");
  }
  return row;
}

const CLERK_DOWN = new Error("clerk unavailable");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserExternalAccountProviders.mockResolvedValue([]);
  mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.No);
});

describe("guidedOnboardingTransitionService.apply — first transition", () => {
  it("creates the run one revision ahead of the first-run snapshot", async () => {
    const db = install();
    const command = transitionCommand({ revision: 0 });

    const result = await apply(command);

    const accepted = expectAccepted(result);
    expect(accepted.outcome).toBe(GuidedTransitionOutcome.Accepted);
    const snapshot = expectSnapshot(accepted);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.experienceVariant).toBe(EXPERIENCE_VARIANT);
    expect(snapshot.restoreOutcome).toBe(OnboardingRestoreOutcome.Restored);
    expect(onlyRow(db).lastCommandId).toBe(command.commandId);
  });

  it("refuses a command that quotes a revision no run ever reached", async () => {
    const db = install();

    const result = await apply(transitionCommand({ revision: 4 }));

    const rejection = expectRejected(result);
    expect(rejection.status).toBe(Status.Conflict);
    const snapshot = expectSnapshot(rejection);
    expect(snapshot.attemptId).toBeNull();
    expect(snapshot.revision).toBe(0);
    expect(db.attempts).toHaveLength(0);
  });

  it("settles the loser of a create race as a conflict, not a second run", async () => {
    const db = install();

    const [first, second] = await Promise.all([
      apply(transitionCommand({ revision: 0 })),
      apply(transitionCommand({ revision: 0 })),
    ]);

    expect([settledAs(first), settledAs(second)].sort()).toEqual(
      [GuidedTransitionOutcome.Accepted, String(Status.Conflict)].sort()
    );
    expect(db.attempts).toHaveLength(1);
    expect(onlyRow(db).revision).toBe(1);
  });
});

describe("guidedOnboardingTransitionService.apply — compare-and-swap", () => {
  it("persists a Web GitHub connection transition across a fresh snapshot read", async () => {
    const downloadState = persistedDownloadDesktopState();
    const connectState = {
      ...downloadState,
      phase: OnboardingPhase.ConnectGitHub,
      history: [...downloadState.history, OnboardingPhase.DownloadDesktop],
      accountProvider: AccountProvider.GitHub,
    };
    const dashboardState = {
      ...connectState,
      phase: OnboardingPhase.DashboardAvailable,
      history: [...connectState.history, OnboardingPhase.ConnectGitHub],
    };
    const grants: NonNullable<GuidedOnboardingSeed["githubUserConnections"]> =
      [];
    const db = install({
      attempts: [
        attemptRow({
          id: ATTEMPT_ID,
          revision: SEEDED_REVISION,
          state: connectState,
        }),
      ],
      githubUserConnections: grants,
    });

    const before = await guidedOnboardingSnapshotService.getSnapshot({
      organizationId: ORG_A,
      userId: USER_A,
      clerkUserId: CLERK_USER_A,
      host: OnboardingHost.Web,
    });
    expect(before.state.phase).toBe(OnboardingPhase.ConnectGitHub);
    expect(before.context.githubConnected).toBe(false);

    grants.push(githubUserConnectionRow(ORG_A, USER_A));
    const command = transitionCommand({
      revision: before.revision,
      event: { type: OnboardingEvent.ConnectGitHub },
      state: dashboardState,
    });
    const accepted = expectAccepted(await apply(command));
    expect(accepted.outcome).toBe(GuidedTransitionOutcome.Accepted);
    expect(onlyRow(db).state).toEqual(dashboardState);

    const after = await guidedOnboardingSnapshotService.getSnapshot({
      organizationId: ORG_A,
      userId: USER_A,
      clerkUserId: CLERK_USER_A,
      host: OnboardingHost.Web,
    });
    expect(after.attemptId).toBe(ATTEMPT_ID);
    expect(after.revision).toBe(SEEDED_REVISION + 1);
    expect(after.restoreOutcome).toBe(OnboardingRestoreOutcome.Restored);
    expect(after.state).toEqual(dashboardState);
    expect(after.context.githubConnected).toBe(true);

    const replay = expectAccepted(await apply(command));
    expect(replay.outcome).toBe(GuidedTransitionOutcome.Replayed);
    expect(expectSnapshot(replay).revision).toBe(after.revision);
    expect(onlyRow(db).revision).toBe(after.revision);

    const stale = expectRejected(
      await apply(
        transitionCommand({
          revision: before.revision,
          event: { type: OnboardingEvent.ConnectGitHub },
          state: dashboardState,
        })
      )
    );
    expect(stale.status).toBe(Status.Conflict);
    expect(expectSnapshot(stale).state).toEqual(dashboardState);
    expect(onlyRow(db).revision).toBe(after.revision);
  });

  it("accepts a command at the current revision and moves it by one", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });
    const command = transitionCommand({
      revision: SEEDED_REVISION,
      state: persistedReadyState(),
    });

    const result = await apply(command);

    const accepted = expectAccepted(result);
    expect(accepted.outcome).toBe(GuidedTransitionOutcome.Accepted);
    const snapshot = expectSnapshot(accepted);
    expect(snapshot.revision).toBe(SEEDED_REVISION + 1);
    expect(snapshot.state.phase).toBe(OnboardingPhase.Ready);
    expect(onlyRow(db).revision).toBe(SEEDED_REVISION + 1);
  });

  it("accepts the saved-policy continuation of a recovered legacy discovery at its existing revision", async () => {
    const legacyState = serializeOnboardingState({
      phase: OnboardingPhase.SessionDiscovery,
      history: [OnboardingPhase.Welcome],
      accountProvider: AccountProvider.GitHub,
      organizationEstablished: true,
      resuming: false,
    });
    const db = install({
      attempts: [
        attemptRow({
          id: ATTEMPT_ID,
          host: OnboardingHost.Desktop,
          revision: SEEDED_REVISION,
          state: legacyState,
        }),
      ],
    });
    const stateAfterSave = {
      ...legacyState,
      history: [OnboardingPhase.Welcome, OnboardingPhase.SyncPolicy],
    };
    const command = transitionCommand({
      host: OnboardingHost.Desktop,
      revision: SEEDED_REVISION,
      event: { type: OnboardingEvent.ContinueFromSyncPolicy },
      state: stateAfterSave,
    });
    const accepted = expectAccepted(await apply(command));
    expect(accepted.outcome).toBe(GuidedTransitionOutcome.Accepted);
    expect(onlyRow(db).state).toEqual(stateAfterSave);
    expect(onlyRow(db).revision).toBe(SEEDED_REVISION + 1);
    const snapshot = expectSnapshot(accepted);
    expect(snapshot.state).toEqual(stateAfterSave);
    expect(snapshot.restoreOutcome).toBe(OnboardingRestoreOutcome.Restored);
  });

  it("swaps at the largest accepted revision without overflowing the column", async () => {
    // The accepted maximum is one BELOW the column's, because the swap WRITES
    // `revision + 1`. Raising the accepted bound to the column's own maximum
    // makes this write 2_147_483_648 and Prisma rejects it -- a correctly
    // versioned command 500ing at the last revision a run could reach. Asserting
    // the WRITTEN value against the column bound is what kills that mutation;
    // the route-level bound test cannot, because it mocks the service away.
    const db = install({
      attempts: [
        attemptRow({
          id: ATTEMPT_ID,
          revision: GUIDED_ONBOARDING_MAX_REVISION,
        }),
      ],
    });

    const result = await apply(
      transitionCommand({ revision: GUIDED_ONBOARDING_MAX_REVISION })
    );

    expectAccepted(result);
    const written = onlyRow(db).revision;
    expect(written).toBe(GUIDED_ONBOARDING_MAX_REVISION + 1);
    expect(written).toBeLessThanOrEqual(ONBOARDING_REVISION_COLUMN_MAX);
  });

  it("answers a stale revision with a conflict carrying the CURRENT snapshot", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });

    const result = await apply(
      transitionCommand({
        revision: SEEDED_REVISION - 1,
        state: persistedReadyState(),
      })
    );

    const rejection = expectRejected(result);
    expect(rejection.status).toBe(Status.Conflict);
    const snapshot = expectSnapshot(rejection);
    expect(snapshot.revision).toBe(SEEDED_REVISION);
    // The client gets the state the server actually holds, so it can reconcile
    // instead of retrying the same losing command.
    expect(snapshot.state).toEqual(persistedAccountState());
    expect(onlyRow(db).revision).toBe(SEEDED_REVISION);
    expect(onlyRow(db).state).toEqual(persistedAccountState());
  });

  it("lets exactly one of two commands at the same revision through", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });

    const [first, second] = await Promise.all([
      apply(transitionCommand({ revision: SEEDED_REVISION })),
      apply(transitionCommand({ revision: SEEDED_REVISION })),
    ]);

    expect([settledAs(first), settledAs(second)].sort()).toEqual(
      [GuidedTransitionOutcome.Accepted, String(Status.Conflict)].sort()
    );
    expect(onlyRow(db).revision).toBe(SEEDED_REVISION + 1);
  });

  it("treats a redelivered command as a no-op, not a second increment", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });
    const command = transitionCommand({
      revision: SEEDED_REVISION,
      event: { type: OnboardingEvent.SkipAccount },
    });

    const accepted = await apply(command);
    const markedAt = onlyRow(db).accountSkippedAt;
    const replayed = await apply(command);

    expect(expectAccepted(accepted).outcome).toBe(
      GuidedTransitionOutcome.Accepted
    );
    const settledReplay = expectAccepted(replayed);
    expect(settledReplay.outcome).toBe(GuidedTransitionOutcome.Replayed);
    expect(expectSnapshot(settledReplay).revision).toBe(SEEDED_REVISION + 1);
    expect(onlyRow(db).revision).toBe(SEEDED_REVISION + 1);
    // A redelivery must not restamp a marker: the timestamp records when the
    // step was taken, and moving it would rewrite a measured fact.
    expect(onlyRow(db).accountSkippedAt).toBe(markedAt);
  });

  it("keeps the variant and host the run was created with", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });

    const result = await apply(
      transitionCommand({
        revision: SEEDED_REVISION,
        experienceVariant: OTHER_VARIANT,
        host: OnboardingHost.Desktop,
      })
    );

    expect(expectSnapshot(expectAccepted(result)).experienceVariant).toBe(
      EXPERIENCE_VARIANT
    );
    expect(onlyRow(db).experienceVariant).toBe(EXPERIENCE_VARIANT);
    expect(onlyRow(db).host).toBe(OnboardingHost.Web);
  });

  it("normalizes the accepted account provider into the persisted state", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });
    const commandState = {
      ...persistedAccountState(),
      phase: OnboardingPhase.CreateOrganization,
      history: [OnboardingPhase.Welcome, OnboardingPhase.Account],
    };

    const result = await apply(
      transitionCommand({
        revision: SEEDED_REVISION,
        event: {
          type: OnboardingEvent.AccountEstablished,
          provider: AccountProvider.Email,
        },
        state: commandState,
      })
    );

    const writtenState = {
      ...commandState,
      accountProvider: AccountProvider.Email,
    };
    const snapshot = expectSnapshot(expectAccepted(result));
    expect(onlyRow(db).state).toEqual(writtenState);
    expect(snapshot.state).toEqual(writtenState);
    expect(snapshot.context.accountProvider).toBe(AccountProvider.Email);
  });
});

describe("guidedOnboardingTransitionService.apply — markers", () => {
  it("writes each marker in the SAME statement as the state it belongs to", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });
    const command = transitionCommand({
      revision: SEEDED_REVISION,
      event: { type: OnboardingEvent.FinishTour },
      state: persistedReadyState(),
    });

    await apply(command);

    const writes = db.delegates.onboardingAttempt.writes;
    expect(writes).toHaveLength(1);
    const write = writes[0];
    expect(write?.method).toBe("updateMany");
    const data = write?.args.data as Record<string, unknown>;
    // State, revision, command id and BOTH markers in one statement: a marker
    // written separately could outlive a swap that lost the race.
    expect(data.state).toEqual(persistedReadyState());
    expect(data.revision).toBe(SEEDED_REVISION + 1);
    expect(data.lastCommandId).toBe(command.commandId);
    expect(data.tourCompletedAt).toBeInstanceOf(Date);
    expect(data.completedAt).toBeInstanceOf(Date);
  });

  it("records neither marker when the run only deferred the tour", async () => {
    // PLN-1875 Step 9. `defer_tour` reaches `Ready` exactly as `finish_tour`
    // does, so the two are indistinguishable by STATE — the event is the only
    // thing that separates them. Same state as the case above, so nothing but
    // the event can decide either marker here.
    //
    // NEITHER is stamped. `tourCompletedAt` would retire the tour for a reader
    // who was shown none of it; `completedAt` would report onboarding finished
    // for a reader whose dashboard FAILED, because a deferral is the client
    // saying a tour it could not show ended by itself and the wire carries no
    // reason separating a degraded dashboard from an empty org. The completion
    // is recorded on the next arrival at Ready instead — see the marker case
    // above, which is that `finish_tour`.
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });

    const result = await apply(
      transitionCommand({
        revision: SEEDED_REVISION,
        event: { type: OnboardingEvent.DeferTour },
        state: persistedReadyState(),
      })
    );

    const row = onlyRow(db);
    expect(row.tourCompletedAt).toBeNull();
    expect(row.completedAt).toBeNull();
    expect(expectSnapshot(expectAccepted(result)).context.tourCompleted).toBe(
      false
    );
  });

  /*
   * ISS-11256, a DELIBERATE behavior change in the second assertion: the
   * composed snapshot used to report `AccountStatus.Skipped` here. The marker
   * write is unchanged and still asserted — it is the event record — but only an
   * authenticated principal can post this command, so the account exists and the
   * status may not say otherwise. `snapshot-service.test.ts` carries the reading
   * change and the checklist consequence it produces.
   */
  it("stamps the account skip without unsetting the established account", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });

    const result = await apply(
      transitionCommand({
        revision: SEEDED_REVISION,
        event: { type: OnboardingEvent.SkipAccount },
      })
    );

    expect(onlyRow(db).accountSkippedAt).toBeInstanceOf(Date);
    expect(expectSnapshot(expectAccepted(result)).context.accountStatus).toBe(
      AccountStatus.Established
    );
  });

  /*
   * ISS-11670, operator ruling 2026-09-30: each new user is prompted to invite
   * teammates regardless of what the rest of the org has done. `teamInvited` is
   * therefore the per-user `invitesSentAt` marker rather than the org-scoped
   * derivation it used to be — and NEITHER invite event may write it. The
   * producer is the invitation send path
   * (`organizations/invitations/service.ts`), gated on `invited > 0`, because
   * `SendInvitations` is the step's Continue and Continue is also offered on an
   * `already_member` outcome that invited nobody. Stamping on the event would
   * re-raise the false "Invitations sent" state the ticket exists to remove.
   *
   * These two are the counterfactuals for that: both events must leave the
   * column alone, so a stamp reintroduced on either is red here.
   */
  it("stamps nothing when the reader continues from the invite step", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });

    const result = await apply(
      transitionCommand({
        revision: SEEDED_REVISION,
        event: { type: OnboardingEvent.SendInvitations },
      })
    );

    expect(onlyRow(db).invitesSentAt).toBeNull();
    expect(expectSnapshot(expectAccepted(result)).context.teamInvited).toBe(
      false
    );
  });

  it("stamps nothing when the reader skips the invite step", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });

    const result = await apply(
      transitionCommand({
        revision: SEEDED_REVISION,
        event: { type: OnboardingEvent.SkipInvitations },
      })
    );

    expect(onlyRow(db).invitesSentAt).toBeNull();
    expect(expectSnapshot(expectAccepted(result)).context.teamInvited).toBe(
      false
    );
  });

  /*
   * A send that DID land is carried into the run by the marker the send path
   * already wrote, so the reader's next read reports it whatever event they
   * post next — including the skip. This is the case that proves the step stops
   * asking, which no longer has an event of its own to hang on.
   */
  it("reports a marker the send path already wrote, and never rewrites it", async () => {
    const stamped = new Date("2026-09-20T00:00:00.000Z");
    const db = install({
      attempts: [
        attemptRow({
          id: ATTEMPT_ID,
          revision: SEEDED_REVISION,
          invitesSentAt: stamped,
        }),
      ],
    });

    const result = await apply(
      transitionCommand({
        revision: SEEDED_REVISION,
        event: { type: OnboardingEvent.SendInvitations },
      })
    );

    expect(onlyRow(db).invitesSentAt).toEqual(stamped);
    expect(expectSnapshot(expectAccepted(result)).context.teamInvited).toBe(
      true
    );
  });

  it("stamps the desktop download and surfaces it as downloaded", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });

    const result = await apply(
      transitionCommand({
        revision: SEEDED_REVISION,
        event: { type: OnboardingEvent.DownloadDesktopApp },
      })
    );

    expect(onlyRow(db).desktopDownloadedAt).toBeInstanceOf(Date);
    expect(
      expectSnapshot(expectAccepted(result)).context.desktopAppDownloaded
    ).toBe(true);
  });

  it("leaves markers alone on a transition that implies none", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });

    await apply(transitionCommand({ revision: SEEDED_REVISION }));

    const row = onlyRow(db);
    expect(row.accountSkippedAt).toBeNull();
    expect(row.desktopDownloadedAt).toBeNull();
    expect(row.tourCompletedAt).toBeNull();
    expect(row.completedAt).toBeNull();
  });

  it("records completion on the FIRST arrival at Ready and never moves it", async () => {
    const firstArrival = new Date("2026-08-01T00:00:00.000Z");
    const db = install({
      attempts: [
        attemptRow({
          id: ATTEMPT_ID,
          revision: SEEDED_REVISION,
          completedAt: firstArrival,
        }),
      ],
    });

    await apply(
      transitionCommand({
        revision: SEEDED_REVISION,
        commandId: randomUUID(),
        state: persistedReadyState(),
      })
    );

    // Ready is re-entered every time a resumed step finishes; restamping would
    // move completion to the last resume rather than the first arrival.
    expect(onlyRow(db).completedAt).toBe(firstArrival);
  });
});

/**
 * The write boundary refuses a state the read boundary would only RECOVER from.
 *
 * The recovery is not enough on its own: `markersFor` stamps `completedAt` from
 * the posted phase, and that timestamp is durable while the state self-heals on
 * the next read. So each case asserts the DATABASE, not just the status.
 *
 * The counterfactual lives one describe up: "accepts a command at the current
 * revision and moves it by one" posts `persistedReadyState()` — a Ready the
 * machine really can produce — and expects it through, so this guard cannot be
 * satisfied by refusing every Ready.
 */
describe("guidedOnboardingTransitionService.apply — unreachable state", () => {
  it("refuses a Ready the machine cannot produce, before creating any run", async () => {
    const db = install();

    const result = await apply(
      transitionCommand({ revision: 0, state: unreachableReadyState() })
    );

    const rejection = expectRejected(result);
    expect(rejection.status).toBe(Status.BadRequest);
    expect(rejection.snapshot).toBeNull();
    expect(db.attempts).toHaveLength(0);
    expect(db.delegates.onboardingAttempt.writes).toHaveLength(0);
  });

  it("refuses it against an existing run without stamping completion", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });

    const result = await apply(
      transitionCommand({
        revision: SEEDED_REVISION,
        state: unreachableReadyState(),
      })
    );

    // Asserted before the status, deliberately: `completedAt` is the DURABLE
    // half of this defect — the state heals on the next read, a stamped
    // completion does not — so this is the assertion that should name it.
    const row = onlyRow(db);
    expect(row.completedAt).toBeNull();
    expect(row.revision).toBe(SEEDED_REVISION);
    expect(row.state).toEqual(persistedAccountState());
    expect(db.delegates.onboardingAttempt.writes).toHaveLength(0);
    expect(expectRejected(result).status).toBe(Status.BadRequest);
  });

  it("refuses a phase the posting host cannot draw", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });

    // Reachable by the machine, and refused on the OTHER half of the boundary:
    // DownloadDesktop is Web-only, so Desktop can never have produced it.
    const result = await apply(
      transitionCommand({
        revision: SEEDED_REVISION,
        host: OnboardingHost.Desktop,
        state: persistedDownloadDesktopState(),
      })
    );

    expect(expectRejected(result).status).toBe(Status.BadRequest);
    expect(onlyRow(db).revision).toBe(SEEDED_REVISION);
    expect(db.delegates.onboardingAttempt.writes).toHaveLength(0);
  });

  it("accepts that same phase from the host that draws it", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });

    const result = await apply(
      transitionCommand({
        revision: SEEDED_REVISION,
        host: OnboardingHost.Web,
        state: persistedDownloadDesktopState(),
      })
    );

    // The host half of the guard has to discriminate, not refuse everything.
    expect(expectAccepted(result).outcome).toBe(
      GuidedTransitionOutcome.Accepted
    );
    expect(onlyRow(db).revision).toBe(SEEDED_REVISION + 1);
  });

  it("accepts a Desktop transition into the sync step after the organization step", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });

    // The ISS-10890 order.
    const result = await apply(
      transitionCommand({
        revision: SEEDED_REVISION,
        host: OnboardingHost.Desktop,
        state: persistedSyncPolicyAfterOrganizationState(),
      })
    );

    expect(expectAccepted(result).outcome).toBe(
      GuidedTransitionOutcome.Accepted
    );
    expect(onlyRow(db).revision).toBe(SEEDED_REVISION + 1);
  });
});

/**
 * A durable write is acknowledged truthfully even when the snapshot describing
 * it cannot be composed. The snapshot fan-out includes a live Clerk call, and a
 * 500 there would tell the client its transition failed when the row has
 * already moved.
 */
describe("guidedOnboardingTransitionService.apply — snapshot composition fails", () => {
  it("reports the accepted write with a null snapshot, and keeps the write", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });
    mocks.getUserExternalAccountProviders.mockRejectedValue(CLERK_DOWN);
    const command = transitionCommand({
      revision: SEEDED_REVISION,
      state: persistedReadyState(),
    });

    const result = await apply(command);

    const accepted = expectAccepted(result);
    expect(accepted.outcome).toBe(GuidedTransitionOutcome.Accepted);
    // `null`, never a snapshot with its guard inputs quietly sitting at false:
    // nothing was measured, and the client re-reads through GET.
    expect(accepted.snapshot).toBeNull();
    const row = onlyRow(db);
    expect(row.revision).toBe(SEEDED_REVISION + 1);
    expect(row.lastCommandId).toBe(command.commandId);
    expect(row.completedAt).toBeInstanceOf(Date);
  });

  it("logs the failure against the run it belongs to", async () => {
    install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });
    mocks.getUserExternalAccountProviders.mockRejectedValue(CLERK_DOWN);
    const command = transitionCommand({ revision: SEEDED_REVISION });

    await apply(command);

    expect(mocks.logError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        error: CLERK_DOWN,
        organizationId: ORG_A,
        userId: USER_A,
        commandId: command.commandId,
      })
    );
  });

  it("still reports the conflict rather than an error", async () => {
    const db = install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });
    mocks.getUserExternalAccountProviders.mockRejectedValue(CLERK_DOWN);

    const result = await apply(
      transitionCommand({ revision: SEEDED_REVISION - 1 })
    );

    const rejection = expectRejected(result);
    expect(rejection.status).toBe(Status.Conflict);
    expect(rejection.snapshot).toBeNull();
    expect(onlyRow(db).revision).toBe(SEEDED_REVISION);
  });

  it("composes the snapshot when every producer answers", async () => {
    install({
      attempts: [attemptRow({ id: ATTEMPT_ID, revision: SEEDED_REVISION })],
    });

    const result = await apply(
      transitionCommand({ revision: SEEDED_REVISION })
    );

    // The `null` above must come from the failure, not from a service that
    // never returns a snapshot at all.
    expect(expectAccepted(result).snapshot).not.toBeNull();
    expect(mocks.logError).not.toHaveBeenCalled();
  });
});
