import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/github")>()),
  queryBundledPullRequestsWithProviderResult: vi.fn(),
}));

vi.mock("@/lib/github/github-sync-client-pool", () => ({
  getGitHubSyncClient: vi.fn(),
}));

vi.mock("../reconcile-projection-write", () => ({
  writeReconciledPullRequest: vi.fn(),
  writeReconciledPullRequestFailures: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/lib/github/github-repo-sync-state", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/github/github-repo-sync-state")
  >()),
  classifyRepoSyncTier: vi.fn(),
}));

vi.mock("@repo/api/src/types/branch", () => ({
  normalizeRepoFullName: (value: string) => value.trim().toLowerCase(),
}));

import { withDb } from "@repo/database";
import {
  GitHubProviderResultStatus,
  queryBundledPullRequestsWithProviderResult,
} from "@repo/github";
import {
  classifyRepoSyncTier,
  GitHubRepoSyncDeferralReason,
  GitHubRepoSyncTier,
} from "@/lib/github/github-repo-sync-state";
import { getGitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import { GitHubSyncRepoAccessOutcome } from "@/lib/github/github-sync-pool-observations";
import {
  writeReconciledPullRequest,
  writeReconciledPullRequestFailures,
} from "../reconcile-projection-write";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  computeNextRetryAt,
  ReconcileRepoStatus,
  reconcileRepo,
} from "../repo-reconciler";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};
const mockGetClient = getGitHubSyncClient as unknown as ReturnType<
  typeof vi.fn
>;
const mockQuery =
  queryBundledPullRequestsWithProviderResult as unknown as ReturnType<
    typeof vi.fn
  >;
const mockWrite = writeReconciledPullRequest as unknown as ReturnType<
  typeof vi.fn
>;
const mockWriteFailures =
  writeReconciledPullRequestFailures as unknown as ReturnType<typeof vi.fn>;
const mockClassify = classifyRepoSyncTier as unknown as ReturnType<
  typeof vi.fn
>;

const NOW = new Date("2026-08-03T12:00:00.000Z");
const WATERMARK = new Date("2026-08-01T00:00:00.000Z");

type SyncStateUpdate = { where: unknown; data: Record<string, unknown> };
const syncStateUpdates: SyncStateUpdate[] = [];
let selfHealRows: Array<{ number: number }> = [];
let selfHealWhere: Record<string, unknown> | null = null;
let debounceCalls: Record<string, unknown>[] = [];
let fetchOpts: Record<string, unknown> | null = null;
let installationRepoId: string | null = null;

function makeDb() {
  return {
    gitHubInstallationRepository: {
      findFirst: vi.fn(() =>
        Promise.resolve(installationRepoId ? { id: installationRepoId } : null)
      ),
    },
    pullRequestDetail: {
      findMany: vi.fn((args: { where: Record<string, unknown> }) => {
        selfHealWhere = args.where;
        return Promise.resolve(selfHealRows);
      }),
      updateMany: vi.fn((args: { where: Record<string, unknown> }) => {
        debounceCalls.push(args.where);
        return Promise.resolve({ count: selfHealRows.length });
      }),
    },
    gitHubRepoSyncState: {
      updateMany: vi.fn((args: SyncStateUpdate) => {
        syncStateUpdates.push(args);
        return Promise.resolve({ count: 1 });
      }),
    },
  };
}

function makeClient(kind: GitHubCredentialKind) {
  return {
    octokit: {},
    kind,
    actingAs:
      kind === GitHubCredentialKind.Installation
        ? { installationId: "inst-1" }
        : { githubUserId: "gh-1", login: "octocat" },
    credentialOwnerId:
      kind === GitHubCredentialKind.Installation ? null : "user-uuid-1",
    rateLimitTier: null,
    recordRateLimit: vi.fn(() => Promise.resolve()),
    recordRepoAccess: vi.fn(() => Promise.resolve()),
  };
}

