import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BranchCanonicalDivergenceEvent,
  type BranchCanonicalPullRequestDetail,
  BranchCanonicalPullRequestSource,
  branchCandidatePullRequests,
  branchHasAnyPullRequestWhere,
  branchHasNoPullRequestWhere,
  branchOwnsPullRequestDetail,
  drainBranchCanonicalDivergenceEmissions,
  reportBranchCanonicalPointerDivergence,
  reportBranchCanonicalPullRequestAmbiguity,
  resetBranchCanonicalDivergenceThrottle,
  resolveBranchCanonicalPullRequestId,
  tombstonedRepositoryWhere,
} from "./branch-canonical-pull-request";
import { isEmptyPullRequestStub } from "./pull-request-current-promotion";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@repo/observability/log", () => ({
  log: { warn: logWarn, info: vi.fn(), error: vi.fn() },
}));

type Detail = BranchCanonicalPullRequestDetail;

// A LIVE, FACT-CARRYING, provider-authoritative row. Every case below states
// only the terms it varies, so a default that drifts cannot quietly satisfy an
// assertion the case never meant to make.
function detail(overrides: Partial<Detail> = {}): Detail {
  return {
    id: "pr-1",
    fetchMechanism: "webhook",
    githubId: "gh-1",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    prState: "OPEN",
    isDraft: false,
    title: "Add a thing",
    reviewDecision: null,
    githubCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
    closedAt: null,
    mergedAt: null,
    ...overrides,
  };
}

/** Live, carries real synced facts, NOT provider-authoritative (desktop-written). */
function desktopLiveDetail(overrides: Partial<Detail> = {}): Detail {
  return detail({
    id: "desktop-live",
    fetchMechanism: "desktop_cli",
    githubId: null,
    ...overrides,
  });
}

/** Provider-authoritative, but MERGED — obsolete while a live candidate exists. */
function providerMergedDetail(overrides: Partial<Detail> = {}): Detail {
  return detail({
    id: "provider-merged",
    prState: "MERGED",
    mergedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  });
}

/** Provider-authoritative by githubId, but carrying no observed fact at all. */
function providerFactlessStub(overrides: Partial<Detail> = {}): Detail {
  return detail({
    id: "provider-stub",
    githubId: "gh-stub",
    additions: null,
    deletions: null,
    changedFiles: null,
    title: null,
    reviewDecision: null,
    isDraft: false,
    prState: "OPEN",
    githubCreatedAt: null,
    closedAt: null,
    mergedAt: null,
    ...overrides,
  });
}

const STUB = detail({
  id: "stub-1",
  fetchMechanism: null,
  githubId: null,
  additions: null,
  deletions: null,
  changedFiles: null,
});

beforeEach(() => {
  logWarn.mockClear();
  // ISS-8902: the emission budget is module-level state. Clearing only the log
  // spy would leave a key primed by the previous case, so a suppression case
  // would pass in file order and fail run alone (and vice versa).
  resetBranchCanonicalDivergenceThrottle();
});

