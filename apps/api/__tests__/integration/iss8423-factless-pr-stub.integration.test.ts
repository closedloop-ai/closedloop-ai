/**
 * ISS-8423 — the desktop's factless PR stub, end to end against Postgres.
 *
 * The sibling CI integration test (ISS-8151) seeds `pull_request_detail` rows
 * directly, so it cannot reproduce the shape that actually shipped: a stub the
 * desktop lane WROTE. Both halves of the defect only exist across the producer
 * and the reconciler's target selection, so both run here for real — the write
 * must claim neither verification nor a refresh attempt for a ref that observed
 * nothing, and the reconciler must reach such a row without being able to
 * re-fetch it on every tick forever.
 */
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { withDb } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  RECONCILE_DESKTOP_STUB_ATTEMPT_DEBOUNCE_MS,
  RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS,
} from "@/app/cron/reconcile-pull-requests/constants";
import { selectSessionLinkedPullRequestTargets } from "@/app/cron/reconcile-pull-requests/session-linked-targets";
import { joinAmbientTransactionForSessionSyncWrites } from "../utils/db-helpers";
import {
  baseFixture,
  branchRef,
  findBranch,
  findPrByBranchNumber,
  PR_OBSERVED_AT,
  pullRequestRef,
  syncSession,
} from "./agent-session-pr-sync-helpers";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const REPO = "acme/widgets";
const NORMALIZED_REPO = normalizeRepoFullName(REPO);
const PR_NUMBER = 6160;

/**
 * Half a 24h debounce past the observation. A row whose attempt clock reads
 * `PR_OBSERVED_AT` is INSIDE the 24h window (so the ordinary arm cannot admit
 * it) and OUTSIDE the shorter stub window (so the stub arm can) — which is what
 * isolates the stub arm in the cases that set that clock.
 */
const NOW = new Date(
  PR_OBSERVED_AT.getTime() + RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS / 2
);

/** An attempt the reconciler made moments ago — inside the stub window. */
const JUST_ATTEMPTED = new Date(
  NOW.getTime() - RECONCILE_DESKTOP_STUB_ATTEMPT_DEBOUNCE_MS / 2
);

/**
 * An attempt old enough that the ORDINARY 24h window has elapsed too. A factless
 * row stamped this long ago satisfies both arms' raw predicates, so it is the
 * boundary the stub arm's `AND NOT ordinary` subtraction exists to charge to
 * exactly one batch.
 */
const ORDINARY_WINDOW_ELAPSED = new Date(
  NOW.getTime() - RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS * 1.25
);

/** An attempt whose stub window has since elapsed — the row is due again. */
const STUB_WINDOW_ELAPSED = new Date(
  NOW.getTime() - RECONCILE_DESKTOP_STUB_ATTEMPT_DEBOUNCE_MS * 2
);

/** A desktop re-sync a minute ago — later than every clock this suite sets. */
const RESYNCED_AT = new Date(NOW.getTime() - 60 * 1000);

type PrRefOverrides = {
  prNumber: number;
  title?: string;
  state?: GitHubPRState;
  observedAt?: string;
};

function syncPr(
  fx: Awaited<ReturnType<typeof baseFixture>>,
  branchName: string,
  overrides: PrRefOverrides
) {
  return syncSession({
    ...fx,
    artifactRefs: [
      branchRef(REPO, branchName),
      pullRequestRef({
        repositoryFullName: REPO,
        branchName,
        ...overrides,
      }),
    ],
  });
}

/**
 * Sync a PR ref and return the row the desktop lane wrote for it. Throws rather
 * than returning null, so a case that never materialized cannot reach an
 * assertion an absent row would also satisfy.
 */
async function syncAndFindPr(
  fx: Awaited<ReturnType<typeof baseFixture>>,
  branchName: string,
  overrides: PrRefOverrides
) {
  await syncPr(fx, branchName, overrides);
  const branch = await findBranch(
    fx.organizationId,
    NORMALIZED_REPO,
    branchName
  );
  if (!branch) {
    throw new Error(`branch ${branchName} did not materialize`);
  }
  const pr = await findPrByBranchNumber(branch.artifactId, overrides.prNumber);
  if (!pr) {
    throw new Error(`PR ${overrides.prNumber} did not materialize`);
  }
  return pr;
}

function selectTargets(organizationId: string) {
  return selectSessionLinkedPullRequestTargets({
    organizationId,
    repositoryId: null,
    repositoryFullName: NORMALIZED_REPO,
    now: NOW,
  });
}

function stampClocks(
  id: string,
  data: { lastVerifiedAt?: Date; lastRefreshAttemptAt?: Date }
) {
  return withDb((db) => db.pullRequestDetail.update({ where: { id }, data }));
}

/** Disjoint PR-number bands, so a returned target names its own cohort. */
const STUB_NUMBER_BASE = 9000;
const ORDINARY_NUMBER_BASE = 9100;
const BOTH_ARMS_NUMBER_BASE = 9200;

function numbersFrom(base: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => base + index);
}

function countInBand(targets: { number: number }[], base: number): number {
  return targets.filter(
    (target) => target.number >= base && target.number < base + 100
  ).length;
}

