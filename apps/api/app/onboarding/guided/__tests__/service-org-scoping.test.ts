/**
 * ISS-8375 authorization: a guided onboarding run is reachable only by the user
 * it belongs to, inside the organization it belongs to.
 *
 * Decided where it is decidable — the REAL services driven against a double
 * with Prisma's semantics, where **an absent `where` key constrains nothing**.
 * A route suite that mocked the service and asserted a status could not decide
 * any of this: the predicate lives in the module such a test replaces.
 *
 * Three rows make BOTH predicates falsifiable, and the seeding is load-bearing:
 *
 *  - the caller's run, and a run carrying the caller's user id in ANOTHER org.
 *    Drop `organizationId` and one query answers for both, so the two reads
 *    below cannot both hold and the write moves a row in an org the caller
 *    cannot see.
 *  - a teammate's run in the SAME org. Drop `userId` and the same thing happens
 *    across users.
 *
 * All three sit at the same revision on purpose: `updateMany` matches on the
 * compare-and-swap token too, so a foreign row at a different revision would be
 * spared by the token rather than by the predicate under test, and the case
 * would pass with the predicate deleted.
 *
 * A `User` row is itself org-scoped today, so `userId` alone would already
 * separate the two orgs — which is exactly why the org predicate would
 * otherwise be unfalsifiable, and why it is worth pinning: it is what refuses
 * the row if that ever stops being true.
 */

import { KnownFlag } from "@repo/api/src/types/onboarding-phase";
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

vi.mock("@/app/agent-sessions/organization-synced-session-data", () => ({
  organizationHasSyncedSessionData: mocks.organizationHasSyncedSessionData,
}));

import { OnboardingHost } from "@repo/api/src/types/onboarding-phase";
import { Status } from "@repo/api/src/types/result";
import {
  createGuidedOnboardingDb,
  type FakeAttemptRow,
  type GuidedOnboardingDb,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-db";
import {
  attemptRow,
  CLERK_USER_A,
  ORG_A,
  ORG_B,
  organizationRow,
  persistedAccountState,
  persistedReadyState,
  transitionCommand,
  USER_A,
  USER_A_TEAMMATE,
  USER_B,
  userRow,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-fixtures";
import {
  expectAccepted,
  expectRejected,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-helpers";
import { guidedOnboardingAttemptStore } from "../attempt-store";
import { guidedOnboardingSnapshotService } from "../snapshot-service";
import {
  GuidedTransitionOutcome,
  guidedOnboardingTransitionService,
} from "../transition-service";

const CALLER_ATTEMPT = "attempt-caller";
const TEAMMATE_ATTEMPT = "attempt-teammate";
const FOREIGN_ORG_ATTEMPT = "attempt-foreign-org";
/** Shared so the compare-and-swap token cannot stand in for the predicate. */
const SEEDED_REVISION = 3;

function install(): GuidedOnboardingDb {
  const db = createGuidedOnboardingDb({
    attempts: [
      attemptRow({ id: CALLER_ATTEMPT, revision: SEEDED_REVISION }),
      attemptRow({
        id: TEAMMATE_ATTEMPT,
        userId: USER_A_TEAMMATE,
        organizationId: ORG_A,
        revision: SEEDED_REVISION,
      }),
      attemptRow({
        id: FOREIGN_ORG_ATTEMPT,
        // Same user id, different organization: the row the org predicate is
        // there to refuse.
        userId: USER_A,
        organizationId: ORG_B,
        revision: SEEDED_REVISION,
      }),
    ],
    users: [
      userRow(USER_A, ORG_A),
      userRow(USER_A_TEAMMATE, ORG_A),
      userRow(USER_B, ORG_B),
    ],
    organizations: [organizationRow(ORG_A), organizationRow(ORG_B)],
  });
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db.client)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db.client)
  );
  return db;
}

function rowById(db: GuidedOnboardingDb, id: string): FakeAttemptRow {
  const row = db.attempts.find((candidate) => candidate.id === id);
  if (!row) {
    throw new Error(`seeded attempt ${id} is missing`);
  }
  return row;
}

function readAs(organizationId: string, userId: string) {
  return guidedOnboardingSnapshotService.getSnapshot({
    organizationId,
    userId,
    clerkUserId: CLERK_USER_A,
    host: OnboardingHost.Web,
  });
}

describe("guided onboarding reads are scoped to one user in one organization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserExternalAccountProviders.mockResolvedValue([]);
    mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.No);
  });

  it("separates two runs that share a user id across organizations", async () => {
    install();

    const inOrgA = await readAs(ORG_A, USER_A);
    const inOrgB = await readAs(ORG_B, USER_A);

    // Both halves together are the assertion: with `organizationId` gone from
    // the `where`, one query answers for both callers and they cannot both
    // hold, whichever row the read happens to land on.
    expect(inOrgA.attemptId).toBe(CALLER_ATTEMPT);
    expect(inOrgB.attemptId).toBe(FOREIGN_ORG_ATTEMPT);
  });

  it("separates two runs that share an organization across users", async () => {
    install();

    const asCaller = await readAs(ORG_A, USER_A);
    const asTeammate = await readAs(ORG_A, USER_A_TEAMMATE);

    expect(asCaller.attemptId).toBe(CALLER_ATTEMPT);
    expect(asTeammate.attemptId).toBe(TEAMMATE_ATTEMPT);
  });

  it("reports a first run for a member of another org who has none", async () => {
    install();

    const snapshot = await readAs(ORG_B, USER_B);

    // The org-B row belonging to USER_A's id must not stand in for one USER_B
    // never started.
    expect(snapshot.attemptId).toBeNull();
    expect(snapshot.revision).toBe(0);
  });
});

