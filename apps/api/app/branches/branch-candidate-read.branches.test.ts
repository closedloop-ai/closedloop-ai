import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { describe, expect, it, vi } from "vitest";
import {
  collectSqlValues,
  renderSql,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import {
  getAllBranchCandidateSnapshots,
  getBranchCandidateIds,
  getBranchCandidatePage,
} from "./branch-candidate-read";

// Branch-coverage lane (ISS-10513, lane h). Targets slots left uncovered by the
// sibling `branch-candidate-read.test.ts`, which never drives
// `getBranchCandidateSnapshots`'s empty-requested-ids short-circuit, its
// `compareBranchCandidateSnapshots` ordering (only reachable via a
// requested-ids sort with 2+ results), or a within-window activity keyset
// cursor.

describe("getBranchCandidateIds", () => {
  it("returns no ids and skips the query for an explicitly empty requested-id set", async () => {
    const queryRaw = vi.fn();

    const ids = await getBranchCandidateIds(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0 },
      []
    );

    expect(ids).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("orders requested candidates by canonical activity, most-recent first, tie-broken by repository/branch/id once activity is equal", async () => {
    const evaluationNow = new Date("2026-08-18T12:00:00.000Z");
    const pastOlderId = PAST_OLDER_ID;
    const pastNewerId = PAST_NEWER_ID;
    // atomOccurredAt in the future relative to evaluationNow: `activityAtom` is
    // still non-null (the optional chain resolves), but `compareBranchCandidateSnapshots`
    // still treats it as "no canonical activity" because it fails the `<= now`
    // check, distinct from the genuinely-absent-activity rows below.
    const futureId = FUTURE_DATED_ID;
    const tieOneId = TIE_ONE_ID;
    const tieTwoId = TIE_TWO_ID;
    const requestedIds = [
      pastOlderId,
      pastNewerId,
      futureId,
      tieOneId,
      tieTwoId,
    ];
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        candidateRow(
          pastOlderId,
          "acme/repo-a",
          "branch-a",
          new Date("2026-08-01T00:00:00.000Z"),
          0
        ),
        candidateRow(
          pastNewerId,
          "acme/repo-b",
          "branch-b",
          new Date("2026-08-10T00:00:00.000Z"),
          0
        ),
        candidateRow(
          futureId,
          "acme/repo-c",
          "branch-c",
          new Date("2026-08-25T00:00:00.000Z"),
          0
        ),
        candidateRow(tieOneId, "acme/tie-repo", "tie-branch", null, 0),
        candidateRow(tieTwoId, "acme/tie-repo", "tie-branch", null, 0),
      ]);

    const ids = await getBranchCandidateIds(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0, evaluationNow },
      requestedIds
    );

    // Most-recent-first among candidates with in-window activity, then the
    // future-dated and no-activity candidates (all treated as "no canonical
    // activity") ordered by repository, then branch, then id.
    expect(ids).toEqual([
      pastNewerId,
      pastOlderId,
      futureId,
      tieOneId,
      tieTwoId,
    ]);
  });

  it("ranks an in-window candidate ahead of a no-activity candidate regardless of requested order", async () => {
    const evaluationNow = new Date("2026-08-18T12:00:00.000Z");
    const noActivityId = NO_ACTIVITY_ID;
    const pastActivityId = PAST_ACTIVITY_ID;
    // Requested with the no-activity candidate FIRST: the two elements sort
    // into a two-item array, and this ordering is what puts the in-window
    // candidate on the comparator's "left" side against a "right" side that
    // has no canonical activity at all (as opposed to the mirror pairing
    // already exercised above with the no-activity candidate on the left).
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        candidateRow(noActivityId, "acme/repo-a", "branch-a", null, 0),
        candidateRow(
          pastActivityId,
          "acme/repo-b",
          "branch-b",
          new Date("2026-08-01T00:00:00.000Z"),
          0
        ),
      ]);

    const ids = await getBranchCandidateIds(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0, evaluationNow },
      [noActivityId, pastActivityId]
    );

    expect(ids).toEqual([pastActivityId, noActivityId]);
  });

  it("keeps the right candidate's real recent activity instead of collapsing it to no-activity", async () => {
    // Both candidates carry real, in-window activity — recent strictly more
    // recent than older. This distinguishes a comparator that reads the right
    // side's ACTUAL occurredAt from one that forces it to null (or to the raw
    // `?? `-less optional-chain result, or an inverted null-check): any of
    // those would collapse the right side's real activity into "no activity",
    // which sorts last, flipping this order.
    const evaluationNow = new Date("2026-08-18T12:00:00.000Z");
    const recentId = RECENT_ACTIVITY_ID;
    const olderId = OLDER_ACTIVITY_ID;
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        candidateRow(
          recentId,
          "acme/repo-recent",
          "branch-recent",
          new Date("2026-08-15T00:00:00.000Z"),
          0
        ),
        candidateRow(
          olderId,
          "acme/repo-older",
          "branch-older",
          new Date("2026-08-01T00:00:00.000Z"),
          0
        ),
      ]);

    const ids = await getBranchCandidateIds(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0, evaluationNow },
      [recentId, olderId]
    );

    expect(ids).toEqual([recentId, olderId]);
  });

  it("keeps a pre-epoch (negative-timestamp) candidate ranked ahead of a genuinely no-activity candidate", async () => {
    // A negative-epoch occurredAt makes the fallthrough arithmetic
    // (`rightActivity - leftActivity`, with a missing operand coercing to 0)
    // produce the OPPOSITE sign from the intended early return. Any modern
    // (post-1970, positive-epoch) fixture can't distinguish "return -1" from
    // "fall through and subtract", because both give a negative/consistent
    // sign for ordinary dates.
    const evaluationNow = new Date("2026-08-18T12:00:00.000Z");
    const noActivityId = NO_ACTIVITY_VS_PRE_EPOCH_ID;
    const preEpochId = PRE_EPOCH_ACTIVITY_ID;
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        candidateRow(noActivityId, "acme/repo-x", "branch-x", null, 0),
        candidateRow(
          preEpochId,
          "acme/repo-y",
          "branch-y",
          new Date(-100_000),
          0
        ),
      ]);

    const ids = await getBranchCandidateIds(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0, evaluationNow },
      [noActivityId, preEpochId]
    );

    expect(ids).toEqual([preEpochId, noActivityId]);
  });

  it("treats a future-dated candidate as no-activity even when it lands on the comparator's left side", async () => {
    const evaluationNow = new Date("2026-08-18T12:00:00.000Z");
    const pastId = LEFT_PAST_ID;
    const futureId = LEFT_FUTURE_ID;
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        candidateRow(
          pastId,
          "acme/repo-past",
          "branch-past",
          new Date("2026-08-01T00:00:00.000Z"),
          0
        ),
        candidateRow(
          futureId,
          "acme/repo-future",
          "branch-future",
          new Date("2026-08-25T00:00:00.000Z"),
          0
        ),
      ]);

    const ids = await getBranchCandidateIds(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0, evaluationNow },
      [pastId, futureId]
    );

    expect(ids).toEqual([pastId, futureId]);
  });

  it("ranks a left candidate whose activity occurs exactly at evaluationNow ahead of no-activity", async () => {
    // occurredAt === evaluationNow exactly: only the `<=` comparison (not a
    // strict `<`) admits it as in-window. If the boundary were strict, this
    // candidate would tie with the no-activity candidate on null activity and
    // fall to the repository tie-break instead — which is why the two
    // repository names are chosen to resolve the OPPOSITE way from the
    // activity-based order.
    const evaluationNow = new Date("2026-08-18T12:00:00.000Z");
    const noActivityId = RIGHT_NO_ACTIVITY_D_ID;
    const exactlyNowId = LEFT_EXACTLY_NOW_D_ID;
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        candidateRow(noActivityId, "aaa-repo-d", "branch-d0", null, 0),
        candidateRow(
          exactlyNowId,
          "zzz-repo-d",
          "branch-d1",
          new Date(evaluationNow.getTime()),
          0
        ),
      ]);

    const ids = await getBranchCandidateIds(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0, evaluationNow },
      [noActivityId, exactlyNowId]
    );

    expect(ids).toEqual([exactlyNowId, noActivityId]);
  });

  it("ranks a right candidate whose activity occurs exactly at evaluationNow ahead of no-activity", async () => {
    // Mirror of the previous case with the exactly-now candidate on the
    // opposite side of the comparator, to pin the `<=` boundary in
    // `rightOccurredAt <= now` as well as `leftOccurredAt <= now`.
    const evaluationNow = new Date("2026-08-18T12:00:00.000Z");
    const exactlyNowId = RIGHT_EXACTLY_NOW_E_ID;
    const noActivityId = LEFT_NO_ACTIVITY_E_ID;
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        candidateRow(
          exactlyNowId,
          "zzz-repo-e",
          "branch-e0",
          new Date(evaluationNow.getTime()),
          0
        ),
        candidateRow(noActivityId, "aaa-repo-e", "branch-e1", null, 0),
      ]);

    const ids = await getBranchCandidateIds(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0, evaluationNow },
      [exactlyNowId, noActivityId]
    );

    expect(ids).toEqual([exactlyNowId, noActivityId]);
  });

  it("orders by repository even when the branch name would sort the opposite way", async () => {
    // Both candidates carry no activity, so the comparator falls straight to
    // the repository/branch/id tie-break. repositorySortKey is decisive here
    // (nonzero), and branchSortKey resolves the OPPOSITE direction — a
    // comparator that skips the repository comparison (or short-circuits past
    // it, e.g. via an `&&` in place of `||`) lands on the branch- or
    // id-based order instead and gets this backwards.
    const alphaId = REPO_DECISIVE_ALPHA_ID;
    const betaId = REPO_DECISIVE_BETA_ID;
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        candidateRow(alphaId, "repo-a", "branch-z", null, 0),
        candidateRow(betaId, "repo-b", "branch-a", null, 0),
      ]);

    const ids = await getBranchCandidateIds(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0 },
      [alphaId, betaId]
    );

    expect(ids).toEqual([alphaId, betaId]);
  });

  it("falls through to the branch tie-break when repositorySortKey is equal, requiring an actual comparison rather than a stable no-op", async () => {
    // Same repository (repositorySortKey compares to 0) on both sides, so a
    // comparator that treats a zero/falsy first comparison as decisive (never
    // falling through to the branch comparison) would return 0 for every
    // pair here and let Array.sort's stability just preserve the requested
    // order. Requesting them in the WRONG order forces a real swap to occur
    // for this assertion to hold.
    const gammaId = BRANCH_DECISIVE_GAMMA_ID;
    const deltaId = BRANCH_DECISIVE_DELTA_ID;
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        candidateRow(gammaId, "shared-repo", "branch-z2", null, 0),
        candidateRow(deltaId, "shared-repo", "branch-a2", null, 0),
      ]);

    const ids = await getBranchCandidateIds(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0 },
      [gammaId, deltaId]
    );

    expect(ids).toEqual([deltaId, gammaId]);
  });

  it("falls through to the id tie-break when repository and branch are both equal", async () => {
    // Same repository AND same branch on both sides, requested in the wrong
    // (non-id-ascending) order. Only a genuine id comparison — not a
    // short-circuited/zero-collapsed one — produces the swap this asserts.
    // TIEBREAK_EPSILON_ID sorts lexicographically after TIEBREAK_ZETA_ID, so
    // the swap this test pins can only come from a real `id.localeCompare`.
    const epsilonId = TIEBREAK_EPSILON_ID;
    const zetaId = TIEBREAK_ZETA_ID;
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        candidateRow(epsilonId, "tie-repo2", "tie-branch2", null, 0),
        candidateRow(zetaId, "tie-repo2", "tie-branch2", null, 0),
      ]);

    const ids = await getBranchCandidateIds(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0 },
      [epsilonId, zetaId]
    );

    expect(ids).toEqual([zetaId, epsilonId]);
  });

  it("treats a future-dated candidate as no-activity even when it lands on the comparator's right side", async () => {
    // Mirror of the earlier future-on-left case: the future candidate here is
    // requested FIRST, which puts it on the opposite comparator role. A
    // comparator that only nulls a future right-side value via the intended
    // `<=` path (and not via a mutated always-true / `||`-swapped / `>`
    // condition) is needed to keep the past candidate ranked first.
    const evaluationNow = new Date("2026-08-18T12:00:00.000Z");
    const futureId = RIGHT_FUTURE_ID;
    const pastId = LEFT_PAST_ID;
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        candidateRow(
          futureId,
          "acme/repo-future-r",
          "branch-future-r",
          new Date("2026-08-25T00:00:00.000Z"),
          0
        ),
        candidateRow(
          pastId,
          "acme/repo-past-r",
          "branch-past-r",
          new Date("2026-08-01T00:00:00.000Z"),
          0
        ),
      ]);

    const ids = await getBranchCandidateIds(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0, evaluationNow },
      [futureId, pastId]
    );

    expect(ids).toEqual([pastId, futureId]);
  });

  it("keeps a pre-epoch (negative-timestamp) right candidate ranked ahead of a genuinely no-activity left candidate", async () => {
    // Mirror of the earlier pre-epoch case with the roles swapped: the
    // no-activity candidate is on the LEFT this time, which is what exercises
    // the leftActivity-null early return (`if (leftActivity === null)`)
    // rather than the rightActivity-null one. The negative epoch timestamp is
    // still required so the fallthrough arithmetic (if that early return were
    // skipped) produces the opposite sign from a normal, post-1970 date.
    const evaluationNow = new Date("2026-08-18T12:00:00.000Z");
    const preEpochId = PRE_EPOCH_RIGHT_2_ID;
    const noActivityId = NO_ACTIVITY_LEFT_2_ID;
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        candidateRow(
          preEpochId,
          "acme/repo-y2",
          "branch-y2",
          new Date(-100_000),
          0
        ),
        candidateRow(noActivityId, "acme/repo-x2", "branch-x2", null, 0),
      ]);

    const ids = await getBranchCandidateIds(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0, evaluationNow },
      [preEpochId, noActivityId]
    );

    expect(ids).toEqual([preEpochId, noActivityId]);
  });

  it("uses the branch tie-break rather than skipping straight to id when repositorySortKey is equal", async () => {
    // Same repository (comparison is 0, falls through), branch DECISIVE, and
    // the id ordering runs the OPPOSITE direction from the branch ordering.
    // A comparator that drops the branch comparison entirely (jumping from
    // repository straight to id) would land on id's direction instead and
    // get this backwards.
    const muId = BRANCH_DECISIVE_MU_ID;
    const nuId = BRANCH_DECISIVE_NU_ID;
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        candidateRow(muId, "shared-repo3", "branch-z3", null, 0),
        candidateRow(nuId, "shared-repo3", "branch-a3", null, 0),
      ]);

    const ids = await getBranchCandidateIds(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0 },
      [muId, nuId]
    );

    expect(ids).toEqual([nuId, muId]);
  });
});

