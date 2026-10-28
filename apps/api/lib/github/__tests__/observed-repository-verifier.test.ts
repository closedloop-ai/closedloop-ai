/**
 * PLN-1775 M2 (ISS-7403): verification is what turns a desktop-reported name
 * into something a reader may trust, so what it does with a REFUSAL matters as
 * much as what it does with a success. The distinctions pinned here are the ones
 * that decide whether an installation-free org converges or stalls: a refusal
 * that never reached GitHub must not age the repository's backoff, and a single
 * 404 must not settle a repository the next credential could read.
 */
import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import { GitHubFetchCredentialType } from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  getGitHubSyncClient: vi.fn(),
  reposGet: vi.fn(),
  recordRepoAccess: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({
      gitHubObservedRepository: {
        findMany: mocks.findMany,
        updateMany: mocks.updateMany,
      },
    }),
  Prisma: {},
}));

vi.mock("@/lib/github/github-sync-client-pool", () => ({
  getGitHubSyncClient: mocks.getGitHubSyncClient,
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { computeNextRetryAt } from "@/lib/github/github-retry-backoff";
import { GitHubSyncRepoAccessOutcome } from "@/lib/github/github-sync-pool-observations";
import { GitHubObservedRepositoryVerificationState } from "@/lib/github/observed-repository-store";
import {
  clearPendingVerificationBackoff,
  OBSERVED_REPOSITORY_CONTENTION_RETRY_MS,
  OBSERVED_REPOSITORY_DENIAL_ATTEMPTS,
  OBSERVED_REPOSITORY_DENIAL_RECHECK_MS,
  OBSERVED_REPOSITORY_UNDRAWABLE_RETRY_MS,
  OBSERVED_REPOSITORY_VERIFY_BATCH,
  verifyObservedRepositories,
} from "@/lib/github/observed-repository-verifier";

const ORG = "org-verify-1";
const NOW = new Date("2026-08-20T12:00:00.000Z");
const OBSERVED_ID = "observed-1";
// A real internal user id: the provenance validator requires a UUID, and a
// non-UUID would drop the whole authority group rather than one field.
const CREDENTIAL_OWNER_ID = "019c2a66-37e4-7221-9c3b-e159549f4c93";

const REPOSITORY_PAYLOAD = {
  id: 987_654,
  full_name: "acme/widget",
  name: "widget",
  owner: { login: "acme" },
  html_url: "https://github.com/acme/widget",
  private: true,
  default_branch: "main",
  pushed_at: "2026-08-19T09:30:00.000Z",
};

function dueRow(
  overrides: Partial<{
    verificationState: string;
    consecutiveVerificationFailureCount: number;
    consecutiveNoAccessCount: number;
  }> = {}
) {
  return {
    id: OBSERVED_ID,
    repositoryFullName: "acme/widget",
    verificationState: GitHubObservedRepositoryVerificationState.Pending,
    consecutiveVerificationFailureCount: 0,
    consecutiveNoAccessCount: 0,
    ...overrides,
  };
}

function drawSucceeds(): void {
  mocks.getGitHubSyncClient.mockResolvedValue(
    Result.ok({
      octokit: { rest: { repos: { get: mocks.reposGet } } },
      kind: GitHubCredentialKind.OauthUser,
      actingAs: { githubUserId: "4242" },
      credentialOwnerId: CREDENTIAL_OWNER_ID,
      rateLimitTier: null,
      recordRateLimit: vi.fn(),
      recordRepoAccess: mocks.recordRepoAccess,
    })
  );
}

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`http ${status}`), { status });
}

function writtenData(): Record<string, unknown> {
  return mocks.updateMany.mock.calls[0]?.[0]?.data ?? {};
}

function writtenWhere(): Record<string, unknown> {
  return mocks.updateMany.mock.calls[0]?.[0]?.where ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([dueRow()]);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.recordRepoAccess.mockResolvedValue(undefined);
});

describe("verifyObservedRepositories — selection", () => {
  it("reads only pending rows that are due, heaviest evidence first, bounded per cycle", async () => {
    mocks.findMany.mockResolvedValue([]);

    await verifyObservedRepositories({ organizationId: ORG }, { now: NOW });

    const query = mocks.findMany.mock.calls[0]?.[0];
    expect(query.where.organizationId).toBe(ORG);
    // A pending row waiting out its backoff must not be re-drawn: that is what
    // makes the backoff a bound on token spend rather than a comment. A DENIED
    // row is re-drawn once its horizon passes, because the denial was a verdict
    // about the credentials the org had then, not about the repository.
    expect(query.where.OR).toEqual([
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
    ]);
    expect(query.take).toBe(OBSERVED_REPOSITORY_VERIFY_BATCH);
    expect(query.orderBy[0]).toEqual({ observedSessionCount: "desc" });
  });
});