function readModelPr(overrides: {
  number: number;
  updatedAt: string;
  state?: string;
}) {
  return {
    githubId: `pr-${overrides.number}`,
    number: overrides.number,
    title: `PR ${overrides.number}`,
    htmlUrl: `https://github.com/acme/widgets/pull/${overrides.number}`,
    headBranch: `feature-${overrides.number}`,
    baseBranch: "main",
    headSha: `sha-${overrides.number}`,
    state: overrides.state ?? "OPEN",
    isDraft: false,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    reviewDecision: null,
    checksStatus: null,
    statusCheckRollup: null,
    openedAt: "2026-07-01T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    updatedAt: overrides.updatedAt,
    author: "octocat",
    source: "provider",
  };
}

const INPUT = {
  organizationId: "org-1",
  repositoryFullName: "acme/widgets",
  watermark: WATERMARK,
  cursor: null,
  consecutiveFailureCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  syncStateUpdates.length = 0;
  selfHealRows = [];
  selfHealWhere = null;
  debounceCalls = [];
  fetchOpts = null;
  installationRepoId = null;
  const db = makeDb();
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) => fn(db));
  mockWithDb.tx.mockImplementation((fn: (client: unknown) => unknown) =>
    fn(db)
  );
  mockWrite.mockResolvedValue(true);
});

function lastSyncData(): Record<string, unknown> {
  return syncStateUpdates.at(-1)?.data ?? {};
}

describe("reconcileRepo — denials", () => {
  it("marks deferred: budget without touching tier/watermark/failures", async () => {
    mockGetClient.mockResolvedValue({
      ok: false,
      error: { reason: GitHubAccessDenialReason.BudgetDeferred },
    });

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Deferred);
    expect(result.deferredReason).toBe(GitHubRepoSyncDeferralReason.Budget);
    const data = lastSyncData();
    expect(data.deferredReason).toBe(GitHubRepoSyncDeferralReason.Budget);
    expect(data.tier).toBeUndefined();
    expect(data.watermark).toBeUndefined();
    expect(data.consecutiveFailureCount).toBeUndefined();
    expect(data.nextRetryAt).toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("reclassifies the tier when no credential can reach the repo", async () => {
    mockGetClient.mockResolvedValue({
      ok: false,
      error: { reason: GitHubAccessDenialReason.NoInstallation },
    });
    mockClassify.mockResolvedValue(GitHubRepoSyncTier.Unsyncable);

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Reclassified);
    expect(mockClassify).toHaveBeenCalledWith({
      now: NOW,
      organizationId: "org-1",
      owner: "acme",
      repo: "widgets",
    });
    expect(lastSyncData().tier).toBe(GitHubRepoSyncTier.Unsyncable);
    expect(lastSyncData().consecutiveFailureCount).toBe(0);
    expect(lastSyncData().nextRetryAt).toBeNull();
  });

  it("backs off (increments failures) on a transient provider outage", async () => {
    mockGetClient.mockResolvedValue({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Unavailable },
    });

    const result = await reconcileRepo(
      { ...INPUT, consecutiveFailureCount: 2 },
      { now: NOW }
    );

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(lastSyncData().consecutiveFailureCount).toBe(3);
    expect(lastSyncData().nextRetryAt).toEqual(computeNextRetryAt(3, NOW));
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it("persistFailure guards on consecutiveFailureCount so a late failure cannot overwrite a concurrent success", async () => {
    mockGetClient.mockResolvedValue({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Unavailable },
    });

    await reconcileRepo({ ...INPUT, consecutiveFailureCount: 2 }, { now: NOW });

    const failureUpdate = syncStateUpdates.find(
      (u) => (u.data as Record<string, unknown>).consecutiveFailureCount === 3
    );
    expect(failureUpdate).toBeDefined();
    expect(failureUpdate?.where).toEqual(
      expect.objectContaining({ consecutiveFailureCount: 2 })
    );
  });
});