describe("getAllBranchCandidateSnapshots", () => {
  it("carries the last full page's within-window activity forward as the next keyset cursor", async () => {
    const fullCorpusBatchSize = 5000;
    const evaluationNow = new Date("2026-08-18T12:00:00.000Z");
    // Within the evaluation window (<= evaluationNow), unlike the sibling
    // suite's full-corpus test, whose every row carries null activity and so
    // never exercises the cursor's within-window branch.
    const lastRowOccurredAt = new Date("2026-08-17T00:00:00.000Z");
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: fullCorpusBatchSize }, (_, index) =>
          candidateRow(
            candidateId(index),
            "acme/repo",
            `branch-${index.toString().padStart(4, "0")}`,
            index === fullCorpusBatchSize - 1 ? lastRowOccurredAt : null,
            0
          )
        )
      )
      .mockResolvedValueOnce([]);

    await getAllBranchCandidateSnapshots(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0 },
      undefined,
      evaluationNow
    );

    expect(queryRaw).toHaveBeenCalledTimes(2);
    const secondCallValues = collectSqlValues(queryRaw.mock.calls[1]?.[0]);
    expect(secondCallValues).toContainEqual(lastRowOccurredAt);
  });

  it("does not carry a future-dated last row forward as an in-window keyset cursor", async () => {
    // The last row's activity is AFTER evaluationNow. `<=` correctly treats
    // this as no-window activity (cursor stays null); a comparator that
    // forces the cursor's `occurredAt && occurredAt <= evaluationNow` check
    // to always take the truthy branch (or that swaps `&&` for `||`, which
    // short-circuits true the moment occurredAt is merely non-null) would
    // wrongly carry this future date into the next page's keyset.
    const fullCorpusBatchSize = 5000;
    const evaluationNow = new Date("2026-08-18T12:00:00.000Z");
    const futureRowOccurredAt = new Date("2026-08-25T00:00:00.000Z");
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: fullCorpusBatchSize }, (_, index) =>
          candidateRow(
            candidateId(index),
            "acme/repo",
            `branch-${index.toString().padStart(4, "0")}`,
            index === fullCorpusBatchSize - 1 ? futureRowOccurredAt : null,
            0
          )
        )
      )
      .mockResolvedValueOnce([]);

    await getAllBranchCandidateSnapshots(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0 },
      undefined,
      evaluationNow
    );

    expect(queryRaw).toHaveBeenCalledTimes(2);
    const secondCallValues = collectSqlValues(queryRaw.mock.calls[1]?.[0]);
    expect(secondCallValues).not.toContainEqual(futureRowOccurredAt);
  });

  it("carries a last row whose activity occurs exactly at evaluationNow forward as an in-window keyset cursor", async () => {
    // occurredAt === evaluationNow exactly: only `<=` (not a strict `<`)
    // admits it as in-window and carries the real date into the cursor
    // rather than nulling it.
    const fullCorpusBatchSize = 5000;
    const evaluationNow = new Date("2026-08-18T12:00:00.000Z");
    const exactlyNowOccurredAt = new Date(evaluationNow.getTime());
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: fullCorpusBatchSize }, (_, index) =>
          candidateRow(
            candidateId(index),
            "acme/repo",
            `branch-${index.toString().padStart(4, "0")}`,
            index === fullCorpusBatchSize - 1 ? exactlyNowOccurredAt : null,
            0
          )
        )
      )
      .mockResolvedValueOnce([]);

    await getAllBranchCandidateSnapshots(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      { limit: 50, offset: 0 },
      undefined,
      evaluationNow
    );

    expect(queryRaw).toHaveBeenCalledTimes(2);
    const secondCallValues = collectSqlValues(queryRaw.mock.calls[1]?.[0]);
    expect(secondCallValues).toContainEqual(exactlyNowOccurredAt);
  });
});