describe("guided onboarding writes are scoped to one user in one organization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserExternalAccountProviders.mockResolvedValue([]);
    mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.No);
  });

  it("moves the caller's row and ONLY the caller's row", async () => {
    const db = install();
    const command = transitionCommand({
      revision: SEEDED_REVISION,
      state: persistedReadyState(),
    });

    const result = await guidedOnboardingTransitionService.apply({
      organizationId: ORG_A,
      userId: USER_A,
      clerkUserId: CLERK_USER_A,
      command,
    });

    // Asserted before the outcome, deliberately: every other seeded row sits at
    // the same revision, so an `updateMany` missing either predicate sweeps it
    // up with the caller's — and this is the assertion that names the leaked
    // row rather than the downstream status it produces.
    for (const foreign of [
      rowById(db, FOREIGN_ORG_ATTEMPT),
      rowById(db, TEAMMATE_ATTEMPT),
    ]) {
      expect(foreign.revision).toBe(SEEDED_REVISION);
      expect(foreign.lastCommandId).toBeNull();
      expect(foreign.state).toEqual(persistedAccountState());
    }

    const caller = rowById(db, CALLER_ATTEMPT);
    expect(caller.revision).toBe(SEEDED_REVISION + 1);
    expect(caller.lastCommandId).toBe(command.commandId);
    expect(expectAccepted(result).outcome).toBe(
      GuidedTransitionOutcome.Accepted
    );
  });

  it("moves nothing at all when the caller's own command is stale", async () => {
    const db = install();

    const result = await guidedOnboardingTransitionService.apply({
      organizationId: ORG_A,
      userId: USER_A,
      clerkUserId: CLERK_USER_A,
      command: transitionCommand({
        revision: SEEDED_REVISION - 1,
        state: persistedReadyState(),
      }),
    });

    expect(expectRejected(result).status).toBe(Status.Conflict);
    for (const id of [CALLER_ATTEMPT, FOREIGN_ORG_ATTEMPT, TEAMMATE_ATTEMPT]) {
      const row = rowById(db, id);
      expect(row.revision).toBe(SEEDED_REVISION);
      expect(row.lastCommandId).toBeNull();
    }
  });

  /*
   * ISS-11670's per-user invites-sent marker is written OUTSIDE a transition, by
   * the invitation send path, so it carries neither the revision token nor the
   * command id the cases above lean on. Both scope predicates therefore have to
   * hold on their own here — the same three rows, at the same revision, so a
   * dropped `userId` or `organizationId` stamps a foreign run rather than being
   * spared by the token.
   */
  it("stamps the invites-sent marker on the caller's row and ONLY the caller's row", async () => {
    const db = install();

    const moved = await guidedOnboardingAttemptStore.markInvitesSent({
      organizationId: ORG_A,
      userId: USER_A,
    });

    expect(moved).toBe(1);
    expect(rowById(db, CALLER_ATTEMPT).invitesSentAt).toBeInstanceOf(Date);
    for (const id of [FOREIGN_ORG_ATTEMPT, TEAMMATE_ATTEMPT]) {
      expect(rowById(db, id).invitesSentAt).toBeNull();
      // Nothing else on a foreign row moves either: this write must not look
      // like a transition to a client that has one in flight.
      expect(rowById(db, id).revision).toBe(SEEDED_REVISION);
    }
    // Nor on the caller's own row — the marker is not a transition.
    expect(rowById(db, CALLER_ATTEMPT).revision).toBe(SEEDED_REVISION);
    expect(rowById(db, CALLER_ATTEMPT).lastCommandId).toBeNull();
  });

  it("leaves an already-stamped marker where it is", async () => {
    const stamped = new Date("2026-09-20T00:00:00.000Z");
    const db = install();
    rowById(db, CALLER_ATTEMPT).invitesSentAt = stamped;

    const moved = await guidedOnboardingAttemptStore.markInvitesSent({
      organizationId: ORG_A,
      userId: USER_A,
    });

    // Write-once lives in the `where`, so a second send moves no row at all
    // rather than moving a measured fact forward.
    expect(moved).toBe(0);
    expect(rowById(db, CALLER_ATTEMPT).invitesSentAt).toEqual(stamped);
  });

  it("stamps nothing for a caller who has no run", async () => {
    const db = install();

    const moved = await guidedOnboardingAttemptStore.markInvitesSent({
      organizationId: ORG_A,
      userId: USER_B,
    });

    expect(moved).toBe(0);
    for (const id of [CALLER_ATTEMPT, FOREIGN_ORG_ATTEMPT, TEAMMATE_ATTEMPT]) {
      expect(rowById(db, id).invitesSentAt).toBeNull();
    }
  });
});