describe("reconcileRepo — sweep", () => {
  function wireSuccess(
    prs: ReturnType<typeof readModelPr>[],
    kind: GitHubCredentialKind = GitHubCredentialKind.Installation,
    page: { truncated?: boolean; nextCursor?: string | null } = {}
  ) {
    const client = makeClient(kind);
    mockGetClient.mockResolvedValue({ ok: true, value: client });
    mockQuery.mockImplementation(
      (
        _octokit: unknown,
        _owner: string,
        _repo: string,
        _numbers: number[],
        opts: Record<string, unknown>,
        observer?: (o: unknown) => void
      ) => {
        fetchOpts = opts;
        observer?.({
          page: 0,
          itemCount: prs.length,
          rateLimit: {
            cost: 4,
            remaining: 4991,
            resetAt: "2026-08-03T13:00:00Z",
            state: "available",
          },
        });
        return Promise.resolve({
          status: GitHubProviderResultStatus.Success,
          value: {
            pullRequests: prs,
            truncated: page.truncated ?? false,
            nextCursor: page.nextCursor ?? null,
          },
        });
      }
    );
    return client;
  }

  it("feeds each page's budget back to the pool and records positive access", async () => {
    const client = wireSuccess([
      readModelPr({ number: 5, updatedAt: "2026-08-02T00:00:00Z" }),
    ]);

    await reconcileRepo(INPUT, { now: NOW });

    expect(client.recordRateLimit).toHaveBeenCalledWith({
      cost: 4,
      remaining: 4991,
      resetAt: "2026-08-03T13:00:00Z",
    });
    expect(client.recordRepoAccess).toHaveBeenCalledWith(
      GitHubSyncRepoAccessOutcome.Ok
    );
  });

  it("writes only PRs changed since the watermark and advances it to the newest", async () => {
    wireSuccess([
      readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" }), // fresh
      readModelPr({ number: 3, updatedAt: "2026-07-20T00:00:00Z" }), // stale
    ]);

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Swept);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite.mock.calls[0][0]).toMatchObject({ number: 9 });
    // Watermark advances to the newest updatedAt observed this sweep.
    expect(lastSyncData().watermark).toEqual(new Date("2026-08-02T10:00:00Z"));
    expect(lastSyncData().deferredReason).toBeNull();
    expect(lastSyncData().consecutiveFailureCount).toBe(0);
    expect(lastSyncData().tier).toBe(GitHubRepoSyncTier.Installed);
  });

  it("self-heals a terminal watermark-old PR that is missing LOC", async () => {
    selfHealRows = [{ number: 3 }]; // terminal-missing-LOC target
    wireSuccess([
      readModelPr({ number: 3, updatedAt: "2026-07-20T00:00:00Z" }), // stale but targeted
    ]);

    await reconcileRepo(INPUT, { now: NOW });

    // Written despite being below the watermark because it is a self-heal target.
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite.mock.calls[0][0]).toMatchObject({ number: 3 });
  });

  it("debounces self-heal selection by lastRefreshAttemptAt so a never-fillable PR cannot re-occupy the batch", async () => {
    wireSuccess([]);

    await reconcileRepo(INPUT, { now: NOW });

    // The selection must exclude rows attempted within the debounce window —
    // not just filter on missing-LOC (the whole point of stamping the field).
    const andClauses = (selfHealWhere?.AND ?? []) as {
      OR?: Record<string, unknown>[];
    }[];
    const debounce = andClauses.find((clause) =>
      clause.OR?.some((predicate) => "lastRefreshAttemptAt" in predicate)
    );
    expect(debounce?.OR).toContainEqual({ lastRefreshAttemptAt: null });
  });

  it("records the drawing user's id as the fetch credential owner on a tier-2 write", async () => {
    wireSuccess(
      [readModelPr({ number: 7, updatedAt: "2026-08-02T00:00:00Z" })],
      GitHubCredentialKind.OauthUser
    );

    await reconcileRepo(INPUT, { now: NOW });

    expect(mockWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ credentialOwnerId: "user-uuid-1" })
    );
  });

  it("records a null credential owner on an installation write", async () => {
    wireSuccess([
      readModelPr({ number: 7, updatedAt: "2026-08-02T00:00:00Z" }),
    ]);

    await reconcileRepo(INPUT, { now: NOW });

    expect(mockWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ credentialOwnerId: null })
    );
  });

  it("derives tier user_token when the pool draws a user credential", async () => {
    wireSuccess(
      [readModelPr({ number: 7, updatedAt: "2026-08-02T00:00:00Z" })],
      GitHubCredentialKind.OauthUser
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.tier).toBe(GitHubRepoSyncTier.UserToken);
    expect(lastSyncData().tier).toBe(GitHubRepoSyncTier.UserToken);
  });

  it("backs off when the fetch itself fails after a successful draw", async () => {
    mockGetClient.mockResolvedValue({
      ok: true,
      value: makeClient(GitHubCredentialKind.Installation),
    });
    mockQuery.mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });

    const result = await reconcileRepo(
      { ...INPUT, consecutiveFailureCount: 0 },
      { now: NOW }
    );

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockWriteFailures).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: INPUT.organizationId,
        result: {
          status: GitHubProviderResultStatus.ProviderUnavailable,
        },
        provenance: expect.objectContaining({
          observationKey: expect.any(String),
        }),
      })
    );
  });

  it("persists a continuation cursor when a bounded read truncates a backlog", async () => {
    wireSuccess(
      [readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" })],
      GitHubCredentialKind.Installation,
      { truncated: true, nextCursor: "cursor-page-2" }
    );

    await reconcileRepo(INPUT, { now: NOW });

    // Older PRs remain below the fetched window — resume from here next tick,
    // rather than advancing the watermark past them.
    expect(lastSyncData().cursor).toBe("cursor-page-2");
  });

  it("does NOT re-drain in steady state: a truncated top page that reaches watermark-old PRs clears the cursor", async () => {
    // cursor: null (steady state) + a page that truncates but contains a PR at or
    // below the watermark. The repo simply has >1 page of PRs; there is no fresh
    // backlog, so the cursor must NOT be set (else the repo re-drains every tick).
    wireSuccess(
      [
        readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" }), // fresh
        readModelPr({ number: 3, updatedAt: "2026-07-20T00:00:00Z" }), // <= watermark
      ],
      GitHubCredentialKind.Installation,
      { truncated: true, nextCursor: "cursor-page-2" }
    );

    await reconcileRepo(INPUT, { now: NOW });

    expect(lastSyncData().cursor).toBeNull();
  });

  it("DOES start a drain in steady state when every fetched PR is newer than the watermark (a real >window burst)", async () => {
    wireSuccess(
      [
        readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" }),
        readModelPr({ number: 8, updatedAt: "2026-08-02T09:00:00Z" }),
      ],
      GitHubCredentialKind.Installation,
      { truncated: true, nextCursor: "cursor-page-2" }
    );

    await reconcileRepo(INPUT, { now: NOW });

    expect(lastSyncData().cursor).toBe("cursor-page-2");
  });

  it("debounces only self-heal targets it actually fetched, never ones outside the window", async () => {
    // Target #3 is selected but NOT returned by the bounded read (targetNumbers is
    // a stop condition, not a fetch-by-number). It must not be stamped as attempted.
    selfHealRows = [{ number: 3 }];
    wireSuccess([
      readModelPr({ number: 9, updatedAt: "2026-08-02T10:00:00Z" }),
    ]);

    await reconcileRepo(INPUT, { now: NOW });

    // No debounce write at all — the only selected target was never fetched.
    expect(debounceCalls).toHaveLength(0);
  });

  it("does debounce a self-heal target that was fetched (a real attempt)", async () => {
    selfHealRows = [{ number: 3 }];
    wireSuccess([
      readModelPr({ number: 3, updatedAt: "2026-07-20T00:00:00Z" }), // fetched target
    ]);

    await reconcileRepo(INPUT, { now: NOW });

    expect(debounceCalls).toContainEqual(
      expect.objectContaining({ number: { in: [3] } })
    );
  });

  it("resumes from the stored cursor and refreshes every fetched row while draining", async () => {
    // A watermark-old, non-target PR: it is written ONLY because we are draining.
    wireSuccess(
      [readModelPr({ number: 3, updatedAt: "2026-07-10T00:00:00Z" })],
      GitHubCredentialKind.Installation,
      { truncated: false }
    );

    await reconcileRepo({ ...INPUT, cursor: "cursor-page-2" }, { now: NOW });

    // The fetch resumes from the stored cursor…
    expect(fetchOpts?.after).toBe("cursor-page-2");
    // …and the older row is refreshed even though it is below the watermark and
    // not a self-heal target (the whole point of a backlog drain)…
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite.mock.calls[0][0]).toMatchObject({ number: 3 });
    // …and the drain completes (not truncated), so the cursor clears.
    expect(lastSyncData().cursor).toBeNull();
  });
});