describe("resolveBranchCanonicalPullRequestId", () => {
  it("resolves a valid pointer, flagging divergence when the owned set disagrees", () => {
    const resolved = resolveBranchCanonicalPullRequestId({
      currentPullRequestDetailId: "pr-1",
      pullRequestDetails: [detail(), desktopLiveDetail({ id: "pr-2" })],
      ownedSetSelectedId: "pr-2",
    });
    expect(resolved).toEqual({
      id: "pr-1",
      pointerId: "pr-1",
      source: BranchCanonicalPullRequestSource.Pointer,
      pointerDivergedFromOwnedSet: true,
      ambiguous: false,
    });
  });

  it("does not flag divergence when pointer and owned set agree", () => {
    const resolved = resolveBranchCanonicalPullRequestId({
      currentPullRequestDetailId: "pr-1",
      pullRequestDetails: [detail()],
      ownedSetSelectedId: "pr-1",
    });
    expect(resolved.pointerDivergedFromOwnedSet).toBe(false);
    expect(resolved.source).toBe(BranchCanonicalPullRequestSource.Pointer);
  });

  it("falls back to the owned-set selection over an empty-stub pointer", () => {
    const resolved = resolveBranchCanonicalPullRequestId({
      currentPullRequestDetailId: "stub-1",
      pullRequestDetails: [STUB, detail({ id: "pr-2" })],
      ownedSetSelectedId: "pr-2",
    });
    expect(resolved).toEqual({
      id: "pr-2",
      pointerId: null,
      source: BranchCanonicalPullRequestSource.OwnedSet,
      pointerDivergedFromOwnedSet: false,
      ambiguous: false,
    });
  });

  it("falls back when the pointer names a row the branch does not own", () => {
    const resolved = resolveBranchCanonicalPullRequestId({
      currentPullRequestDetailId: "foreign-pr",
      pullRequestDetails: [detail({ id: "pr-2" })],
      ownedSetSelectedId: "pr-2",
    });
    expect(resolved.id).toBe("pr-2");
    expect(resolved.source).toBe(BranchCanonicalPullRequestSource.OwnedSet);
  });

  // The operator ruling of 2026-09-01, case by case. Each expectation is pinned
  // to a literal row id, never re-derived from the arbitration under test.
  it("keeps a live fact-carrying pointer over an older terminal provider row", () => {
    const resolved = resolveBranchCanonicalPullRequestId({
      currentPullRequestDetailId: "desktop-live",
      pullRequestDetails: [desktopLiveDetail(), providerMergedDetail()],
      ownedSetSelectedId: "provider-merged",
    });
    expect(resolved.id).toBe("desktop-live");
    expect(resolved.source).toBe(BranchCanonicalPullRequestSource.Pointer);
    expect(resolved.ambiguous).toBe(false);
    expect(resolved.pointerDivergedFromOwnedSet).toBe(true);
  });

  it("keeps a fact-carrying pointer over a factless provider stub", () => {
    const resolved = resolveBranchCanonicalPullRequestId({
      currentPullRequestDetailId: "desktop-live",
      pullRequestDetails: [desktopLiveDetail(), providerFactlessStub()],
      ownedSetSelectedId: "provider-stub",
    });
    expect(resolved.id).toBe("desktop-live");
    expect(resolved.source).toBe(BranchCanonicalPullRequestSource.Pointer);
    expect(resolved.ambiguous).toBe(false);
  });

  // The ruling's own sentence, in the direction authority would otherwise win:
  // "a live, fact-carrying PR outranks a FACTLESS PROVIDER STUB". Authority on
  // the losing side is what makes this the case the ruling had to settle.
  it("drops a factless provider-authoritative pointer for a live fact-carrying row", () => {
    const resolved = resolveBranchCanonicalPullRequestId({
      currentPullRequestDetailId: "provider-stub",
      pullRequestDetails: [providerFactlessStub(), desktopLiveDetail()],
      ownedSetSelectedId: "desktop-live",
    });
    expect(resolved.id).toBe("desktop-live");
    expect(resolved.source).toBe(BranchCanonicalPullRequestSource.OwnedSet);
    expect(resolved.ambiguous).toBe(false);
    expect(resolved.pointerId).toBe("provider-stub");
  });

  it("gives a live provider row the tie-break over an equally suitable pointer", () => {
    const resolved = resolveBranchCanonicalPullRequestId({
      currentPullRequestDetailId: "desktop-live",
      pullRequestDetails: [
        desktopLiveDetail(),
        detail({ id: "provider-live" }),
      ],
      ownedSetSelectedId: "provider-live",
    });
    expect(resolved.id).toBe("provider-live");
    expect(resolved.source).toBe(BranchCanonicalPullRequestSource.OwnedSet);
    expect(resolved.pointerId).toBe("desktop-live");
    expect(resolved.ambiguous).toBe(false);
  });

  it("promotes a live owned-set row over a terminal pointer of equal authority", () => {
    const resolved = resolveBranchCanonicalPullRequestId({
      currentPullRequestDetailId: "provider-merged",
      pullRequestDetails: [
        providerMergedDetail(),
        detail({ id: "provider-live" }),
      ],
      ownedSetSelectedId: "provider-live",
    });
    expect(resolved.id).toBe("provider-live");
    expect(resolved.source).toBe(BranchCanonicalPullRequestSource.OwnedSet);
  });

  it("preserves the projection and flags ambiguity when neither term breaks the tie", () => {
    const resolved = resolveBranchCanonicalPullRequestId({
      currentPullRequestDetailId: "provider-live-a",
      pullRequestDetails: [
        detail({ id: "provider-live-a" }),
        detail({ id: "provider-live-b", githubId: "gh-2" }),
      ],
      ownedSetSelectedId: "provider-live-b",
    });
    expect(resolved.id).toBe("provider-live-a");
    expect(resolved.source).toBe(BranchCanonicalPullRequestSource.Pointer);
    expect(resolved.ambiguous).toBe(true);
    expect(resolved.pointerId).toBe("provider-live-a");
  });

  it("flags ambiguity when two equally suitable rows are both unauthoritative", () => {
    const resolved = resolveBranchCanonicalPullRequestId({
      currentPullRequestDetailId: "desktop-live",
      pullRequestDetails: [
        desktopLiveDetail(),
        desktopLiveDetail({ id: "desktop-live-2" }),
      ],
      ownedSetSelectedId: "desktop-live-2",
    });
    expect(resolved.id).toBe("desktop-live");
    expect(resolved.ambiguous).toBe(true);
  });

  it("resolves none when there is no pointer and no owned-set selection", () => {
    const resolved = resolveBranchCanonicalPullRequestId({
      currentPullRequestDetailId: null,
      pullRequestDetails: [],
      ownedSetSelectedId: null,
    });
    expect(resolved).toEqual({
      id: null,
      pointerId: null,
      source: BranchCanonicalPullRequestSource.None,
      pointerDivergedFromOwnedSet: false,
      ambiguous: false,
    });
  });
});

