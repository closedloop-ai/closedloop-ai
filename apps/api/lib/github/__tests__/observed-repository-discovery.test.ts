import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import { withDb } from "@repo/database";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";
import {
  listVerifiedObservedRepositoryNames,
  selectOrgIdsWithDueObservedRepositories,
  VERIFY_ORG_BATCH,
} from "@/lib/github/observed-repository-discovery";
import { GitHubObservedRepositoryVerificationState } from "@/lib/github/observed-repository-store";
import {
  dueObservedRepositoryWhere,
  OBSERVED_REPOSITORY_VERIFY_BATCH,
} from "@/lib/github/observed-repository-verifier";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn>;

type MockDb = {
  gitHubObservedRepository: { findMany: ReturnType<typeof vi.fn> };
  organization: { findMany: ReturnType<typeof vi.fn> };
};

const NOW = new Date("2026-08-21T12:00:00.000Z");
const ORG = "org-1";

function makeDb(): MockDb {
  return {
    gitHubObservedRepository: { findMany: vi.fn().mockResolvedValue([]) },
    organization: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

function wire(db: MockDb): void {
  mockWithDb.mockImplementation((fn: (client: MockDb) => unknown) => fn(db));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listVerifiedObservedRepositoryNames", () => {
  it("reads only verified observations carrying a provider repository id", async () => {
    const db = makeDb();
    db.gitHubObservedRepository.findMany.mockResolvedValue([
      { repositoryFullName: "acme/verified" },
    ]);
    wire(db);

    const names = await listVerifiedObservedRepositoryNames(ORG);

    expect(names).toEqual(["acme/verified"]);
    expect(db.gitHubObservedRepository.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        verificationState: GitHubObservedRepositoryVerificationState.Verified,
        githubRepoId: { not: null },
      },
      select: { repositoryFullName: true },
    });
  });
});

describe("selectOrgIdsWithDueObservedRepositories", () => {
  it("asks for due rows from CONNECTED orgs in one bounded read, least-recently-attempted first", async () => {
    // Two contracts in one assertion, and they have to hold together.
    //
    // The due-ness predicate is SHARED, not a copy: a second hand-written rule is
    // how this selector starts handing the verifier orgs whose rows it will not
    // pick up, spending a whole tick to learn nothing.
    //
    // The connection predicate lives in the SAME `where` as `take`. A
    // disconnected org's rows are never handed to the verifier, so nothing ever
    // advances their `lastVerificationAttemptAt` and they hold the head of the
    // nulls-first ordering permanently — capping distinct orgs first and
    // filtering afterwards let `limit` of them own the page and starve every
    // connected org behind them, forever (#5551).
    const db = makeDb();
    wire(db);

    await selectOrgIdsWithDueObservedRepositories(VERIFY_ORG_BATCH, NOW);

    expect(db.gitHubObservedRepository.findMany).toHaveBeenCalledWith({
      where: {
        ...dueObservedRepositoryWhere(NOW),
        organization: {
          githubUserConnections: {
            some: { revokedAt: null, scopes: { has: GITHUB_REPO_SCOPE } },
          },
        },
      },
      orderBy: [
        { lastVerificationAttemptAt: { sort: "asc", nulls: "first" } },
        { id: "asc" },
      ],
      take: VERIFY_ORG_BATCH * OBSERVED_REPOSITORY_VERIFY_BATCH,
      select: { organizationId: true },
    });
  });

  it("folds a run of rows from one org into a single candidate and keeps row order", async () => {
    const db = makeDb();
    db.gitHubObservedRepository.findMany.mockResolvedValue([
      { organizationId: "org-b" },
      { organizationId: "org-b" },
      { organizationId: "org-a" },
      { organizationId: "org-b" },
    ]);
    wire(db);

    const ids = await selectOrgIdsWithDueObservedRepositories(10, NOW);

    expect(ids).toEqual(["org-b", "org-a"]);
  });

  it("stops at the org limit even when more orgs have due rows", async () => {
    const db = makeDb();
    db.gitHubObservedRepository.findMany.mockResolvedValue([
      { organizationId: "org-1" },
      { organizationId: "org-2" },
      { organizationId: "org-3" },
    ]);
    wire(db);

    const ids = await selectOrgIdsWithDueObservedRepositories(2, NOW);

    expect(ids).toEqual(["org-1", "org-2"]);
    // No second query to cap against. The connection narrowing happens in the
    // bounded read itself, so there is no longer a stage at which an org the
    // verifier cannot serve could hold one of the `limit` slots.
    expect(db.organization.findMany).not.toHaveBeenCalled();
  });

  it("selects nothing when no connected org has a due row", async () => {
    const db = makeDb();
    wire(db);

    const ids = await selectOrgIdsWithDueObservedRepositories(10, NOW);

    expect(ids).toEqual([]);
    expect(mockWithDb).toHaveBeenCalledTimes(1);
  });
});

describe("dueObservedRepositoryWhere", () => {
  it("is due for a pending row with no horizon or a passed one, and for a denied row past its re-check", () => {
    const where = dueObservedRepositoryWhere(NOW);

    expect(where).toEqual({
      OR: [
        {
          verificationState: GitHubObservedRepositoryVerificationState.Pending,
          OR: [
            { nextVerificationAt: null },
            { nextVerificationAt: { lte: NOW } },
          ],
        },
        {
          verificationState: GitHubObservedRepositoryVerificationState.Denied,
          nextVerificationAt: { lte: NOW },
        },
      ],
    });
  });

  it("never selects a denied row with a null horizon — the malformed-name settle", () => {
    const where = dueObservedRepositoryWhere(NOW);
    const deniedArm = where.OR as Record<string, unknown>[];

    // `{ lte }` cannot match NULL in SQL, so the terminal denial is excluded by
    // the comparison itself rather than by a second predicate that could drift.
    expect(deniedArm[1]?.nextVerificationAt).toEqual({ lte: NOW });
    expect(deniedArm[1]).not.toHaveProperty("OR");
  });
});