describe("verifyObservedRepositories — a readable repository", () => {
  it("persists the read-back identity and the default-branch authority group", async () => {
    drawSucceeds();
    mocks.reposGet.mockResolvedValue({ data: REPOSITORY_PAYLOAD });

    const summary = await verifyObservedRepositories(
      { organizationId: ORG },
      { now: NOW }
    );

    expect(summary).toEqual({
      attempted: 1,
      verified: 1,
      denied: 0,
      deferred: 0,
    });
    const data = writtenData();
    expect(data.verificationState).toBe(
      GitHubObservedRepositoryVerificationState.Verified
    );
    // `normalizeSessionAuthority` returns undefined without a provider id, so
    // this column is what makes the row usable as branch authority at all.
    expect(data.githubRepoId).toBe("987654");
    expect(data.owner).toBe("acme");
    expect(data.name).toBe("widget");
    expect(data.isPrivate).toBe(true);
    expect(data.lastPushedAt).toEqual(new Date(REPOSITORY_PAYLOAD.pushed_at));
    expect(data.defaultBranchName).toBe("main");
    expect(data.defaultBranchAvailability).toBe(
      RepositoryDefaultAvailability.Available
    );
    expect(data.defaultBranchSource).toBe(
      RepositoryDefaultSource.RepositoryRest
    );
    // The provenance is the whole difference between this row and the desktop's
    // claim: a user-attributed GitHub read, and whose token made it.
    expect(data.defaultBranchCredentialType).toBe(
      GitHubFetchCredentialType.UserOAuth
    );
    expect(data.defaultBranchCredentialOwnerId).toBe(CREDENTIAL_OWNER_ID);
    // Verification settles the row: no backoff left behind for a sweep to honour.
    expect(data.consecutiveVerificationFailureCount).toBe(0);
    expect(data.consecutiveNoAccessCount).toBe(0);
    expect(data.nextVerificationAt).toBeNull();
    expect(data.deniedReason).toBeNull();
  });

  it("teaches the pool that this credential reached the repository", async () => {
    drawSucceeds();
    mocks.reposGet.mockResolvedValue({ data: REPOSITORY_PAYLOAD });

    await verifyObservedRepositories({ organizationId: ORG }, { now: NOW });

    expect(mocks.recordRepoAccess).toHaveBeenCalledWith(
      GitHubSyncRepoAccessOutcome.Ok
    );
  });

  it("stores an absent pushed_at as unknown rather than a fabricated time", async () => {
    drawSucceeds();
    mocks.reposGet.mockResolvedValue({
      data: { ...REPOSITORY_PAYLOAD, pushed_at: null },
    });

    await verifyObservedRepositories({ organizationId: ORG }, { now: NOW });

    expect(writtenData().lastPushedAt).toBeNull();
  });
});