describe("isEmptyPullRequestStub", () => {
  it("classifies the all-null shape as a stub and any populated field as real", () => {
    expect(isEmptyPullRequestStub(STUB)).toBe(true);
    for (const key of [
      "fetchMechanism",
      "githubId",
      "additions",
      "deletions",
      "changedFiles",
    ] as const) {
      const nonNull = key === "fetchMechanism" || key === "githubId" ? "x" : 1;
      expect(isEmptyPullRequestStub({ ...STUB, [key]: nonNull })).toBe(false);
    }
  });
});

describe("has-a-PR predicates", () => {
  it("keys on owned rows, never the pointer, and the two buckets are exact negations", () => {
    expect(branchHasAnyPullRequestWhere()).toEqual({
      artifact: { is: { pullRequestDetails: { some: {} } } },
    });
    expect(branchHasNoPullRequestWhere()).toEqual({
      artifact: { is: { pullRequestDetails: { none: {} } } },
    });
  });
});

describe("reportBranchCanonicalPointerDivergence", () => {
  it("emits the monitored divergence event with the repair coordinates", () => {
    reportBranchCanonicalPointerDivergence({
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pointerId: "pr-1",
      ownedSetSelectedId: "pr-2",
    });
    expect(logWarn).toHaveBeenCalledWith(
      "branch canonical pointer diverged from owned-set selection",
      {
        event: BranchCanonicalDivergenceEvent.PointerDivergence,
        organizationId: "org-1",
        branchArtifactId: "branch-1",
        pointerId: "pr-1",
        ownedSetSelectedId: "pr-2",
      }
    );
  });
});

