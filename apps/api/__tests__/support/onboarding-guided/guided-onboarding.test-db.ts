/**
 * @file guided-onboarding.test-db.ts
 * @description The database double the guided onboarding suites drive the REAL
 * services against (ISS-8375).
 *
 * Built on `createFakeDelegate` from the shared write-semantics double rather
 * than on `vi.fn().mockResolvedValue(...)`, because the whole point of these
 * suites is the `where` clause. Prisma's semantics are what make the org and
 * user predicates decidable: **an absent `where` key constrains nothing**, so
 * deleting `organizationId` from a production query makes a foreign row VISIBLE
 * here and the isolation test goes red. A double that filtered on the
 * `organizationId` the caller passed in — rather than on what the service
 * actually put in the `where` — would reintroduce the same false green one
 * layer down.
 */

import type { JsonObject } from "@repo/api/src/types/common";
import type { GitHubInstallationStatus } from "@repo/database";
import { vi } from "vitest";
import {
  createFakeDelegate,
  type FakeDelegate,
  matchesPrismaWhere,
} from "@/__tests__/support/prisma-write-semantics.test-fixtures";

type Row = Record<string, unknown>;

export type FakeAttemptRow = {
  id: string;
  userId: string;
  organizationId: string;
  experienceVariant: string;
  host: string;
  state: unknown;
  revision: number;
  lastCommandId: string | null;
  accountSkippedAt: Date | null;
  desktopDownloadedAt: Date | null;
  tourCompletedAt: Date | null;
  invitesSentAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

export type FakeUserRow = {
  id: string;
  organizationId: string;
  active: boolean;
};

export type FakeInstallationRow = {
  id: string;
  organizationId: string;
  status: GitHubInstallationStatus;
};

export type FakeComputeTargetRow = {
  id: string;
  organizationId: string;
  userId: string;
  isCloudSentinel: boolean;
};

export type FakeOrganizationRow = {
  id: string;
  createdAt: Date;
  settings: JsonObject;
};

/** Only the org scope matters here: these rows are counted, never read. */
export type FakeOrganizationScopedRow = {
  id: string;
  organizationId: string;
};

export type FakeGitHubUserConnectionRow = {
  organizationId: string;
  userId: string;
  revokedAt: Date | null;
  scopes: string[];
};

export type GuidedOnboardingSeed = {
  attempts?: FakeAttemptRow[];
  users?: FakeUserRow[];
  installations?: FakeInstallationRow[];
  /**
   * `GitHubUserConnection` rows — one member's personal OAuth grant. Read by
   * `resolveGitHubDataConnectionStatus`, which the guided snapshot now asks for
   * `githubConnected` (ISS-11246), so a case about the grant seeds it here
   * rather than stubbing the resolver.
   */
  githubUserConnections?: FakeGitHubUserConnectionRow[];
  computeTargets?: FakeComputeTargetRow[];
  organizations?: FakeOrganizationRow[];
  teams?: FakeOrganizationScopedRow[];
  projects?: FakeOrganizationScopedRow[];
};

type CountingDelegate = FakeDelegate & { count: ReturnType<typeof vi.fn> };

export type GuidedOnboardingDb = {
  /** Handed to `withDb`'s callback. */
  client: Record<string, unknown>;
  /** The live attempt rows, mutated in place by every accepted write. */
  attempts: FakeAttemptRow[];
  delegates: {
    onboardingAttempt: FakeDelegate;
    user: CountingDelegate;
    gitHubInstallation: FakeDelegate;
    gitHubUserConnection: FakeDelegate;
    computeTarget: FakeDelegate;
    googleIntegration: FakeDelegate;
    organization: FakeDelegate;
    team: CountingDelegate;
    project: CountingDelegate;
  };
};

let createdAttemptSequence = 0;

/**
 * `OnboardingAttempt`'s uniques: the surrogate key, and the run identity the
 * compare-and-swap arbitrates on.
 */
const ATTEMPT_UNIQUE_KEYS = [["id"], ["userId", "organizationId"]];

export function createGuidedOnboardingDb(
  seed: GuidedOnboardingSeed = {}
): GuidedOnboardingDb {
  const attempts = seed.attempts ?? [];
  const onboardingAttempt = createFakeDelegate(
    attempts,
    ATTEMPT_UNIQUE_KEYS,
    // Prisma fills the surrogate key server-side. Without it a created run comes
    // back with `id: undefined` and every `attemptId` assertion about a row the
    // test itself created passes vacuously. `createdAt` is the column's
    // `@default(now())`, which the snapshot's settled fold reads.
    () => {
      createdAttemptSequence += 1;
      return {
        id: `attempt-created-${createdAttemptSequence}`,
        createdAt: new Date(),
      };
    }
  );
  const delegates = {
    onboardingAttempt,
    user: countingDelegate(seed.users ?? []),
    gitHubInstallation: createFakeDelegate(seed.installations ?? []),
    // The compound unique arrives as `{ organizationId_userId: { … } }`; the
    // double's `matches` recurses into a plain nested object, so the flat row
    // below satisfies it without a bespoke key list.
    gitHubUserConnection: createFakeDelegate(seed.githubUserConnections ?? []),
    computeTarget: createFakeDelegate(seed.computeTargets ?? []),
    // Read by `onboardingService.getStatus`, which the guided completion suite
    // drives against the same rows as the guided services.
    googleIntegration: createFakeDelegate([]),
    organization: createFakeDelegate(seed.organizations ?? []),
    team: countingDelegate(seed.teams ?? []),
    project: countingDelegate(seed.projects ?? []),
  };

  return { attempts, delegates, client: delegates };
}

/**
 * A delegate that can also be counted.
 *
 * Prisma's `count` takes the same `where`, so it routes through the SAME
 * canonical matcher the reads use: a dropped predicate widens the count exactly
 * as it widens a read, rather than through a second model of Prisma's semantics
 * that could disagree with the first.
 */
function countingDelegate(rows: Row[]): CountingDelegate {
  return Object.assign(createFakeDelegate(rows), {
    count: vi.fn((args: Row = {}) =>
      Promise.resolve(
        rows.filter((row) => matchesPrismaWhere(row, (args.where as Row) ?? {}))
          .length
      )
    ),
  });
}