describe("verifyObservedRepositories — nothing was learned", () => {
  it.each([
    GitHubAccessDenialReason.BudgetDeferred,
    GitHubAccessDenialReason.InsufficientScope,
    GitHubAccessDenialReason.NotConnected,
  ])(
    "defers on a %s draw denial without ageing the repository's backoff",
    async (reason) => {
      mocks.getGitHubSyncClient.mockResolvedValue(Result.err({ reason }));

      const summary = await verifyObservedRepositories(
        { organizationId: ORG },
        { now: NOW }
      );

      expect(summary.deferred).toBe(1);
      const data = writtenData();
      // The condition belongs to the org's credentials, not to this repository.
      // Counting it as a failure would push a perfectly readable repo toward a
      // day-long wait for a rate window that clears in an hour.
      expect(data).not.toHaveProperty("consecutiveVerificationFailureCount");
      expect(data.verificationState).toBeUndefined();
      expect(data.nextVerificationAt).toEqual(
        new Date(NOW.getTime() + OBSERVED_REPOSITORY_UNDRAWABLE_RETRY_MS)
      );
      // Never a verdict against a credential we never drew.
      expect(mocks.recordRepoAccess).not.toHaveBeenCalled();
    }
  );

  it("gives a contention draw a short horizon, not the six-hour undrawable one (ISS-8270)", async () => {
    mocks.getGitHubSyncClient.mockResolvedValue(
      Result.err({ reason: GitHubAccessDenialReason.Contention })
    );

    const summary = await verifyObservedRepositories(
      { organizationId: ORG },
      { now: NOW }
    );

    expect(summary.deferred).toBe(1);
    const data = writtenData();
    // A peer draw holds the credential right now, so nothing has to change
    // before the next attempt can succeed — parking a readable repository for
    // six hours over a lost claim is delay with no cause.
    expect(data.nextVerificationAt).toEqual(
      new Date(NOW.getTime() + OBSERVED_REPOSITORY_CONTENTION_RETRY_MS)
    );
    expect(data).not.toHaveProperty("consecutiveVerificationFailureCount");
    expect(data.verificationState).toBeUndefined();
    expect(mocks.recordRepoAccess).not.toHaveBeenCalled();
  });

  it("backs off a rate-limited read without teaching the pool a reach verdict", async () => {
    drawSucceeds();
    mocks.reposGet.mockRejectedValue(httpError(429));

    const summary = await verifyObservedRepositories(
      { organizationId: ORG },
      { now: NOW }
    );

    expect(summary.deferred).toBe(1);
    const data = writtenData();
    expect(data.verificationState).toBeUndefined();
    expect(data.consecutiveVerificationFailureCount).toBe(1);
    expect(data.nextVerificationAt).toEqual(computeNextRetryAt(1, NOW));
    // A rate limit says nothing about whether this token can see the repo, so
    // excluding the token from the next draw would be a lie the pool then acts
    // on for the whole verdict TTL.
    expect(mocks.recordRepoAccess).not.toHaveBeenCalled();
  });

  it("backs off a 401 without teaching the pool a reach verdict", async () => {
    // The production pool also revokes this credential through an Octokit error
    // hook. This hand-rolled client has no hook, so pin the verifier's fallback.
    drawSucceeds();
    mocks.reposGet.mockRejectedValue(httpError(401));

    const summary = await verifyObservedRepositories(
      { organizationId: ORG },
      { now: NOW }
    );

    expect(summary).toEqual({
      attempted: 1,
      verified: 0,
      denied: 0,
      deferred: 1,
    });
    const data = writtenData();
    expect(data.verificationState).toBeUndefined();
    expect(data).not.toHaveProperty("consecutiveNoAccessCount");
    expect(data.consecutiveVerificationFailureCount).toBe(1);
    expect(data.nextVerificationAt).toEqual(computeNextRetryAt(1, NOW));
    expect(mocks.recordRepoAccess).not.toHaveBeenCalled();
  });
});