describe("reportBranchCanonicalPullRequestAmbiguity", () => {
  it("emits the monitored ambiguity event with both candidate ids", () => {
    reportBranchCanonicalPullRequestAmbiguity({
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      pointerId: "pr-1",
      ownedSetSelectedId: "pr-2",
    });
    expect(logWarn).toHaveBeenCalledWith(
      "branch canonical pull request selection is ambiguous",
      {
        event: BranchCanonicalDivergenceEvent.PullRequestAmbiguity,
        organizationId: "org-1",
        branchArtifactId: "branch-1",
        pointerId: "pr-1",
        ownedSetSelectedId: "pr-2",
      }
    );
  });
});

describe("branchCandidatePullRequests (ISS-8521)", () => {
  // Expectations are written as literals rather than rebuilt from the input
  // arrays: an expectation derived from the thing under test cannot fail when
  // the thing under test is wrong. Where WHICH ARM a row came from is the point,
  // the assertion is `toBe` on the element — `toEqual` is structural, so it
  // would pass an implementation that returned clones, and it stops telling the
  // arms apart entirely once two fixtures share a shape (a pointer and an owned
  // row for the same PR is the realistic case).
  const pointerRow = { number: 10 };
  const ownedA = { number: 20 };
  const ownedB = { number: 21 };
  const ownedC = { number: 22 };

  it("yields nothing when the branch has no pointer and owns no pull requests", () => {
    expect(
      branchCandidatePullRequests({ currentPullRequestDetail: null }, [])
    ).toEqual([]);
  });

  it("yields the pointer ahead of a single owned row", () => {
    expect(
      branchCandidatePullRequests({ currentPullRequestDetail: pointerRow }, [
        ownedA,
      ])
    ).toEqual([pointerRow, ownedA]);
  });

  it("yields every owned row, in order, behind the pointer", () => {
    // The many case is the whole reason a branch needs a candidate SET: one
    // branch can carry several PRs, and a reader that stopped at the pointer
    // would report only the newest. Three rows, so an implementation that kept
    // "the first" or "the last" fails rather than coinciding with a pair.
    expect(
      branchCandidatePullRequests({ currentPullRequestDetail: pointerRow }, [
        ownedA,
        ownedB,
        ownedC,
      ])
    ).toEqual([pointerRow, ownedA, ownedB, ownedC]);
  });

  it("yields every owned row and no empty slot when the branch has no pointer", () => {
    expect(
      branchCandidatePullRequests({ currentPullRequestDetail: null }, [
        ownedA,
        ownedB,
      ])
    ).toEqual([ownedA, ownedB]);
  });

  // The two states the pointer arm exists to tell apart. Both fixtures use the
  // SAME pointer object so only owned-set membership differs between them, and
  // both assert by identity, because "which arm produced element 0" is exactly
  // what a structural compare cannot see.
  it("repeats a pointer row the owned set also carries", () => {
    const result = branchCandidatePullRequests(
      { currentPullRequestDetail: ownedA },
      [ownedA, ownedB]
    );

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(ownedA);
    expect(result[1]).toBe(ownedA);
    expect(result[2]).toBe(ownedB);
  });

  it("keeps a pointer row the owned set does not carry", () => {
    // The sibling state, and the reason the arm cannot simply be dropped: nine
    // modules assign `currentPullRequestDetailId` directly (relink moves rows
    // between branch artifacts), so a pointer can name a row absent from the
    // owned set hydrated beside it. `pointerRow` is deliberately NOT in the
    // owned array here — reading the owned set alone would lose it, and this
    // case is what goes red if a future edit does.
    const result = branchCandidatePullRequests(
      { currentPullRequestDetail: pointerRow },
      [ownedA, ownedB]
    );

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(pointerRow);
    expect(result.includes(pointerRow)).toBe(true);
  });

  it("yields the owned rows when the row carries no branch relation", () => {
    expect(branchCandidatePullRequests(null, [ownedA])).toEqual([ownedA]);
    expect(branchCandidatePullRequests(undefined, [ownedA])).toEqual([ownedA]);
  });

  it("yields the pointer when the owned set was not hydrated", () => {
    expect(
      branchCandidatePullRequests(
        { currentPullRequestDetail: pointerRow },
        null
      )
    ).toEqual([pointerRow]);
    expect(
      branchCandidatePullRequests(
        { currentPullRequestDetail: pointerRow },
        undefined
      )
    ).toEqual([pointerRow]);
  });
});