/**
 * Desktop-produced PR rows on an already-linked branch. The reconciler's
 * desktop arm keys on the session -> branch link, not on a per-PR link, so
 * these all qualify without a session sync each.
 */
function seedDesktopPullRequests(
  organizationId: string,
  branchArtifactId: string,
  rows: {
    number: number;
    title: string | null;
    lastVerifiedAt: Date | null;
    lastRefreshAttemptAt: Date | null;
  }[]
) {
  return withDb((db) =>
    db.pullRequestDetail.createMany({
      data: rows.map((row) => ({
        branchArtifactId,
        organizationId,
        repositoryId: null,
        repositoryFullName: NORMALIZED_REPO,
        number: row.number,
        title: row.title,
        fetchMechanism: GitHubFetchMechanism.DesktopSync,
        // ISS-8462: a desktop-produced row carries BOTH — the mutable
        // last-writer AND the durable origin the target arm now reads. The
        // ingest writes both and the migration backfills both, so a fixture
        // setting only `fetchMechanism` no longer models one.
        desktopOriginated: true,
        lastVerifiedAt: row.lastVerifiedAt,
        lastRefreshAttemptAt: row.lastRefreshAttemptAt,
      })),
    })
  );
}

describeIfDb("factless desktop PR stub (ISS-8423)", () => {
  it("writes the row while claiming neither verification nor a refresh attempt", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      const pr = await syncAndFindPr(fx, "feature/factless", {
        prNumber: PR_NUMBER,
      });

      // The row exists and is the desktop's — the null clocks below are about
      // what it claims, not about a write that never landed.
      expect(pr.fetchMechanism).toBe(GitHubFetchMechanism.DesktopSync);
      expect(pr.htmlUrl).toBe(
        `https://github.com/${NORMALIZED_REPO}/pull/${PR_NUMBER}`
      );
      expect(pr.title).toBeNull();
      expect(pr.lastVerifiedAt).toBeNull();
      expect(pr.lastRefreshAttemptAt).toBeNull();
      // `pr_state` is the column default here, which is why the row must not
      // read as verified: nothing measured it.
      expect(pr.prState).toBe(GitHubPRState.Open);

      // A never-attempted row is admitted by the ordinary `IS NULL` arm — this
      // case does not exercise the stub arm, the two below do.
      await expect(selectTargets(fx.organizationId)).resolves.toEqual([
        expect.objectContaining({
          number: PR_NUMBER,
          pullRequestDetailId: pr.id,
        }),
      ]);
    });
  });

  it("selects a stub an older build stamped as verified and attempted", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      const pr = await syncAndFindPr(fx, "feature/legacy-stub", {
        prNumber: PR_NUMBER,
      });

      // The population that already exists in production: a build predating
      // this fix stamped BOTH clocks on the same factless row. The attempt
      // stamp puts it inside the 24h debounce, so the stub arm is the only way
      // in — and the arm has to key on the emptiness, not on
      // `last_verified_at IS NULL`, or these rows stay unreachable forever.
      await stampClocks(pr.id, {
        lastVerifiedAt: PR_OBSERVED_AT,
        lastRefreshAttemptAt: PR_OBSERVED_AT,
      });

      await expect(selectTargets(fx.organizationId)).resolves.toEqual([
        expect.objectContaining({ pullRequestDetailId: pr.id }),
      ]);
    });
  });

  it("backs a stub off after an attempt instead of re-selecting it every tick", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      const pr = await syncAndFindPr(fx, "feature/just-attempted", {
        prNumber: PR_NUMBER,
      });

      // What `stampMissingTargetAttempts` leaves behind when the provider has
      // no such PR: the attempt clock moves, no fact column can. Without the
      // stub arm's own window this row would refill the batch on every tick,
      // and it sorts ahead of every verified row.
      await stampClocks(pr.id, { lastRefreshAttemptAt: JUST_ATTEMPTED });

      await expect(selectTargets(fx.organizationId)).resolves.toEqual([]);
    });
  });

  // `state` IS an observation, so the row earns verification. But `pr_state` is
  // NOT NULL with a default, so the reconciler cannot tell this row from one
  // nobody measured and still classifies it a stub — which is why the producer
  // must leave that arm's clock alone (whitlockk, 2026-08-28).
  it("stamps verification but not the retry clock for a state-only ref", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      const pr = await syncAndFindPr(fx, "feature/state-only", {
        prNumber: PR_NUMBER,
        state: GitHubPRState.Open,
      });

      expect(pr.prState).toBe(GitHubPRState.Open);
      expect(pr.lastVerifiedAt).toEqual(PR_OBSERVED_AT);
      expect(pr.lastRefreshAttemptAt).toBeNull();
    });
  });

  it("keeps a state-only stub reachable across repeated desktop syncs", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      const branchName = "feature/state-only-resync";
      const pr = await syncAndFindPr(fx, branchName, {
        prNumber: PR_NUMBER,
        state: GitHubPRState.Open,
      });

      // The reconciler attempted it and the provider returned nothing; the stub
      // window has since elapsed, so the row is due again.
      await stampClocks(pr.id, { lastRefreshAttemptAt: STUB_WINDOW_ELAPSED });
      await expect(selectTargets(fx.organizationId)).resolves.toEqual([
        expect.objectContaining({ pullRequestDetailId: pr.id }),
      ]);

      // The branch is active, so the desktop re-observes the same PR. A producer
      // that owned the retry clock would reset it here — and since syncs land
      // more often than hourly, the row would leave the window on every sync and
      // never reach the reconciler again. This selection is the whole defect.
      const resynced = await syncAndFindPr(fx, branchName, {
        prNumber: PR_NUMBER,
        state: GitHubPRState.Open,
        observedAt: RESYNCED_AT.toISOString(),
      });
      await expect(selectTargets(fx.organizationId)).resolves.toEqual([
        expect.objectContaining({ pullRequestDetailId: pr.id }),
      ]);
      // ...because the ingest advanced verification and left the retry clock be.
      expect(resynced.lastVerifiedAt).toEqual(RESYNCED_AT);
      expect(resynced.lastRefreshAttemptAt).toEqual(STUB_WINDOW_ELAPSED);
    });
  });

  // ISS-8423 (whitlockk + davetho review, Perrin's call 2026-08-28). Stubs sort
  // first under `last_verified_at ASC NULLS FIRST`, so before the reserve a
  // cohort this size took the whole batch and the verified tail behind it never
  // refreshed. Counts are spelled out rather than computed from
  // RECONCILE_VERIFIED_TAIL_BATCH_RESERVE, which is the constant under test.
  it("caps the stub cohort so the verified tail keeps its share of the batch", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      const branchName = "feature/reserved-batch";
      // Establishes the session -> branch push link that admits every
      // desktop_sync row on this branch. Its own PR carries a title and a fresh
      // attempt clock, so it is not eligible and does not enter either cohort.
      await syncAndFindPr(fx, branchName, {
        prNumber: PR_NUMBER,
        title: "Seeded",
      });
      const branch = await findBranch(
        fx.organizationId,
        NORMALIZED_REPO,
        branchName
      );
      if (!branch) {
        throw new Error("branch did not materialize");
      }

      await seedDesktopPullRequests(fx.organizationId, branch.artifactId, [
        // 14 stubs, each past its 1h window: more than the cohort may take.
        ...numbersFrom(STUB_NUMBER_BASE, 14).map((number) => ({
          number,
          title: null,
          lastVerifiedAt: null,
          lastRefreshAttemptAt: STUB_WINDOW_ELAPSED,
        })),
        // The verified tail the reserve exists for: fact-carrying, verified,
        // admitted by the ordinary `IS NULL` arm, and sorting behind anything
        // unverified.
        ...numbersFrom(ORDINARY_NUMBER_BASE, 14).map((number) => ({
          number,
          title: `PR ${number}`,
          lastVerifiedAt: PR_OBSERVED_AT,
          lastRefreshAttemptAt: null,
        })),
        // One row BOTH arms' raw predicates admit: factless like a stub, but
        // attempted long enough ago that the ordinary 24h window elapsed too.
        // It sorts first in the ordinary batch (unverified) AND first in the
        // stub cohort (oldest attempt), so it is drawn twice by any build that
        // loses the stub arm's `AND NOT ordinary` subtraction.
        {
          number: BOTH_ARMS_NUMBER_BASE,
          title: null,
          lastVerifiedAt: null,
          lastRefreshAttemptAt: ORDINARY_WINDOW_ELAPSED,
        },
      ]);

      const targets = await selectTargets(fx.organizationId);
      const ids = targets.map((target) => target.pullRequestDetailId);

      expect(targets).toHaveLength(25);
      // Disjointness EXECUTED rather than string-matched against generated SQL:
      // a row drawn by both batches consumes two of the 25 slots and is fetched
      // from the provider twice, which defeats the capacity this case pins.
      // Asserted before the band counts because a duplicate inflates one of
      // them, so an unchecked one would report the split wrongly rather than
      // report it as broken.
      expect(new Set(ids).size).toBe(ids.length);
      expect(countInBand(targets, STUB_NUMBER_BASE)).toBe(12);
      // The reserved 13, charged to the ordinary batch: the both-arms row plus
      // 12 of the verified tail.
      expect(countInBand(targets, BOTH_ARMS_NUMBER_BASE)).toBe(1);
      expect(countInBand(targets, ORDINARY_NUMBER_BASE)).toBe(12);
    });
  });

  it("stamps both clocks for a fact-carrying ref and debounces it", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      const pr = await syncAndFindPr(fx, "feature/with-facts", {
        prNumber: PR_NUMBER,
        title: "Add the widget",
      });

      expect(pr.title).toBe("Add the widget");
      expect(pr.lastVerifiedAt).toEqual(PR_OBSERVED_AT);
      expect(pr.lastRefreshAttemptAt).toEqual(PR_OBSERVED_AT);

      // The stub arm must not have widened into "every desktop row, always":
      // a row carrying a fetchable fact waits out the 24h attempt debounce.
      await expect(selectTargets(fx.organizationId)).resolves.toEqual([]);
    });
  });
});