describe("verifyObservedRepositories — an unreadable repository", () => {
  it("treats the first 404 as this credential's limit, not the org's", async () => {
    drawSucceeds();
    mocks.reposGet.mockRejectedValue(httpError(404));

    const summary = await verifyObservedRepositories(
      { organizationId: ORG },
      { now: NOW }
    );

    expect(summary).toEqual({
      attempted: 1,
      verified: 0,
      denied: 0,
      deferred: 1,
    });
    // GitHub cloaks an unreadable private repo as a 404, so one refusal means
    // "not this credential". The verdict is what rotates the next attempt onto a
    // different one.
    expect(mocks.recordRepoAccess).toHaveBeenCalledWith(
      GitHubSyncRepoAccessOutcome.NoAccess
    );
    expect(writtenData().verificationState).toBeUndefined();
  });

  it("never lets transient failures push a readable repository to the denial ceiling", async () => {
    // The regression: two rate limits and ONE 404 used to settle the row denied,
    // with `nextVerificationAt: null` and a due-query that only selects pending
    // — so a repository every other credential could read was stranded, with no
    // path back. The counters are separate precisely so this cannot happen.
    mocks.findMany.mockResolvedValue([
      dueRow({
        consecutiveVerificationFailureCount:
          OBSERVED_REPOSITORY_DENIAL_ATTEMPTS - 1,
        consecutiveNoAccessCount: 0,
      }),
    ]);
    drawSucceeds();
    mocks.reposGet.mockRejectedValue(httpError(404));

    const summary = await verifyObservedRepositories(
      { organizationId: ORG },
      { now: NOW }
    );

    expect(summary.denied).toBe(0);
    expect(summary.deferred).toBe(1);
    const data = writtenData();
    expect(data.verificationState).toBeUndefined();
    // The 404 counts once, on its own column; the backoff keeps ageing.
    expect(data.consecutiveNoAccessCount).toBe(1);
    expect(data.consecutiveVerificationFailureCount).toBe(
      OBSERVED_REPOSITORY_DENIAL_ATTEMPTS
    );
  });

  it("does not count a transient failure toward the denial ceiling", async () => {
    mocks.findMany.mockResolvedValue([
      dueRow({
        consecutiveNoAccessCount: OBSERVED_REPOSITORY_DENIAL_ATTEMPTS - 1,
      }),
    ]);
    drawSucceeds();
    mocks.reposGet.mockRejectedValue(httpError(500));

    await verifyObservedRepositories({ organizationId: ORG }, { now: NOW });

    // An outage on the attempt that would otherwise have been decisive leaves
    // the no-access count untouched: it is not evidence either way.
    const data = writtenData();
    expect(data).not.toHaveProperty("consecutiveNoAccessCount");
    expect(data.verificationState).toBeUndefined();
  });

  it("settles the row as denied once every credential drawn has refused it", async () => {
    mocks.findMany.mockResolvedValue([
      dueRow({
        consecutiveNoAccessCount: OBSERVED_REPOSITORY_DENIAL_ATTEMPTS - 1,
      }),
    ]);
    drawSucceeds();
    mocks.reposGet.mockRejectedValue(httpError(404));

    const summary = await verifyObservedRepositories(
      { organizationId: ORG },
      { now: NOW }
    );

    expect(summary.denied).toBe(1);
    const data = writtenData();
    expect(data.verificationState).toBe(
      GitHubObservedRepositoryVerificationState.Denied
    );
    expect(data.deniedReason).toBe(GitHubAccessDenialReason.NoInstallation);
    // Denied is a verdict about the credentials drawn, not about the repository,
    // so it expires: a user with access joining or the App being installed both
    // change the answer and neither announces itself here.
    expect(data.nextVerificationAt).toEqual(
      new Date(NOW.getTime() + OBSERVED_REPOSITORY_DENIAL_RECHECK_MS)
    );
    // The denial closes its own tally so the re-check earns a full rotation
    // rather than re-denying on the first refusal it meets.
    expect(data.consecutiveNoAccessCount).toBe(0);
  });

  it("does not read a generic 403 as repository-level no-access", async () => {
    // SAML enforcement, an IP allowlist, and an OAuth App restriction all
    // produce a bare 403 against a credential that may well be able to read the
    // repo. Counting it would mint a no-access verdict against a healthy
    // credential and walk the row toward a denial it never earned.
    mocks.findMany.mockResolvedValue([
      dueRow({
        consecutiveNoAccessCount: OBSERVED_REPOSITORY_DENIAL_ATTEMPTS - 1,
      }),
    ]);
    drawSucceeds();
    mocks.reposGet.mockRejectedValue(httpError(403));

    const summary = await verifyObservedRepositories(
      { organizationId: ORG },
      { now: NOW }
    );

    expect(summary.denied).toBe(0);
    expect(summary.deferred).toBe(1);
    expect(mocks.recordRepoAccess).not.toHaveBeenCalled();
    const data = writtenData();
    expect(data).not.toHaveProperty("consecutiveNoAccessCount");
    expect(data.verificationState).toBeUndefined();
  });

  it("settles a candidate that is not a repository identity without spending a credential", async () => {
    mocks.findMany.mockResolvedValue([
      { ...dueRow(), repositoryFullName: "not-a-full-name" },
    ]);

    const summary = await verifyObservedRepositories(
      { organizationId: ORG },
      { now: NOW }
    );

    expect(summary.denied).toBe(1);
    expect(mocks.getGitHubSyncClient).not.toHaveBeenCalled();
    expect(writtenData().verificationState).toBe(
      GitHubObservedRepositoryVerificationState.Denied
    );
    // The one denial that cannot become readable, so it gets no horizon.
    expect(writtenData().nextVerificationAt).toBeNull();
  });

  it("settles a name carrying an extra path segment instead of verifying a different repository", async () => {
    mocks.findMany.mockResolvedValue([
      { ...dueRow(), repositoryFullName: "acme/widget/tree" },
    ]);

    const summary = await verifyObservedRepositories(
      { organizationId: ORG },
      { now: NOW }
    );

    // Taking the first two segments would read acme/widget from GitHub and then
    // write ITS provider id, url, and default-branch authority onto a row keyed
    // acme/widget/tree.
    expect(summary.denied).toBe(1);
    expect(mocks.getGitHubSyncClient).not.toHaveBeenCalled();
    expect(writtenData().githubRepoId).toBeUndefined();
  });
});

