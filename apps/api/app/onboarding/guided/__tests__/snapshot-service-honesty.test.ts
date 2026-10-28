/**
 * ISS-8375: a snapshot never reports a fact it did not measure.
 *
 * Each producer is failed in turn and the read must reject. The assertion that
 * carries the weight is the NEGATIVE one: the case proves no snapshot came back
 * with that field quietly sitting at `false`, because a `false` here is
 * indistinguishable from a measured negative and each one silently grants or
 * denies a gate.
 *
 * The single exception is `organizationHasSyncedSessionData`, whose producer
 * carries its own tri-state; its cases assert `Unknown` survives as `Unknown`,
 * with the `Yes` counterfactual so the assertion cannot pass on a service stuck
 * at a single answer.
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
import {
  createGuidedOnboardingDb,
  type GuidedOnboardingDb,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-db";
import {
  attemptRow,
  CLERK_USER_A,
  computeTargetRow,
  installationRow,
  ORG_A,
  organizationRow,
  USER_A,
  userRow,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-fixtures";
import { guidedOnboardingSnapshotService } from "../snapshot-service";

const PRODUCER_DOWN = new Error("producer unavailable");

function install(): GuidedOnboardingDb {
  const db = createGuidedOnboardingDb({
    attempts: [attemptRow({ id: "attempt-1" })],
    users: [userRow(USER_A, ORG_A)],
    organizations: [organizationRow(ORG_A)],
    installations: [installationRow(ORG_A)],
    computeTargets: [computeTargetRow(ORG_A, USER_A)],
  });
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db.client)
  );
  return db;
}

function read() {
  return guidedOnboardingSnapshotService.getSnapshot({
    organizationId: ORG_A,
    userId: USER_A,
    clerkUserId: CLERK_USER_A,
    host: OnboardingHost.Web,
  });
}

describe("guidedOnboardingSnapshotService.getSnapshot — a failed producer is not a false", () => {
  let db: GuidedOnboardingDb;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserExternalAccountProviders.mockResolvedValue(["oauth_github"]);
    mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.Yes);
    db = install();
  });

  it("refuses the whole snapshot when the run itself cannot be read", async () => {
    db.delegates.onboardingAttempt.findFirst.mockRejectedValueOnce(
      PRODUCER_DOWN
    );

    await expect(read()).rejects.toThrow(PRODUCER_DOWN);
  });

  it("refuses the whole snapshot when the member count cannot be read", async () => {
    db.delegates.user.count.mockRejectedValueOnce(PRODUCER_DOWN);

    await expect(read()).rejects.toThrow(PRODUCER_DOWN);
  });

  it("refuses the whole snapshot when the GitHub installation cannot be read", async () => {
    db.delegates.gitHubInstallation.findFirst.mockRejectedValueOnce(
      PRODUCER_DOWN
    );

    await expect(read()).rejects.toThrow(PRODUCER_DOWN);
  });

  it("refuses the whole snapshot when the compute target cannot be read", async () => {
    db.delegates.computeTarget.findFirst.mockRejectedValueOnce(PRODUCER_DOWN);

    await expect(read()).rejects.toThrow(PRODUCER_DOWN);
  });

  it("refuses the whole snapshot when organization settings cannot be read", async () => {
    db.delegates.organization.findUnique.mockRejectedValueOnce(PRODUCER_DOWN);

    await expect(read()).rejects.toThrow(PRODUCER_DOWN);
  });

  it("refuses the whole snapshot when the team count cannot be read", async () => {
    // Both counts decide whether an organization is already onboarded. A
    // fallback that let an unavailable count through as 0 would classify an
    // onboarded organization as a first run and put the blocking dialog back
    // over its shell — a measured 0 and an unreadable one are not the same.
    db.delegates.team.count.mockRejectedValueOnce(PRODUCER_DOWN);

    await expect(read()).rejects.toThrow(PRODUCER_DOWN);
  });

  it("refuses the whole snapshot when the project count cannot be read", async () => {
    db.delegates.project.count.mockRejectedValueOnce(PRODUCER_DOWN);

    await expect(read()).rejects.toThrow(PRODUCER_DOWN);
  });

  it("refuses the whole snapshot when Clerk cannot answer", async () => {
    mocks.getUserExternalAccountProviders.mockRejectedValueOnce(PRODUCER_DOWN);

    await expect(read()).rejects.toThrow(PRODUCER_DOWN);
  });

  it("returns no partially-measured snapshot on ANY producer failure", async () => {
    const failures: [string, () => void][] = [
      [
        "attempt",
        () =>
          db.delegates.onboardingAttempt.findFirst.mockRejectedValueOnce(
            PRODUCER_DOWN
          ),
      ],
      [
        "members",
        () => db.delegates.user.count.mockRejectedValueOnce(PRODUCER_DOWN),
      ],
      [
        "github",
        () =>
          db.delegates.gitHubInstallation.findFirst.mockRejectedValueOnce(
            PRODUCER_DOWN
          ),
      ],
      [
        "desktop",
        () =>
          db.delegates.computeTarget.findFirst.mockRejectedValueOnce(
            PRODUCER_DOWN
          ),
      ],
      [
        "settings",
        () =>
          db.delegates.organization.findUnique.mockRejectedValueOnce(
            PRODUCER_DOWN
          ),
      ],
      [
        "teams",
        () => db.delegates.team.count.mockRejectedValueOnce(PRODUCER_DOWN),
      ],
      [
        "projects",
        () => db.delegates.project.count.mockRejectedValueOnce(PRODUCER_DOWN),
      ],
      [
        "clerk",
        () =>
          mocks.getUserExternalAccountProviders.mockRejectedValueOnce(
            PRODUCER_DOWN
          ),
      ],
    ];

    for (const [producer, fail] of failures) {
      fail();
      // `.resolves` rather than `.rejects`: the defect this guards against is a
      // snapshot that came back at all, with the failed field defaulted. Naming
      // the producer keeps a red pointing at the one that leaked.
      const settled = await read().then(
        (snapshot) => ({ producer, snapshot }),
        () => null
      );
      expect(settled).toBeNull();
    }
  });
});

describe("guidedOnboardingSnapshotService.getSnapshot — Unknown is not No", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserExternalAccountProviders.mockResolvedValue([]);
    install();
  });

  it("carries an unknown synced-data probe through as Unknown", async () => {
    mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.Unknown);

    const snapshot = await read();

    expect(snapshot.context.organizationHasSyncedSessionData).toBe(
      KnownFlag.Unknown
    );
    expect(snapshot.context.organizationHasSyncedSessionData).not.toBe(
      KnownFlag.No
    );
  });

  it("reports Yes and No distinctly, so Unknown cannot be a stuck denial", async () => {
    mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.Yes);
    const yes = await read();

    mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.No);
    const no = await read();

    expect(yes.context.organizationHasSyncedSessionData).toBe(KnownFlag.Yes);
    expect(no.context.organizationHasSyncedSessionData).toBe(KnownFlag.No);
  });

  it("asks the probe about the caller's own organization", async () => {
    mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.No);

    await read();

    expect(mocks.organizationHasSyncedSessionData).toHaveBeenCalledWith(ORG_A);
  });
});