describe("reconcileRepo — repo denial verdicts (ISS-5093)", () => {
  /**
   * Wire a successful client draw that returns a non-Success fetch result.
   * Returns the mock client so callers can assert on recordRepoAccess.
   */
  function wireFailureResult(
    status: GitHubProviderResultStatus,
    kind: GitHubCredentialKind = GitHubCredentialKind.OauthUser
  ) {
    const client = makeClient(kind);
    mockGetClient.mockResolvedValue({ ok: true, value: client });
    mockQuery.mockResolvedValue({ status });
    return client;
  }

  it("ProviderRepoNotFound records NoAccess verdict and persists failure", async () => {
    const client = wireFailureResult(
      GitHubProviderResultStatus.ProviderRepoNotFound
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(client.recordRepoAccess).toHaveBeenCalledWith(
      GitHubSyncRepoAccessOutcome.NoAccess
    );
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
  });

  it("ProviderRepoForbidden records NoAccess verdict and persists failure", async () => {
    const client = wireFailureResult(
      GitHubProviderResultStatus.ProviderRepoForbidden
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(client.recordRepoAccess).toHaveBeenCalledWith(
      GitHubSyncRepoAccessOutcome.NoAccess
    );
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
  });

  // The generic HTTP-403 status must NOT be read as a repo-level denial: the
  // bundled read also produces it for an org-level 403 (SAML, IP allowlist,
  // OAuth App restriction) and for a 403 on a later page whose first page
  // already reached the repo. Recording those would mint a 6h no-access verdict
  // against a healthy credential and demote the repo to unsyncable.
  it("ProviderPermissionFiltered does NOT record a repo access verdict", async () => {
    const client = wireFailureResult(
      GitHubProviderResultStatus.ProviderPermissionFiltered
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(client.recordRepoAccess).not.toHaveBeenCalled();
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
  });

  it("ProviderUnavailable does not record a repo access verdict and persists failure", async () => {
    const client = wireFailureResult(
      GitHubProviderResultStatus.ProviderUnavailable
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(client.recordRepoAccess).not.toHaveBeenCalled();
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
  });

  it("ProviderRateLimit does not record a repo access verdict and persists failure", async () => {
    const client = wireFailureResult(
      GitHubProviderResultStatus.ProviderRateLimit
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(client.recordRepoAccess).not.toHaveBeenCalled();
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
  });

  it("installation lane: ProviderRepoNotFound persists failure; no capability verdict is stored because recordRepoAccess is a production no-op for installation clients", async () => {
    // In production, github-sync-client-pool.ts (resolveCoveringInstallation)
    // wires recordRepoAccess as a hard no-op for installation clients.
    // Installation reach is governed by the installation's repository list, not
    // per-credential verdicts. A future implementer must NOT 'fix' this by
    // wiring real installation verdicts — doing so would conflate two orthogonal
    // access models and mis-demote repos whose installation simply hasn't listed
    // them yet.
    const client = wireFailureResult(
      GitHubProviderResultStatus.ProviderRepoNotFound,
      GitHubCredentialKind.Installation
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    // The failure must be persisted so the backoff counter advances.
    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
    // recordNoAccessIfRepoDenied has no client-kind guard — it calls
    // recordRepoAccess for all clients — but the production installation-lane
    // implementation is a hard no-op (see resolveCoveringInstallation in
    // github-sync-client-pool.ts). The mock here resolves silently, matching
    // that real behavior: the function is called, nothing is stored.
    expect(client.recordRepoAccess).toHaveBeenCalled();
  });

  it("writeReconciledPullRequestFailures rejection does not block verdict or failure persist", async () => {
    const client = wireFailureResult(
      GitHubProviderResultStatus.ProviderRepoNotFound
    );
    mockWriteFailures.mockRejectedValueOnce(
      new Error("transactional writer threw")
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(client.recordRepoAccess).toHaveBeenCalledWith(
      GitHubSyncRepoAccessOutcome.NoAccess
    );
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
  });

  it("recordRepoAccess rejection is swallowed and failure is still persisted (best-effort guard)", async () => {
    // The capability store rethrows any non-P2002 error, so an unguarded await
    // of recordRepoAccess would skip persistFailure and lose the backoff counter
    // entirely. This test proves the try/catch in recordNoAccessIfRepoDenied is
    // load-bearing: losing a verdict costs one extra draw next tick, while
    // losing the failure persist would lose the backoff counter entirely.
    const client = wireFailureResult(
      GitHubProviderResultStatus.ProviderRepoNotFound
    );
    client.recordRepoAccess.mockRejectedValue(
      new Error("capability store outage")
    );

    const result = await reconcileRepo(INPUT, { now: NOW });

    expect(result.status).toBe(ReconcileRepoStatus.Failed);
    expect(lastSyncData().consecutiveFailureCount).toBe(1);
  });
});

describe("computeNextRetryAt", () => {
  it("returns now + 30min for the first failure", () => {
    const result = computeNextRetryAt(1, NOW);
    expect(result.getTime()).toBe(NOW.getTime() + BACKOFF_BASE_MS);
  });

  it("doubles the delay for each subsequent failure", () => {
    expect(computeNextRetryAt(2, NOW).getTime()).toBe(
      NOW.getTime() + BACKOFF_BASE_MS * 2
    );
    expect(computeNextRetryAt(3, NOW).getTime()).toBe(
      NOW.getTime() + BACKOFF_BASE_MS * 4
    );
  });

  it("caps the delay at 24 hours at the boundary (count=7)", () => {
    const uncapped = BACKOFF_BASE_MS * 2 ** 6;
    expect(uncapped).toBeGreaterThan(BACKOFF_MAX_MS);
    const result = computeNextRetryAt(7, NOW);
    expect(result.getTime()).toBe(NOW.getTime() + BACKOFF_MAX_MS);
  });

  it("stays capped for counts far above the boundary", () => {
    const result = computeNextRetryAt(20, NOW);
    expect(result.getTime()).toBe(NOW.getTime() + BACKOFF_MAX_MS);
  });

  it("treats non-positive counts as the first failure", () => {
    expect(computeNextRetryAt(0, NOW).getTime()).toBe(
      NOW.getTime() + BACKOFF_BASE_MS
    );
    expect(computeNextRetryAt(-1, NOW).getTime()).toBe(
      NOW.getTime() + BACKOFF_BASE_MS
    );
  });
});

describe("reconcileRepo — nextRetryAt lifecycle", () => {
  function wireSuccess(
    prs: ReturnType<typeof readModelPr>[],
    kind: GitHubCredentialKind = GitHubCredentialKind.Installation
  ) {
    const client = makeClient(kind);
    mockGetClient.mockResolvedValue({ ok: true, value: client });
    mockQuery.mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        pullRequests: prs,
        truncated: false,
        nextCursor: null,
      },
    });
    return client;
  }

  it("clears nextRetryAt on a successful sweep", async () => {
    wireSuccess([
      readModelPr({ number: 1, updatedAt: "2026-08-02T00:00:00Z" }),
    ]);

    await reconcileRepo({ ...INPUT, consecutiveFailureCount: 3 }, { now: NOW });

    expect(lastSyncData().consecutiveFailureCount).toBe(0);
    expect(lastSyncData().nextRetryAt).toBeNull();
  });

  it("sets nextRetryAt on a fetch failure", async () => {
    mockGetClient.mockResolvedValue({
      ok: true,
      value: makeClient(GitHubCredentialKind.Installation),
    });
    mockQuery.mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderUnavailable,
      value: null,
    });

    await reconcileRepo({ ...INPUT, consecutiveFailureCount: 4 }, { now: NOW });

    expect(lastSyncData().consecutiveFailureCount).toBe(5);
    expect(lastSyncData().nextRetryAt).toEqual(computeNextRetryAt(5, NOW));
  });
});