describe("verifyObservedRepositories — settling under contention", () => {
  it("continues the sweep when one verification-state write rejects", async () => {
    mocks.findMany.mockResolvedValue([
      dueRow(),
      {
        ...dueRow(),
        id: "observed-2",
        repositoryFullName: "acme/gadget",
      },
    ]);
    drawSucceeds();
    mocks.reposGet.mockRejectedValue(httpError(500));
    mocks.updateMany
      .mockRejectedValueOnce(new Error("connection terminated"))
      .mockResolvedValueOnce({ count: 1 });

    await expect(
      verifyObservedRepositories({ organizationId: ORG }, { now: NOW })
    ).resolves.toEqual({
      attempted: 2,
      verified: 0,
      denied: 0,
      deferred: 2,
    });
    expect(mocks.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.updateMany.mock.calls[1]?.[0]?.where.id).toBe("observed-2");
  });

  it("keeps a successful read verified when the pool verdict write throws", async () => {
    // The verdict goes through the capability store, which rethrows anything
    // that is not a unique-constraint race. Inside the read's catch it reached
    // the failure classifier, where a Prisma error — carrying no HTTP status —
    // landed as `unavailable`: a backoff, and a repository we had just read
    // successfully, discarded.
    drawSucceeds();
    mocks.reposGet.mockResolvedValue({ data: REPOSITORY_PAYLOAD });
    mocks.recordRepoAccess.mockRejectedValue(new Error("verdict write failed"));

    const summary = await verifyObservedRepositories(
      { organizationId: ORG },
      { now: NOW }
    );

    expect(summary.verified).toBe(1);
    expect(writtenData().verificationState).toBe(
      GitHubObservedRepositoryVerificationState.Verified
    );
  });

  it("reports nothing learned when the row moved under a concurrent sweep", async () => {
    drawSucceeds();
    mocks.reposGet.mockResolvedValue({ data: REPOSITORY_PAYLOAD });
    mocks.updateMany.mockResolvedValue({ count: 0 });

    const summary = await verifyObservedRepositories(
      { organizationId: ORG },
      { now: NOW }
    );

    // Without the guard the slower sweep's stale denial would land on top of the
    // other's verification; with it, the write matches nothing and the outcome
    // is the other sweep's to count, not this one's to double-count.
    expect(summary).toEqual({
      attempted: 1,
      verified: 0,
      denied: 0,
      deferred: 1,
    });
    expect(writtenWhere()).toEqual({
      id: OBSERVED_ID,
      verificationState: GitHubObservedRepositoryVerificationState.Pending,
    });
  });

  it("re-verifies a denied row past its horizon, guarded by the state it was read in", async () => {
    mocks.findMany.mockResolvedValue([
      dueRow({
        verificationState: GitHubObservedRepositoryVerificationState.Denied,
      }),
    ]);
    drawSucceeds();
    mocks.reposGet.mockResolvedValue({ data: REPOSITORY_PAYLOAD });

    const summary = await verifyObservedRepositories(
      { organizationId: ORG },
      { now: NOW }
    );

    expect(summary.verified).toBe(1);
    expect(writtenWhere().verificationState).toBe(
      GitHubObservedRepositoryVerificationState.Denied
    );
    expect(writtenData().deniedReason).toBeNull();
  });
});

describe("clearPendingVerificationBackoff", () => {
  it("re-opens pending rows only, and leaves the failure tallies alone", async () => {
    mocks.updateMany.mockResolvedValue({ count: 3 });

    const count = await clearPendingVerificationBackoff(ORG);

    // A denied row's horizon is its re-check schedule, and the denied arm of
    // the due-predicate excludes a null horizon outright — clearing one would
    // strand the row rather than hasten it.
    expect(writtenWhere()).toEqual({
      organizationId: ORG,
      verificationState: GitHubObservedRepositoryVerificationState.Pending,
      nextVerificationAt: { not: null },
    });
    // The window re-opens; the ceiling a repeatedly-failing row earned does not.
    expect(writtenData()).toEqual({ nextVerificationAt: null });
    expect(count).toBe(3);
  });
});