/*
 * ISS-8902. Both signals fire once per branch-detail READ for as long as the
 * divergence persists, so a client polling one branch drove one or two warns per
 * poll with nothing bounding them. ONE throttle covers both.
 */
describe("canonical divergence emission bound (ISS-8902)", () => {
  const signal = {
    organizationId: "org-1",
    branchArtifactId: "branch-1",
    pointerId: "pr-1",
    ownedSetSelectedId: "pr-2",
  };

  function detailEvents(): string[] {
    // `logWarn` is module-wide: a future warn from this module carrying no
    // `event` key would otherwise dereference `undefined` and turn every case in
    // this block into a TypeError instead of a clean assertion failure.
    return logWarn.mock.calls
      .map(([, payload]) => payload?.event)
      .filter(
        (event: unknown): event is string =>
          typeof event === "string" && !event.endsWith("_suppressed")
      );
  }

  it("emits one detail record per key per window and suppresses the repeats", () => {
    for (let poll = 0; poll < 5; poll++) {
      reportBranchCanonicalPointerDivergence(signal);
    }

    // Without the bound this is 5 — one per poll, for as long as the divergence
    // persists. The condition itself is unchanged; only the emission is bounded.
    expect(detailEvents()).toEqual([
      BranchCanonicalDivergenceEvent.PointerDivergence,
    ]);
  });

  it("bounds the ambiguity signal too, on its own budget so neither starves the other", () => {
    reportBranchCanonicalPointerDivergence(signal);
    reportBranchCanonicalPullRequestAmbiguity(signal);
    reportBranchCanonicalPointerDivergence(signal);
    reportBranchCanonicalPullRequestAmbiguity(signal);

    // The event name is part of the key: the nested ambiguity signal still gets
    // its own detail record rather than being swallowed by the divergence budget.
    expect(detailEvents()).toEqual([
      BranchCanonicalDivergenceEvent.PointerDivergence,
      BranchCanonicalDivergenceEvent.PullRequestAmbiguity,
    ]);
  });

  it("keys on the branch, so a second diverging branch is still reported", () => {
    reportBranchCanonicalPointerDivergence(signal);
    reportBranchCanonicalPointerDivergence({
      ...signal,
      branchArtifactId: "branch-2",
    });

    expect(detailEvents()).toHaveLength(2);
  });

  /*
   * #7204 review: the per-branch key bounds repeat polls of ONE branch, not the
   * number of branches, so a caller reading many diverging branches still drove
   * an unbounded stream — every fresh `branchArtifactId` opened its own budget.
   */
  it("bounds the detail stream per organization, not only per branch", () => {
    for (let branch = 0; branch < 25; branch++) {
      reportBranchCanonicalPointerDivergence({
        ...signal,
        branchArtifactId: `branch-${branch}`,
      });
    }

    // Without the org ceiling this is 25 — one detail record per distinct
    // branch, with nothing bounding how many branches a caller may read.
    expect(detailEvents()).toHaveLength(20);
  });

  it("keeps the org ceiling per signal and per org, so neither starves the other", () => {
    for (let branch = 0; branch < 25; branch++) {
      reportBranchCanonicalPointerDivergence({
        ...signal,
        branchArtifactId: `branch-${branch}`,
      });
    }

    // A DIFFERENT org, and a different signal in the exhausted org, must both
    // still report: the ceiling is a per-(org, signal) budget, not a global one.
    reportBranchCanonicalPointerDivergence({
      ...signal,
      organizationId: "org-2",
      branchArtifactId: "branch-0",
    });
    reportBranchCanonicalPullRequestAmbiguity({
      ...signal,
      branchArtifactId: "branch-0",
    });

    expect(detailEvents()).toHaveLength(22);
  });

  it("spends the org ceiling on distinct branches, never on one branch's poll loop", () => {
    // The ordering the two throttles compose in. The per-branch correlation key
    // runs FIRST, so these 50 repeats of one branch cost the org exactly one
    // unit; org-first would let this loop exhaust the ceiling and silence every
    // other diverging branch in the org.
    for (let poll = 0; poll < 50; poll++) {
      reportBranchCanonicalPointerDivergence(signal);
    }
    // A namespace the polled `branch-1` cannot collide with, so these really are
    // 19 further DISTINCT branches.
    for (let branch = 0; branch < 19; branch++) {
      reportBranchCanonicalPointerDivergence({
        ...signal,
        branchArtifactId: `other-${branch}`,
      });
    }

    // 1 for the polled branch + 19 others, all inside the ceiling.
    expect(detailEvents()).toHaveLength(20);
  });

  it("recovers the org-refused occurrences as a rollup rather than discarding them", () => {
    for (let branch = 0; branch < 23; branch++) {
      reportBranchCanonicalPointerDivergence({
        ...signal,
        branchArtifactId: `branch-${branch}`,
      });
    }

    drainBranchCanonicalDivergenceEmissions(Date.now() + 120_000);

    const rollup = logWarn.mock.calls.find(
      ([event]) =>
        event === "branch_canonical_pointer_divergence_org_budget_suppressed"
    );
    // The three branches past the ceiling are counted, not lost. No
    // `branchArtifactId`: they were never individually reported, so naming one
    // would imply the other two were that same branch.
    expect(rollup?.[1]).toMatchObject({
      organizationId: "org-1",
      suppressed: 3,
    });
    expect(rollup?.[1]).not.toHaveProperty("branchArtifactId");
  });

  it("recovers the suppressed occurrences as a rollup rather than discarding them", () => {
    for (let poll = 0; poll < 4; poll++) {
      reportBranchCanonicalPointerDivergence(signal);
    }

    // The expiry drain is the terminal path `reportDetailPointerDivergence` runs
    // on EVERY branch-detail read, so a burst followed by quiet still reaches the
    // aggregate. `count(detail) + sum(suppressed)` recovers the true count.
    drainBranchCanonicalDivergenceEmissions(Date.now() + 120_000);

    const rollup = logWarn.mock.calls.find(
      ([event]) => event === "branch_canonical_pointer_divergence_suppressed"
    );
    expect(rollup?.[1]).toMatchObject({
      organizationId: "org-1",
      branchArtifactId: "branch-1",
      suppressed: 3,
    });
  });
});

