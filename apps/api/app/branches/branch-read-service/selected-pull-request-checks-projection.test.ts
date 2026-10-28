import {
  BranchViewCheckKind,
  BranchViewChecksProviderState,
} from "@repo/api/src/types/branch-check-projection";
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import { StatusCheckRollupFailureReason } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import { BRANCH_SELECTED_PULL_REQUEST_CHECK_ROW_LIMIT } from "../branch-read-selects";
import {
  type BranchStoredChecksProjectionInput,
  projectSelectedPullRequestChecks,
} from "./selected-pull-request-checks-projection";

const PR_HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const MEASURED_AT = new Date("2026-08-20T00:00:00.000Z");

describe("projectSelectedPullRequestChecks (ISS-8241 Half A)", () => {
  it("serves the rows measured at this PR's head, and a rollup counted from them", () => {
    const projected = projectSelectedPullRequestChecks(
      storedChecks({ checksDetailHeadSha: PR_HEAD }),
      PR_HEAD
    );

    expect(projected.checksStatus).toBe(ChecksStatus.Failing);
    expect(projected.checksTotal).toBe(2);
    expect(projected.checks?.providerState).toBe(
      BranchViewChecksProviderState.Available
    );
    expect(projected.checks?.items.map((item) => item.name)).toEqual(["ci"]);
  });

  it("withholds the branch's rollup once it belongs to another revision", () => {
    // The exact defect ISS-8241 names: the branch moved on, so the rollup it
    // stores is some other commit's and is NOT this pull request's answer.
    const projected = projectSelectedPullRequestChecks(
      storedChecks({ checksDetailHeadSha: OTHER_HEAD }),
      PR_HEAD
    );

    expect(projected).toEqual({
      checksStatus: null,
      checksPassed: null,
      checksTotal: null,
    });
  });

  it("withholds it when no producer has measured any head", () => {
    const projected = projectSelectedPullRequestChecks(
      storedChecks({ checksDetailHeadSha: null, checksDetailUpdatedAt: null }),
      PR_HEAD
    );

    expect(projected.checks).toBeUndefined();
    expect(projected.checksStatus).toBeNull();
  });

  it("withholds it when the pull request itself has no recorded head", () => {
    const projected = projectSelectedPullRequestChecks(
      storedChecks({ checksDetailHeadSha: PR_HEAD }),
      null
    );

    expect(projected.checks).toBeUndefined();
    expect(projected.checksStatus).toBeNull();
  });

  it("matches a head recorded in a different case rather than reading it as another revision", () => {
    const projected = projectSelectedPullRequestChecks(
      storedChecks({ checksDetailHeadSha: PR_HEAD.toUpperCase() }),
      PR_HEAD
    );

    expect(projected.checksStatus).toBe(ChecksStatus.Failing);
  });

  it("keeps a FAILED provider read from carrying a rollup no producer wrote for this head", () => {
    // `checks_status` is untouched on the failure path, so it still describes
    // whatever the previous head concluded. The read is reported; the rollup is
    // not, because presenting it would date-stamp a stale answer to this head.
    const projected = projectSelectedPullRequestChecks(
      storedChecks({
        checksDetailHeadSha: PR_HEAD,
        checksDetailProviderState:
          BranchViewChecksProviderState.ProviderUnavailable,
        checksDetailUnavailableReason:
          StatusCheckRollupFailureReason.RateLimited,
      }),
      PR_HEAD
    );

    expect(projected.checksStatus).toBeNull();
    expect(projected.checksPassed).toBeNull();
    expect(projected.checksTotal).toBeNull();
    expect(projected.checks?.providerState).toBe(
      BranchViewChecksProviderState.ProviderUnavailable
    );
    expect(projected.checks?.unavailableReason).toBe(
      StatusCheckRollupFailureReason.RateLimited
    );
    // The counts inside the projection are withheld too. `checksDetailTotalCount`
    // is still the last SUCCESSFUL read's, so a consumer reading `checks` rather
    // than the scalar must not be handed that population as this head's.
    expect(projected.checks?.totalCount).toBe(0);
    expect(projected.checks?.truncated).toBe(false);
  });

  it("reports a measured EMPTY population as its own state, not as an unmeasured head", () => {
    const projected = projectSelectedPullRequestChecks(
      storedChecks({
        checksDetailHeadSha: PR_HEAD,
        checksDetailProviderState: BranchViewChecksProviderState.NoChecks,
        checksDetailTotalCount: 0,
        statusChecks: [],
      }),
      PR_HEAD
    );

    expect(projected.checks?.providerState).toBe(
      BranchViewChecksProviderState.NoChecks
    );
    expect(projected.checksTotal).toBe(0);
    // Served beside that total, a zero numerator is `0/0 passing` on the screen,
    // which is the word this population's own verdict reports replaced by a
    // tally claiming everything in it passed.
    expect(projected.checksStatus).toBe(ChecksStatus.Unknown);
    expect(projected.checksPassed).toBeNull();
  });

  it("does not count a stale-head row toward the cap or report a truncation it did not cause", () => {
    // The bounded read is not head-scoped, so a leftover row can arrive inside
    // the window. Counted before the head filter it fakes a truncation.
    const projected = projectSelectedPullRequestChecks(
      storedChecks({
        checksDetailHeadSha: PR_HEAD,
        statusChecks: [
          ...Array.from(
            { length: BRANCH_SELECTED_PULL_REQUEST_CHECK_ROW_LIMIT },
            (_, index) => statusCheckRow(index)
          ),
          statusCheckRow(999, OTHER_HEAD),
        ],
      }),
      PR_HEAD
    );

    expect(projected.checks?.truncated).toBe(false);
    expect(projected.checks?.items).toHaveLength(
      BRANCH_SELECTED_PULL_REQUEST_CHECK_ROW_LIMIT
    );
  });

  it("reports an over-limit row set as truncated instead of quietly shortening it", () => {
    const rows = Array.from(
      { length: BRANCH_SELECTED_PULL_REQUEST_CHECK_ROW_LIMIT + 1 },
      (_, index) => statusCheckRow(index)
    );

    const projected = projectSelectedPullRequestChecks(
      storedChecks({
        checksDetailHeadSha: PR_HEAD,
        checksDetailTotalCount: rows.length,
        statusChecks: rows,
      }),
      PR_HEAD
    );

    expect(projected.checks?.truncated).toBe(true);
    expect(projected.checks?.items).toHaveLength(
      BRANCH_SELECTED_PULL_REQUEST_CHECK_ROW_LIMIT
    );
  });

  it("reports a stale-head-crowded window as truncated rather than as a short complete list", () => {
    // The read is bounded but NOT head-scoped, and both heads' rows carry the
    // same `position` range, so a stale head can spend the cap and leave this
    // head's rows short WITHOUT the surviving set ever reaching the limit. The
    // cap alone cannot see that, and calling it complete states a population
    // this pull request does not have.
    const crowded = [
      ...Array.from({ length: 160 }, (_, index) =>
        statusCheckRow(index, OTHER_HEAD)
      ),
      ...Array.from({ length: 41 }, (_, index) => statusCheckRow(index)),
    ];

    const projected = projectSelectedPullRequestChecks(
      storedChecks({
        checksDetailHeadSha: PR_HEAD,
        checksDetailTotalCount: 120,
        statusChecks: crowded,
      }),
      PR_HEAD
    );

    expect(projected.checks?.items).toHaveLength(41);
    expect(projected.checks?.totalCount).toBe(120);
    expect(projected.checks?.truncated).toBe(true);
  });

  it("does not call an unsaturated window truncated just because the producer stored fewer rows than it counted", () => {
    // The other side of the same predicate: nothing was crowded out, so the
    // short set is the producer's own truncation and is reported by
    // `checksDetailTruncated`, not invented here.
    const projected = projectSelectedPullRequestChecks(
      storedChecks({
        checksDetailHeadSha: PR_HEAD,
        checksDetailTotalCount: 12,
        statusChecks: [statusCheckRow(0), statusCheckRow(1)],
      }),
      PR_HEAD
    );

    expect(projected.checks?.items).toHaveLength(2);
    expect(projected.checks?.truncated).toBe(false);
  });

  it("never counts a row measured at another head toward this PR's checks", () => {
    const projected = projectSelectedPullRequestChecks(
      storedChecks({
        checksDetailHeadSha: PR_HEAD,
        statusChecks: [statusCheckRow(0), statusCheckRow(1, OTHER_HEAD)],
      }),
      PR_HEAD
    );

    expect(projected.checks?.items.map((item) => item.id)).toEqual(["check-0"]);
  });

  it("states a passed count over the population it serves", () => {
    const projected = projectSelectedPullRequestChecks(
      storedChecks({
        checksDetailTotalCount: 1,
        statusChecks: [passingRow(0)],
      }),
      PR_HEAD
    );

    expect(projected.checksPassed).toBe(1);
    expect(projected.checksStatus).toBe(ChecksStatus.Passing);
    expect(projected.checks?.items).toHaveLength(1);
  });

  it("carries the producer's own truncation through even when nothing overflowed here", () => {
    // `checksDetailTruncated || overflowed`: the producer capped the population
    // upstream, and this projection saw a window that never reached its limit.
    // Reporting only its OWN overflow would call the short list complete.
    const projected = projectSelectedPullRequestChecks(
      storedChecks({
        checksDetailTruncated: true,
        checksDetailTotalCount: 1,
        statusChecks: [statusCheckRow(0)],
      }),
      PR_HEAD
    );

    expect(projected.checks?.truncated).toBe(true);
  });

  describe("the rollup is counted from the rows, never read from checks_status", () => {
    // `checks_status` is NOT protected by the head-sha gate: a `synchronize`
    // redelivery stamps it PENDING at an unchanged head and the backfill lane
    // sets it from the PR-list rollup, neither touching `checks_detail_head_sha`.
    // The input type no longer carries the column at all, so these pin what the
    // rows alone are allowed to say.
    it("calls a complete, all-passing population passing", () => {
      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTotalCount: 2,
          statusChecks: [passingRow(0), passingRow(1)],
        }),
        PR_HEAD
      );

      expect(projected.checksStatus).toBe(ChecksStatus.Passing);
    });

    it("lets one failure outrank every passing row beside it", () => {
      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTotalCount: 2,
          statusChecks: [passingRow(0), statusCheckRow(1)],
        }),
        PR_HEAD
      );

      expect(projected.checksStatus).toBe(ChecksStatus.Failing);
    });

    it("calls a population with an unfinished run pending, not passing", () => {
      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTotalCount: 2,
          statusChecks: [
            passingRow(0),
            { ...passingRow(1), status: "IN_PROGRESS", conclusion: null },
          ],
        }),
        PR_HEAD
      );

      expect(projected.checksStatus).toBe(ChecksStatus.Pending);
    });

    it("refuses to call a TRUNCATED all-passing population passing", () => {
      // The rows in hand all passed; the ones the cap dropped are unknown, and a
      // green headline over them would be a claim about checks nobody fetched.
      const rows = Array.from(
        { length: BRANCH_SELECTED_PULL_REQUEST_CHECK_ROW_LIMIT + 1 },
        (_, index) => passingRow(index)
      );

      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTotalCount: rows.length,
          statusChecks: rows,
        }),
        PR_HEAD
      );

      expect(projected.checks?.truncated).toBe(true);
      expect(projected.checksStatus).toBe(ChecksStatus.Unknown);
    });

    it("refuses to call a PRODUCER-truncated population passing even with every counted row in hand", () => {
      // Isolates the `!truncated` conjunct. The sibling case above builds 201
      // rows against a `totalCount` of 201, so after the slice the
      // `items.length === totalCount` clause ALONE already forces UNKNOWN and
      // the truncation flag is never consulted — a test named for truncation
      // satisfied by a different clause. Here the counts agree exactly, so the
      // flag is the only thing standing between this and a green headline over
      // a population the producer already told us was incomplete.
      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTruncated: true,
          checksDetailTotalCount: 1,
          statusChecks: [passingRow(0)],
        }),
        PR_HEAD
      );

      expect(projected.checks?.items).toHaveLength(1);
      expect(projected.checks?.totalCount).toBe(1);
      expect(projected.checks?.truncated).toBe(true);
      expect(projected.checksStatus).toBe(ChecksStatus.Unknown);
    });

    // ISS-8629: the Branch detail render withholds its passing TONE on this same
    // one-of-nine population, through the same `isWholeMeasuredPopulation` call —
    // pinned in packages/app/branches/components/detail/__tests__/branch-pr-measured-checks.test.tsx.
    // The two layers once disagreed here: UNKNOWN on the wire, green on screen.
    it("refuses to call a population passing when it stores fewer rows than it counted", () => {
      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTotalCount: 9,
          statusChecks: [passingRow(0)],
        }),
        PR_HEAD
      );

      expect(projected.checks?.truncated).toBe(false);
      expect(projected.checksStatus).toBe(ChecksStatus.Unknown);
    });

    it("refuses to bucket an outcome word it does not recognize", () => {
      // The whole point of the unknown-word rule: a provider word this product
      // cannot read must not be counted as a pass on the way to a green headline.
      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTotalCount: 2,
          statusChecks: [
            passingRow(0),
            { ...passingRow(1), conclusion: "QUARANTINED" },
          ],
        }),
        PR_HEAD
      );

      expect(projected.checksStatus).toBe(ChecksStatus.Unknown);
    });

    it("does not call a population of purely inconclusive rows passing", () => {
      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTotalCount: 1,
          statusChecks: [{ ...passingRow(0), conclusion: "SKIPPED" }],
        }),
        PR_HEAD
      );

      expect(projected.checksStatus).toBe(ChecksStatus.Unknown);
    });

    it("does not let an inconclusive row spoil an otherwise complete pass", () => {
      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTotalCount: 2,
          statusChecks: [
            passingRow(0),
            { ...passingRow(1), conclusion: "SKIPPED" },
          ],
        }),
        PR_HEAD
      );

      expect(projected.checksStatus).toBe(ChecksStatus.Passing);
    });
  });

  describe("the passed count is counted from the same classified rows", () => {
    it("counts a row that ran and reached no verdict of its own", () => {
      // Operator ruling 2026-10-12 (ISS-12203). The verdict beside this count
      // already calls the population passing, so a numerator short of the total
      // would have the screen contradict itself over one skipped row.
      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTotalCount: 2,
          statusChecks: [
            passingRow(0),
            { ...passingRow(1), conclusion: "SKIPPED" },
          ],
        }),
        PR_HEAD
      );

      expect(projected.checksStatus).toBe(ChecksStatus.Passing);
      expect(projected.checksPassed).toBe(2);
      expect(projected.checksTotal).toBe(2);
    });

    it("does not count a failing row", () => {
      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTotalCount: 2,
          statusChecks: [passingRow(0), statusCheckRow(1)],
        }),
        PR_HEAD
      );

      expect(projected.checksStatus).toBe(ChecksStatus.Failing);
      expect(projected.checksPassed).toBe(1);
    });

    it("does not count a run that has not finished", () => {
      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTotalCount: 2,
          statusChecks: [
            passingRow(0),
            { ...passingRow(1), status: "IN_PROGRESS", conclusion: null },
          ],
        }),
        PR_HEAD
      );

      expect(projected.checksStatus).toBe(ChecksStatus.Pending);
      expect(projected.checksPassed).toBe(1);
    });

    it("does not count an outcome word it cannot read", () => {
      // The unknown-word rule reaches the count as well as the verdict: a word
      // this product cannot read is not evidence of a pass, so it is not a unit
      // of one either.
      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTotalCount: 2,
          statusChecks: [
            passingRow(0),
            { ...passingRow(1), conclusion: "QUARANTINED" },
          ],
        }),
        PR_HEAD
      );

      expect(projected.checksStatus).toBe(ChecksStatus.Unknown);
      expect(projected.checksPassed).toBe(1);
    });

    it("withholds the count when the cap dropped rows it never saw", () => {
      const rows = Array.from(
        { length: BRANCH_SELECTED_PULL_REQUEST_CHECK_ROW_LIMIT + 1 },
        (_, index) => passingRow(index)
      );

      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTotalCount: rows.length,
          statusChecks: rows,
        }),
        PR_HEAD
      );

      expect(projected.checks?.truncated).toBe(true);
      expect(projected.checksPassed).toBeNull();
    });

    it("withholds the count on a PRODUCER-truncated population with every counted row in hand", () => {
      // Isolates the `!truncated` conjunct for the count, as its rollup sibling
      // does for the verdict: the counts agree exactly, so only the flag stands
      // between this and a tally over a population the producer already called
      // incomplete.
      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTruncated: true,
          checksDetailTotalCount: 1,
          statusChecks: [passingRow(0)],
        }),
        PR_HEAD
      );

      expect(projected.checks?.items).toHaveLength(1);
      expect(projected.checks?.totalCount).toBe(1);
      expect(projected.checksPassed).toBeNull();
    });

    it("withholds the count when it stores fewer rows than it counted", () => {
      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTotalCount: 9,
          statusChecks: [passingRow(0)],
        }),
        PR_HEAD
      );

      expect(projected.checks?.truncated).toBe(false);
      expect(projected.checksPassed).toBeNull();
    });

    it("withholds the count over rows that all SKIPPED", () => {
      // The abstain rule counts a skipped row toward a pass the verdict already
      // reports. With nothing else in the population there is no such verdict,
      // so `N/N passing` would stand in for the `Unknown` this fold returns.
      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTotalCount: 2,
          statusChecks: [
            { ...passingRow(0), conclusion: "SKIPPED" },
            { ...passingRow(1), conclusion: "SKIPPED" },
          ],
        }),
        PR_HEAD
      );

      expect(projected.checksStatus).toBe(ChecksStatus.Unknown);
      expect(projected.checksTotal).toBe(2);
      expect(projected.checksPassed).toBeNull();
    });

    it("withholds the count over rows that all CANCELLED", () => {
      const projected = projectSelectedPullRequestChecks(
        storedChecks({
          checksDetailTotalCount: 2,
          statusChecks: [
            { ...passingRow(0), conclusion: "CANCELLED" },
            { ...passingRow(1), conclusion: "CANCELLED" },
          ],
        }),
        PR_HEAD
      );

      expect(projected.checksStatus).toBe(ChecksStatus.Unknown);
      expect(projected.checksTotal).toBe(2);
      expect(projected.checksPassed).toBeNull();
    });
  });
});

function passingRow(index: number, headSha = PR_HEAD) {
  return {
    ...statusCheckRow(index, headSha),
    status: "COMPLETED",
    conclusion: "SUCCESS",
  };
}

function statusCheckRow(index: number, headSha = PR_HEAD) {
  return {
    providerKey: `check-${index}`,
    headSha,
    kind: BranchViewCheckKind.CheckRun,
    name: `ci-${index}`,
    status: "completed",
    conclusion: "failure",
    targetUrl: null,
    position: index,
  };
}

function storedChecks(
  overrides: Partial<BranchStoredChecksProjectionInput> = {}
): BranchStoredChecksProjectionInput {
  return {
    checksDetailHeadSha: PR_HEAD,
    checksDetailTotalCount: 2,
    checksDetailTruncated: false,
    checksDetailProviderState: BranchViewChecksProviderState.Available,
    checksDetailUnavailableReason: null,
    checksDetailUpdatedAt: MEASURED_AT,
    statusChecks: [
      {
        providerKey: "check-0",
        headSha: PR_HEAD,
        kind: BranchViewCheckKind.CheckRun,
        name: "ci",
        status: "completed",
        conclusion: "failure",
        targetUrl: null,
        position: 0,
      },
    ],
    ...overrides,
  };
}