describe("getBranchCandidatePage repository filters", () => {
  it("merges both the `repository` and `repo` filter keys into one IN-list, not just one of them", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);

    await getBranchCandidatePage(
      { $queryRaw: queryRaw },
      "11111111-1111-4111-8111-111111111111",
      {
        limit: 50,
        offset: 0,
        repository: ["acme/repo-one"],
        repo: ["acme/repo-two"],
      },
      50,
      0
    );

    const sql = renderSql(queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain("acme/repo-one");
    expect(sql).toContain("acme/repo-two");
  });
});

// Fixture ids below are fixed, valid `::uuid`-castable literals rather than
// descriptive text: `branchCandidateWhereClause` binds every requested id as
// `${branchId}::uuid` (branch-candidate-read.ts), so a non-UUID id would be
// rejected by Postgres before the comparator under test ever runs, and a
// fixture built from one would only be shape-valid against this file's mock,
// never against the production query.
const PAST_OLDER_ID = "00000000-0000-4000-8000-900000000001";
const PAST_NEWER_ID = "00000000-0000-4000-8000-900000000002";
const FUTURE_DATED_ID = "00000000-0000-4000-8000-900000000003";
const TIE_ONE_ID = "00000000-0000-4000-8000-900000000004";
const TIE_TWO_ID = "00000000-0000-4000-8000-900000000005";
const NO_ACTIVITY_ID = "00000000-0000-4000-8000-900000000006";
const PAST_ACTIVITY_ID = "00000000-0000-4000-8000-900000000007";
const RECENT_ACTIVITY_ID = "00000000-0000-4000-8000-900000000008";
const OLDER_ACTIVITY_ID = "00000000-0000-4000-8000-900000000009";
const NO_ACTIVITY_VS_PRE_EPOCH_ID = "00000000-0000-4000-8000-900000000010";
const PRE_EPOCH_ACTIVITY_ID = "00000000-0000-4000-8000-900000000011";
const LEFT_PAST_ID = "00000000-0000-4000-8000-900000000012";
const LEFT_FUTURE_ID = "00000000-0000-4000-8000-900000000013";
const RIGHT_NO_ACTIVITY_D_ID = "00000000-0000-4000-8000-900000000014";
const LEFT_EXACTLY_NOW_D_ID = "00000000-0000-4000-8000-900000000015";
const RIGHT_EXACTLY_NOW_E_ID = "00000000-0000-4000-8000-900000000016";
const LEFT_NO_ACTIVITY_E_ID = "00000000-0000-4000-8000-900000000017";
const REPO_DECISIVE_ALPHA_ID = "00000000-0000-4000-8000-900000000018";
const REPO_DECISIVE_BETA_ID = "00000000-0000-4000-8000-900000000019";
const BRANCH_DECISIVE_GAMMA_ID = "00000000-0000-4000-8000-900000000020";
const BRANCH_DECISIVE_DELTA_ID = "00000000-0000-4000-8000-900000000021";
// Numeric suffix order is load-bearing: TIEBREAK_EPSILON_ID must sort
// lexicographically after TIEBREAK_ZETA_ID for the id-tie-break test above to
// distinguish a real `localeCompare` from stable-sort no-op.
const TIEBREAK_ZETA_ID = "00000000-0000-4000-8000-900000000022";
const TIEBREAK_EPSILON_ID = "00000000-0000-4000-8000-900000000023";
const RIGHT_FUTURE_ID = "00000000-0000-4000-8000-900000000024";
const PRE_EPOCH_RIGHT_2_ID = "00000000-0000-4000-8000-900000000025";
const NO_ACTIVITY_LEFT_2_ID = "00000000-0000-4000-8000-900000000026";
const BRANCH_DECISIVE_MU_ID = "00000000-0000-4000-8000-900000000027";
const BRANCH_DECISIVE_NU_ID = "00000000-0000-4000-8000-900000000028";

function candidateRow(
  id: string,
  repositorySortKey: string,
  branchSortKey: string,
  occurredAt: Date | null,
  count: number,
  retainedUnavailableCount = 0
) {
  return {
    id,
    repositorySortKey,
    branchSortKey,
    atomVersion: occurredAt ? BranchActivityAtomVersion.V1 : null,
    atomSource: occurredAt ? BranchActivitySource.GitHead : null,
    atomSourceEventId: occurredAt ? `event-${id}` : null,
    atomOccurredAt: occurredAt,
    atomActivityKind: null,
    atomAttributionKind: occurredAt
      ? BranchActivityAttributionKind.Branch
      : null,
    atomPullRequestDetailId: null,
    atomCompleteness: occurredAt
      ? BranchActivityEvidenceCompleteness.Complete
      : null,
    atomCreatedAt: occurredAt,
    count: BigInt(count),
    retainedUnavailableCount: BigInt(retainedUnavailableCount),
  };
}

function candidateId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
