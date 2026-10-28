/**
 * The snapshot's `startedOnHost`: the server-side fact the Web shell stands
 * down on for a run Desktop started (operator ruling, 2026-10-10: "web
 * shouldn't start an onboarding if desktop has started").
 *
 * Driven through the REAL service against the shared Prisma-semantics double,
 * which honours `select` — so a store that stops selecting the column fails
 * here rather than silently reporting nothing.
 */

import {
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
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

vi.mock("@/app/agent-sessions/organization-synced-session-data", () => ({
  organizationHasSyncedSessionData: mocks.organizationHasSyncedSessionData,
}));

import { guidedOnboardingSnapshotSchema } from "@repo/api/src/types/onboarding-guided";
import { serializeOnboardingState } from "@repo/api/src/types/onboarding-persistence";
import {
  createGuidedOnboardingDb,
  type GuidedOnboardingSeed,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-db";
import {
  attemptRow,
  CLERK_USER_A,
  ORG_A,
  organizationRow,
  USER_A,
  userRow,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-fixtures";
import { guidedOnboardingSnapshotService } from "../snapshot-service";

const UNKNOWN_STORED_HOST = "watch";

function install(seed: GuidedOnboardingSeed = {}): void {
  const db = createGuidedOnboardingDb({
    users: [userRow(USER_A, ORG_A)],
    organizations: [organizationRow(ORG_A)],
    ...seed,
  });
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db.client)
  );
}

function read(host: OnboardingHost) {
  return guidedOnboardingSnapshotService.getSnapshot({
    organizationId: ORG_A,
    userId: USER_A,
    clerkUserId: CLERK_USER_A,
    host,
  });
}

beforeEach(() => {
  mocks.getUserExternalAccountProviders.mockResolvedValue([]);
  mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.No);
});

describe("guided snapshot startedOnHost", () => {
  it("reports a Desktop-started run to the Web reader", async () => {
    install({
      attempts: [attemptRow({ id: "attempt-1", host: OnboardingHost.Desktop })],
    });

    const snapshot = await read(OnboardingHost.Web);

    expect(snapshot.startedOnHost).toBe(OnboardingHost.Desktop);
  });

  it("reports a Web-started run as Web, which the Web shell does not stand down for", async () => {
    install({
      attempts: [attemptRow({ id: "attempt-1", host: OnboardingHost.Web })],
    });

    const snapshot = await read(OnboardingHost.Desktop);

    expect(snapshot.startedOnHost).toBe(OnboardingHost.Web);
  });

  it("omits the field when the reader has no run", async () => {
    install();

    const snapshot = await read(OnboardingHost.Web);

    expect(snapshot).not.toHaveProperty("startedOnHost");
  });

  it("omits a stored host this build does not know rather than guessing", async () => {
    install({
      attempts: [attemptRow({ id: "attempt-1", host: UNKNOWN_STORED_HOST })],
    });

    const snapshot = await read(OnboardingHost.Web);

    expect(snapshot).not.toHaveProperty("startedOnHost");
  });
});

describe("guidedOnboardingSnapshotSchema startedOnHost", () => {
  it("reads a snapshot from a server that predates the field", async () => {
    install({ attempts: [attemptRow({ id: "attempt-1" })] });
    const { startedOnHost: _omitted, ...older } = await read(
      OnboardingHost.Web
    );

    const parsed = guidedOnboardingSnapshotSchema.parse(older);

    expect(parsed.startedOnHost).toBeUndefined();
  });

  it("reads an unknown host value as not stated instead of failing the snapshot", async () => {
    install({ attempts: [attemptRow({ id: "attempt-1" })] });
    const snapshot = await read(OnboardingHost.Web);

    const parsed = guidedOnboardingSnapshotSchema.parse({
      ...snapshot,
      startedOnHost: UNKNOWN_STORED_HOST,
    });

    expect(parsed.startedOnHost).toBeUndefined();
    expect(parsed.attemptId).toBe("attempt-1");
  });
});

describe("a Web-started run completed in Desktop", () => {
  it.each([OnboardingHost.Web, OnboardingHost.Desktop])(
    "stays completed when reopened on %s",
    async (host) => {
      install({
        attempts: [
          attemptRow({
            id: "attempt-web-to-desktop",
            host: OnboardingHost.Web,
            completedAt: new Date("2026-10-10T12:00:00Z"),
            state: serializeOnboardingState({
              phase: OnboardingPhase.Ready,
              history: [
                OnboardingPhase.Welcome,
                OnboardingPhase.SessionDiscovery,
                OnboardingPhase.Account,
                OnboardingPhase.CreateOrganization,
                OnboardingPhase.SyncPolicy,
                OnboardingPhase.InviteTeam,
                OnboardingPhase.ConnectGitHub,
                OnboardingPhase.DashboardAvailable,
                OnboardingPhase.DashboardTour,
              ],
              accountProvider: null,
              organizationEstablished: true,
              resuming: false,
            }),
          }),
        ],
      });
      const snapshot = await read(host);
      expect(snapshot.startedOnHost).toBe(OnboardingHost.Web);
      expect(snapshot.state.phase).toBe(OnboardingPhase.Ready);
      expect(snapshot.state.resuming).toBe(false);
    }
  );
});