// ISS-8901. The predicate's consumer, the tombstoned-refresh lane, had no
// direct coverage of it (a second consumer, `lib/pr-read-repair.ts`, was deleted
// by ISS-11588); the rekeying off the per-installation surrogate id was visible
// only through the lane's mocked where-clauses. The probe is ORDERED — provider id, then name — so
// each arm is pinned on its own, and so is the case that decides between them.
describe("branchOwnsPullRequestDetail", () => {
  it("accepts a reinstall split: one repository, two installation rows", () => {
    // The defect shape. One repository, two installation rows: the surrogate
    // ids disagree (that is what ISS-8901 stopped reading) but GitHub's own
    // `githubRepoId` is the same on both, which is what makes them one repo.
    expect(
      branchOwnsPullRequestDetail(
        {
          repositoryFullName: "acme/web",
          repository: { fullName: "Acme/Web", githubRepoId: "42" },
        },
        {
          repositoryFullName: "acme/web",
          repository: { fullName: "acme/web", githubRepoId: "42" },
        }
      )
    ).toBe(true);
  });

  it("rejects two same-named repositories with different provider ids", () => {
    // whitlockk, PR #7209: the conflict a name-only compare ACCEPTS. Two `acme/web`
    // rows that are genuinely different repositories carry different provider
    // ids; accepting the pair stamps retry/provenance on the wrong PR before
    // the downstream `githubId` check bails out. This is the case that fails if
    // the probe is reordered to consult the name first.
    expect(
      branchOwnsPullRequestDetail(
        {
          repositoryFullName: "acme/web",
          repository: { fullName: "acme/web", githubRepoId: "42" },
        },
        {
          repositoryFullName: "acme/web",
          repository: { fullName: "acme/web", githubRepoId: "99" },
        }
      )
    ).toBe(false);
  });

  it("follows the provider id across a rename", () => {
    // The mirror of the case above: same repository, renamed between the two
    // installation rows. The provider id is the identity; the name moved.
    expect(
      branchOwnsPullRequestDetail(
        {
          repositoryFullName: "acme/web",
          repository: { fullName: "acme/web", githubRepoId: "42" },
        },
        {
          repositoryFullName: "acme/webapp",
          repository: { fullName: "acme/webapp", githubRepoId: "42" },
        }
      )
    ).toBe(true);
  });

  it("falls back to the name only when a side has no provider id", () => {
    // A repo-less row (PLN-1775 M7) has no installation relation at all, so the
    // name arm is the only identity it has. Pinned in both directions so the
    // fallback cannot quietly become "absent id matches anything".
    expect(
      branchOwnsPullRequestDetail(
        {
          repositoryFullName: "acme/web",
          repository: { fullName: "acme/web", githubRepoId: "42" },
        },
        { repositoryFullName: "acme/web", repository: null }
      )
    ).toBe(true);
    expect(
      branchOwnsPullRequestDetail(
        {
          repositoryFullName: "acme/web",
          repository: { fullName: "acme/web", githubRepoId: "42" },
        },
        { repositoryFullName: "acme/api", repository: null }
      )
    ).toBe(false);
  });

  it("normalizes case and a .git suffix on either side", () => {
    expect(
      branchOwnsPullRequestDetail(
        { repositoryFullName: "Acme/Web.git", repository: null },
        { repositoryFullName: "acme/web", repository: null }
      )
    ).toBe(true);
  });

  it("prefers the installation relation over the denormalized column", () => {
    // A stale column must not decide ownership while the relation disagrees.
    expect(
      branchOwnsPullRequestDetail(
        {
          repositoryFullName: "acme/old-name",
          repository: { fullName: "acme/web" },
        },
        { repositoryFullName: "acme/web", repository: { fullName: "acme/web" } }
      )
    ).toBe(true);
  });

  it("still rejects a different repository", () => {
    // The term the tombstoned-refresh lane depends on, and the one the
    // rekeying must not widen: a cross-repo accept would let that lane settle a
    // stranger's PR onto this branch.
    expect(
      branchOwnsPullRequestDetail(
        {
          repositoryFullName: "acme/web",
          repository: { fullName: "acme/web" },
        },
        { repositoryFullName: "acme/api", repository: { fullName: "acme/api" } }
      )
    ).toBe(false);
  });

  it("rejects a row that names no repository at all", () => {
    // Fail closed: an absent name is not a match with anything, including
    // another absent name.
    expect(
      branchOwnsPullRequestDetail(
        { repositoryFullName: null, repository: null },
        { repositoryFullName: "acme/web", repository: null }
      )
    ).toBe(false);
    expect(
      branchOwnsPullRequestDetail(
        { repositoryFullName: "acme/web", repository: null },
        { repositoryFullName: null, repository: null }
      )
    ).toBe(false);
    expect(
      branchOwnsPullRequestDetail(
        { repositoryFullName: null, repository: null },
        { repositoryFullName: null, repository: null }
      )
    ).toBe(false);
  });
});

describe("tombstonedRepositoryWhere", () => {
  it("uses the provider repository id across renames", () => {
    expect(
      tombstonedRepositoryWhere({
        fullName: "acme/renamed",
        githubRepoId: "42",
      })
    ).toEqual({ removedAt: { not: null }, githubRepoId: "42" });
  });

  it("falls back to the normalized name without a provider repository id", () => {
    expect(tombstonedRepositoryWhere({ fullName: "Acme/Web.git" })).toEqual({
      removedAt: { not: null },
      fullName: { equals: "acme/web", mode: "insensitive" },
    });
  });
});
