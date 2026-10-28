/**
 * ISS-6579 / ISS-6590 — HOW `reconcileOrgRepoSyncStates` writes.
 *
 * Split from `github-repo-sync-state.test.ts`, which owns what the reconciler
 * DECIDES (tier classification, the verdict reads, the bootstrap selector).
 * This file owns the write itself: that it is one set-based
 * `INSERT ... ON CONFLICT` per chunk rather than a per-repo fan-out, that the
 * chunking keeps the statement under Postgres's bind ceiling, that the repo
 * order is total so two concurrent reconciles cannot deadlock, and that a
 * rejected statement neither abandons the chunks behind it nor writes off the
 * repos inside it.
 *
 * The fake client and the fragment-tree readers are the shared ones from
 * `github-repo-sync-doubles.ts`, so both files assert against one model of the
 * statement rather than two that can drift.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BINDS_PER_UPSERT_ROW,
  bindsOf,
  failChunkCarrying,
  failEveryWrite,
  failOneRepoThroughFallback,
  LAST_TIER_EVALUATED_AT_BIND_OFFSET,
  type MockDb,
  makeDb,
  mockPrismaJoin,
  mockPrismaSql,
  REPO_FULL_NAME_BIND_OFFSET,
  repoRows,
  staticSqlOf,
  tiersByRepoFrom,
  UPDATED_AT_BIND_OFFSET,
} from "./github-repo-sync-doubles";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { sql: mockPrismaSql, join: mockPrismaJoin },
  GitHubInstallationStatus: {
    PENDING_CLAIM: "PENDING_CLAIM",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    UNINSTALLED: "UNINSTALLED",
  },
}));

vi.mock("@repo/api/src/types/branch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/api/src/types/branch")>()),
  normalizeRepoFullName: (value: string) => value.trim().toLowerCase(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Run the fan-out sequentially so the fallback's call assertions are
// deterministic.
vi.mock("@/lib/db-fanout", () => ({
  mapWithDbConcurrency: (
    items: readonly unknown[],
    fn: (item: unknown, index: number) => Promise<unknown>
  ) => Promise.all(items.map((item, index) => fn(item, index))),
}));

import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  FAILED_REPO_LOG_SAMPLE,
  REPO_SYNC_TIER_UPSERT_CHUNK_SIZE,
  reconcileOrgRepoSyncStates,
} from "@/lib/github/github-repo-sync-state";
import { POSTGRES_MAX_ACCEPTED_VERBATIM_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};

const NOW = new Date("2026-08-03T12:00:00.000Z");
const ORG = "org-1";

function wire(db: MockDb): void {
  mockWithDb.mockImplementation((fn: (client: MockDb) => unknown) => fn(db));
  mockWithDb.tx.mockImplementation((fn: (client: MockDb) => unknown) => fn(db));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reconcileOrgRepoSyncStates write path", () => {
  it("ISS-6579: writes the whole org through one INSERT ... ON CONFLICT that touches only tier + lastTierEvaluatedAt", async () => {
    const db = makeDb();
    db.pullRequestDetail.groupBy.mockResolvedValue([
      { repositoryFullName: "acme/orphan" },
    ]);
    wire(db);

    await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    const sql = staticSqlOf(db.$executeRaw.mock.calls[0]?.[0]);
    expect(sql).toContain('INSERT INTO "github_repo_sync_state"');
    expect(sql).toContain(
      'ON CONFLICT ("organization_id", "repository_full_name") DO UPDATE SET'
    );
    // The reconciler owns watermark/cursor/failure count/deferral/next retry,
    // and this statement must leave every one of them untouched.
    const assignedColumns = [...sql.matchAll(/"(\w+)" = /g)].map(
      (match) => match[1]
    );
    expect(assignedColumns.sort()).toEqual([
      "last_tier_evaluated_at",
      "tier",
      "updated_at",
    ]);
    // One repo, so the whole statement is exactly one VALUES row — this pins
    // the bind width the production chunk size is derived from.
    const binds = bindsOf(db.$executeRaw.mock.calls[0]?.[0]);
    expect(binds).toHaveLength(BINDS_PER_UPSERT_ROW);
    expect(binds[REPO_FULL_NAME_BIND_OFFSET]).toBe("acme/orphan");
    // Both timestamps are BOUND, never `NOW()`: the columns are TIMESTAMP(3)
    // (no zone), so a server-side clock would land a session-TimeZone-converted
    // value beside the UTC the Prisma writers on this table store.
    expect(binds[LAST_TIER_EVALUATED_AT_BIND_OFFSET]).toBe(NOW);
    expect(binds[UPDATED_AT_BIND_OFFSET]).toBe(NOW);
  });

  it("ISS-6579: writes repos in a total order so concurrent org reconciles cannot deadlock", async () => {
    // Neither source read carries an `orderBy`, and both reconcile callers run
    // via `waitUntil` — so without a total order two concurrent passes over the
    // same org can take the same row locks in opposite orders and deadlock
    // (40P01), which `reconcileOrgRepoSyncStatesBestEffort` would swallow.
    const db = makeDb();
    db.gitHubInstallationRepository.findMany.mockResolvedValue([
      { fullName: "acme/zulu" },
    ]);
    db.pullRequestDetail.groupBy.mockResolvedValue([
      { repositoryFullName: "acme/marisol" },
      { repositoryFullName: "acme/alpha" },
    ]);
    wire(db);

    await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect([...tiersByRepoFrom(db).keys()]).toEqual([
      "acme/alpha",
      "acme/marisol",
      "acme/zulu",
    ]);
  });

  it("ISS-6579: chunks the VALUES list so a large org cannot overflow the bind ceiling", async () => {
    const db = makeDb();
    const repoCount = REPO_SYNC_TIER_UPSERT_CHUNK_SIZE + 1;
    db.pullRequestDetail.groupBy.mockResolvedValue(
      Array.from({ length: repoCount }, (_unused, index) => ({
        repositoryFullName: `acme/repo-${index}`,
      }))
    );
    wire(db);

    const result = await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(result).toEqual({ repoCount, failedRepoCount: 0, settled: true });
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    const bindCounts = db.$executeRaw.mock.calls.map(
      (call) => bindsOf(call[0]).length
    );
    expect(
      bindCounts.every((count) => count % BINDS_PER_UPSERT_ROW === 0)
    ).toBe(true);
    // ISS-8239: was a bare `65_535`, which both re-declared a number the repo
    // owns and asserted the wrong bound — 65,535 is the last width a verbatim
    // statement is ACCEPTED at, and 65,536 is the first it is refused at.
    expect(Math.max(...bindCounts)).toBeLessThanOrEqual(
      POSTGRES_MAX_ACCEPTED_VERBATIM_BIND_PARAMETERS
    );
    // Every repo still lands, and the split is at the chunk boundary rather
    // than dropping the tail.
    expect(tiersByRepoFrom(db).size).toBe(repoCount);
  });

  it("attempts every remaining chunk after one rejects, and loses no repo to it (ISS-6590)", async () => {
    // whitlockk: chunk one commits on its own, so a loop that rethrew here would
    // leave the tail never even attempted — permanently, since an org already
    // carrying `githubRepoSyncBootstrappedAt` is never re-selected. Every chunk
    // must still run, and the rejected chunk's repos must go through the
    // per-repo fallback rather than being written off wholesale.
    const db = makeDb();
    const repoCount = REPO_SYNC_TIER_UPSERT_CHUNK_SIZE + 1;
    db.pullRequestDetail.groupBy.mockResolvedValue(repoRows(repoCount));
    wire(db);
    // `acme/repo-0` sorts into the FIRST chunk, so the tail chunk is the one
    // that must still be attempted.
    failChunkCarrying(db, "acme/repo-0");

    const result = await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    // Two statements, not one: the chunk behind the failure was still tried.
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    // …and the rejected chunk's repos landed one at a time instead.
    expect(db.gitHubRepoSyncState.upsert).toHaveBeenCalledTimes(
      REPO_SYNC_TIER_UPSERT_CHUNK_SIZE
    );
    expect(result).toEqual({ repoCount, failedRepoCount: 0, settled: true });
    // The fallback is not free and must not be silent: a DETERMINISTIC
    // statement error would otherwise make every pass pay a doomed round trip
    // plus a full per-repo fan-out while still reporting a clean, settled
    // result — the ISS-6579 win reverted with nothing saying so.
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("fell back to per-repo writes"),
      expect.objectContaining({
        organizationId: ORG,
        chunkCount: 1,
        repoCount: REPO_SYNC_TIER_UPSERT_CHUNK_SIZE,
        error: "pool acquire timeout",
      })
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("charges a rejected chunk only for the repos that really failed (ISS-6590)", async () => {
    // Chunk-granular accounting would blame one statement timeout on all 5,461
    // of its repos and leave a bootstrapped org's tiers stale with nothing to
    // retry them. The fallback keeps the failure set honest.
    const db = makeDb();
    db.pullRequestDetail.groupBy.mockResolvedValue([
      { repositoryFullName: "acme/one" },
      { repositoryFullName: "acme/two" },
      { repositoryFullName: "acme/three" },
    ]);
    wire(db);
    failOneRepoThroughFallback(db, "acme/two");

    const result = await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(result).toEqual({
      repoCount: 3,
      failedRepoCount: 1,
      settled: false,
    });
    expect(db.gitHubRepoSyncState.upsert).toHaveBeenCalledTimes(3);
    expect(db.organization.updateMany).not.toHaveBeenCalled();
    // Level, not just wording: one blip out of three repos must not fire the
    // log.error the outage alert watches.
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("fell back to per-repo writes"),
      expect.objectContaining({ organizationId: ORG, chunkCount: 1 })
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("pass incomplete"),
      expect.objectContaining({
        organizationId: ORG,
        failedRepoCount: 1,
        failedRepoSample: [
          { repositoryFullName: "acme/two", error: "pool acquire timeout" },
        ],
      })
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("keeps a total-loss pass at error level so outage alerting survives the swallowed per-repo errors (ISS-6590)", async () => {
    const db = makeDb();
    db.pullRequestDetail.groupBy.mockResolvedValue([
      { repositoryFullName: "acme/one" },
      { repositoryFullName: "acme/two" },
    ]);
    wire(db);
    failEveryWrite(db, "pool down");

    const result = await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(result.failedRepoCount).toBe(2);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("pass failed"),
      expect.objectContaining({ organizationId: ORG, failedRepoCount: 2 })
    );
    // One line per pass, not per repo: `toHaveBeenCalledWith` alone would still
    // match if the summary moved into the per-repo catch.
    expect(log.error).toHaveBeenCalledTimes(1);
    // The fallback's own warn still fires — what must not appear at warn level
    // is the pass summary, which an outage reports through log.error.
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("pass incomplete"),
      expect.anything()
    );
  });

  it("gives up on a chunk once the fallback has spent its failure budget (ISS-6590)", async () => {
    // Under a pool outage the fallback would otherwise turn ONE rejected
    // statement into a whole chunk of doomed round trips — up to 5,461 — and
    // the bootstrap cron only checks its deadline between orgs, so one large
    // org could burn the route and starve the ones behind it. Every repo is
    // still reported as failed; only the doomed queries are skipped.
    const db = makeDb();
    const repoCount = 40;
    db.pullRequestDetail.groupBy.mockResolvedValue(repoRows(repoCount));
    wire(db);
    failEveryWrite(db, "pool down");

    const result = await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(result.failedRepoCount).toBe(repoCount);
    // Bounded by the budget, not by the chunk: five attempts, then the rest of
    // the chunk is charged without being tried.
    expect(db.gitHubRepoSyncState.upsert).toHaveBeenCalledTimes(5);
    const detail = vi.mocked(log.error).mock.calls[0][1] as {
      failedRepoSample: { error: string }[];
    };
    expect(detail.failedRepoSample.at(-1)?.error).toContain(
      "fallback budget exhausted"
    );
  });

  it("caps the failed-repo sample so an org-wide outage cannot inflate the log line (ISS-6590)", async () => {
    const db = makeDb();
    const fullNames = Array.from(
      { length: FAILED_REPO_LOG_SAMPLE + 2 },
      (_, index) => ({ repositoryFullName: `acme/repo-${index}` })
    );
    db.pullRequestDetail.groupBy.mockResolvedValue(fullNames);
    wire(db);
    failEveryWrite(db, "pool down");

    await reconcileOrgRepoSyncStates(ORG, { now: NOW });

    expect(log.error).toHaveBeenCalledTimes(1);
    const detail = vi.mocked(log.error).mock.calls[0][1] as {
      failedRepoCount: number;
      failedRepoSample: { repositoryFullName: string }[];
    };
    expect(detail.failedRepoCount).toBe(fullNames.length);
    // Sorted, because the write is: `reconcileOrgRepoSyncStates` totally orders
    // the repo set so two concurrent passes cannot deadlock on the multi-row
    // `ON CONFLICT DO UPDATE`, and the sample follows that order.
    expect(detail.failedRepoSample.map((f) => f.repositoryFullName)).toEqual(
      fullNames
        .map((repo) => repo.repositoryFullName)
        .sort()
        .slice(0, FAILED_REPO_LOG_SAMPLE)
    );
  });
});
