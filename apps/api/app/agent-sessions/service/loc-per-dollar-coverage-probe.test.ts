/**
 * ISS-7705 — `readLocPerDollarCoverageCounts` itself, and the cohort resolver
 * that decides which sessions it measures.
 *
 * Its siblings grade the pure fold (`loc-per-dollar-coverage.test.ts`) and the
 * composition-root wiring (`loc-per-dollar-coverage-telemetry.test.ts`), both of
 * which mock this function out. Nothing was left driving the code that actually
 * composes the predicates — so the detector that finds a mid-rebuild session, the
 * one that finds an unrevisioned session, the denominator comparison, and the
 * degrade-to-null catch were all mutable without a red test. Every case here
 * executes the real function.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { LocPerDollarCoverageState } from "@repo/api/src/types/loc-per-dollar-coverage";
import {
  ArtifactRefMethod,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import type { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mocks } from "@/__tests__/support/agent-sessions/service.test-mocks";
import {
  MergedPrBranchAdmissionKind,
  sessionLinkedPopulationArms,
} from "@/lib/session-pr-links";
import { LINK_BRANCH_QUERY_CHUNK_SIZE } from "@/lib/session-pr-links-chunking";
import {
  foldLocPerDollarCoverage,
  type NumeratorBranchCohort,
  readLocPerDollarCoverageCounts,
  resolveNumeratorBranchCohort,
} from "./loc-per-dollar-coverage";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const ORGANIZATION_ID = "org-probe";
const BRANCH_A = "branch-a";
const BRANCH_B = "branch-b";
/** The session artifact ids the two link rows resolve to. */
const SESSION_ONE = "session-1";
const SESSION_TWO = "session-2";
const REPOSITORY = "acme/repo";
/** The two PRs the cohort admits, one per branch. */
const PR_A = 7;
const PR_B = 8;
/** A SECOND PR on branch A — a reused branch. Never admitted by these cases. */
const PR_REUSED = 9;

/**
 * Sentinels so each `where` can be identified by what it carries. The
 * denominator adds the activity window the summary applies and the delivery
 * scope strips — the one clause that actually makes the two populations differ.
 */
const DELIVERY_WHERE = {
  harness: "claude",
} satisfies Prisma.SessionDetailWhereInput;
const DENOMINATOR_WHERE = {
  harness: "claude",
  lastActivityAt: { gte: new Date(0) },
} satisfies Prisma.SessionDetailWhereInput;

type ProbeLink = { sourceId: string; targetId: string; metadata: unknown };

/** A canonical session→PR link declaring exactly one PR. */
function prLink(
  sourceId: string,
  targetId: string,
  prNumber: number
): ProbeLink {
  return {
    sourceId,
    targetId,
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      prRefs: [{ repositoryFullName: REPOSITORY, prNumber, relationTypes: [] }],
    },
  };
}

function admits(...prNumbers: number[]) {
  return {
    identities: new Set(
      prNumbers.map((prNumber) => `${REPOSITORY}#${prNumber}`)
    ),
    legacyUniqueFallback: false,
    tierTwoUniqueBranchFallback: false,
  };
}

/** The two-branch cohort every pre-existing case here runs against. */
const COHORT: NumeratorBranchCohort = new Map([
  [BRANCH_A, admits(PR_A)],
  [BRANCH_B, admits(PR_B)],
]);

type Captured = {
  linkWhere?: Record<string, unknown>;
  findManyWhere?: Record<string, unknown>;
  countWhere?: Record<string, unknown>;
  /** Every id list an `IN` predicate carried, across every read. */
  inLists: string[][];
};

/** The artifact ids an `{ AND: [where, { artifactId: { in } }] }` carries. */
function sessionIdsIn(where: Record<string, unknown>): string[] {
  const clauses = (where.AND ?? []) as { artifactId?: { in?: string[] } }[];
  return clauses[1]?.artifactId?.in ?? [];
}

function linkTargetIdsIn(where: Record<string, unknown>): string[] {
  const direct = (where.targetId as { in?: string[] } | undefined)?.in;
  if (direct) {
    return direct;
  }
  const clauses = (where.OR ?? []) as { targetId?: { in?: string[] } }[];
  return [...new Set(clauses.flatMap((clause) => clause.targetId?.in ?? []))];
}

/** One numerator session, as the population read and the divisor see it. */
type ProbeSession = {
  dataRevision: number | null;
  pendingChunkRevision: number | null;
  /** Whether the DENOMINATOR predicate also matches this session. */
  covered: boolean;
};

/**
 * Installs a db whose `sessionDetail` reads answer FROM the cohort the probe
 * resolved, capturing every `where` so the cases can assert WHICH predicate each
 * read carried — not merely that a read happened.
 *
 * `rows`/`coveredCount` answer a fixed population regardless of the cohort;
 * `sessions` answers per-session, which is what lets a case prove that admitting
 * the wrong session changes the verdict. `bindLimit` makes an over-wide `IN`
 * list reject the way a driver past its bind-parameter ceiling does.
 */
function installProbeDb(args: {
  links?: ProbeLink[];
  rows?: { dataRevision: number | null; pendingChunkRevision: number | null }[];
  coveredCount?: number;
  sessions?: Map<string, ProbeSession>;
  rejectOn?: "links" | "rows" | "count";
  bindLimit?: number;
}): Captured {
  const captured: Captured = { inLists: [] };
  const boom = new Error("db exploded");
  const overLimit = (ids: string[]) =>
    args.bindLimit !== undefined && ids.length > args.bindLimit;
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      artifactLink: {
        findMany: vi.fn((query: { where: Record<string, unknown> }) => {
          captured.linkWhere = query.where;
          const targetIds = linkTargetIdsIn(query.where);
          captured.inLists.push(targetIds);
          if (args.rejectOn === "links" || overLimit(targetIds)) {
            return Promise.reject(boom);
          }
          const links = args.links ?? [];
          return Promise.resolve(
            links.filter((link) => targetIds.includes(link.targetId))
          );
        }),
      },
      sessionDetail: {
        findMany: vi.fn((query: { where: Record<string, unknown> }) => {
          captured.findManyWhere = query.where;
          const ids = sessionIdsIn(query.where);
          captured.inLists.push(ids);
          if (args.rejectOn === "rows" || overLimit(ids)) {
            return Promise.reject(boom);
          }
          if (args.sessions) {
            return Promise.resolve(
              ids.flatMap((id) => {
                const session = args.sessions?.get(id);
                return session
                  ? [
                      {
                        dataRevision: session.dataRevision,
                        pendingChunkRevision: session.pendingChunkRevision,
                      },
                    ]
                  : [];
              })
            );
          }
          return Promise.resolve(args.rows ?? []);
        }),
        count: vi.fn((query: { where: Record<string, unknown> }) => {
          captured.countWhere = query.where;
          const ids = sessionIdsIn(query.where);
          captured.inLists.push(ids);
          if (args.rejectOn === "count" || overLimit(ids)) {
            return Promise.reject(boom);
          }
          if (args.sessions) {
            return Promise.resolve(
              ids.filter((id) => args.sessions?.get(id)?.covered).length
            );
          }
          return Promise.resolve(args.coveredCount ?? 0);
        }),
      },
    })
  );
  return captured;
}

function runProbe(cohort: NumeratorBranchCohort = COHORT) {
  return readLocPerDollarCoverageCounts(
    ORGANIZATION_ID,
    cohort,
    DELIVERY_WHERE,
    DENOMINATOR_WHERE
  );
}

/** Both link rows, so the cohort is the two sessions. */
const BOTH_LINKS = [
  prLink(SESSION_ONE, BRANCH_A, PR_A),
  prLink(SESSION_TWO, BRANCH_B, PR_B),
];

describe("readLocPerDollarCoverageCounts — which sessions it measures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the cohort from the merged-PR branches, org-scoped, on metric PR and branch evidence", async () => {
    const captured = installProbeDb({ links: BOTH_LINKS });

    await runProbe();

    // Anchored on the branch ids the merged PRs were admitted against — this is
    // what keeps the cohort to the sessions whose work is really in the
    // numerator, instead of every session that ever carried a PR link.
    expect(captured.linkWhere).toEqual({
      linkType: LinkType.RelatesTo,
      OR: sessionLinkedPopulationArms(),
      organizationId: ORGANIZATION_ID,
      targetId: { in: [BRANCH_A, BRANCH_B] },
    });
  });

  it("scopes the population read by the DELIVERY where and the resolved cohort", async () => {
    const captured = installProbeDb({ links: BOTH_LINKS });

    await runProbe();

    expect(captured.findManyWhere).toEqual({
      AND: [DELIVERY_WHERE, { artifactId: { in: [SESSION_ONE, SESSION_TWO] } }],
    });
  });

  it("counts the covered half against the DENOMINATOR where — the divisor's own predicate", async () => {
    const captured = installProbeDb({ links: BOTH_LINKS });

    await runProbe();

    // The distinction that makes the gate mean anything: if this used the
    // delivery `where` instead, covered would always equal the numerator and
    // `missing` could never fire.
    expect(captured.countWhere).toEqual({
      AND: [
        DENOMINATOR_WHERE,
        { artifactId: { in: [SESSION_ONE, SESSION_TWO] } },
      ],
    });
    expect(captured.countWhere).not.toEqual(captured.findManyWhere);
  });

  it("dedupes sessions linked to more than one merged branch", async () => {
    // One session that worked on both merged branches must be ONE numerator
    // session, not two — the same dedup-by-identity discipline the merged-PR
    // population itself keeps.
    const captured = installProbeDb({
      links: [
        prLink(SESSION_ONE, BRANCH_A, PR_A),
        prLink(SESSION_ONE, BRANCH_B, PR_B),
      ],
      rows: [{ dataRevision: 7, pendingChunkRevision: null }],
    });

    await runProbe();

    expect(captured.findManyWhere).toEqual({
      AND: [DELIVERY_WHERE, { artifactId: { in: [SESSION_ONE] } }],
    });
  });

  it("reports an empty cohort without reading sessions at all when no link resolves", async () => {
    const captured = installProbeDb({ links: [] });

    const counts = await runProbe();

    expect(counts).toEqual({
      numeratorSessionCount: 0,
      coveredNumeratorSessionCount: 0,
      migrationPendingSessionCount: 0,
      unrevisionedSessionCount: 0,
    });
    expect(captured.findManyWhere).toBeUndefined();
    expect(captured.countWhere).toBeUndefined();
  });
});

describe("readLocPerDollarCoverageCounts — the detectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts a staged chunk replacement as migration-pending, and a committed one as not", async () => {
    installProbeDb({
      links: BOTH_LINKS,
      // Deliberately UNBALANCED — one staged against two committed. A 1:1 split
      // would report the same count whether the predicate tested for a staged
      // marker or for its absence, so the case could not fail under the exact
      // inversion it exists to prevent.
      rows: [
        // Mid-rebuild: chunk 0 of an advancing revision staged the marker.
        { dataRevision: 86, pendingChunkRevision: 87 },
        // Steady state: the sequence committed and cleared the marker.
        { dataRevision: 87, pendingChunkRevision: null },
        { dataRevision: 87, pendingChunkRevision: null },
      ],
      coveredCount: 3,
    });

    const counts = await runProbe();

    expect(counts?.migrationPendingSessionCount).toBe(1);
    expect(counts?.numeratorSessionCount).toBe(3);
  });

  it("counts a never-revisioned session as unrevisioned, and a revisioned one as not", async () => {
    installProbeDb({
      links: BOTH_LINKS,
      // Unbalanced for the same reason as its sibling above.
      rows: [
        { dataRevision: null, pendingChunkRevision: null },
        { dataRevision: 87, pendingChunkRevision: null },
        { dataRevision: 87, pendingChunkRevision: null },
      ],
      coveredCount: 3,
    });

    const counts = await runProbe();

    expect(counts?.unrevisionedSessionCount).toBe(1);
    // A revision of 0 is a real revision, not an absent one — the detector must
    // test for null, not for falsiness.
    expect(counts?.migrationPendingSessionCount).toBe(0);
  });

  it("treats a zero data revision as revisioned, not as absent", async () => {
    installProbeDb({
      links: [prLink(SESSION_ONE, BRANCH_A, PR_A)],
      rows: [{ dataRevision: 0, pendingChunkRevision: null }],
      coveredCount: 1,
    });

    const counts = await runProbe();

    expect(counts?.unrevisionedSessionCount).toBe(0);
  });

  it("returns the covered count the denominator predicate actually produced", async () => {
    installProbeDb({
      links: BOTH_LINKS,
      rows: [
        { dataRevision: 87, pendingChunkRevision: null },
        { dataRevision: 87, pendingChunkRevision: null },
      ],
      coveredCount: 1,
    });

    const counts = await runProbe();

    expect(counts?.numeratorSessionCount).toBe(2);
    expect(counts?.coveredNumeratorSessionCount).toBe(1);
  });
});

describe("readLocPerDollarCoverageCounts — degrades instead of throwing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Each read is its own case: a catch that only wrapped one of them would still
  // let the others reject and take down a summary whose headline aggregates had
  // already succeeded.
  for (const rejectOn of ["links", "rows", "count"] as const) {
    it(`resolves null rather than rejecting when the ${rejectOn} read fails`, async () => {
      installProbeDb({ links: BOTH_LINKS, rejectOn });

      await expect(runProbe()).resolves.toBeNull();
    });
  }
});

describe("resolveNumeratorBranchCohort", () => {
  const EARLY = 1000;
  const MID = 2000;
  const LATE = 3000;
  const branches = [
    {
      branchArtifactId: BRANCH_A,
      mergedAtMs: EARLY,
      admissionKind: MergedPrBranchAdmissionKind.ExactIdentity,
      prIdentity: `${REPOSITORY}#${PR_A}`,
    },
    {
      branchArtifactId: BRANCH_B,
      mergedAtMs: MID,
      admissionKind: MergedPrBranchAdmissionKind.ExactIdentity,
      prIdentity: `${REPOSITORY}#${PR_B}`,
    },
    {
      branchArtifactId: "branch-c",
      mergedAtMs: LATE,
      admissionKind: MergedPrBranchAdmissionKind.LegacyUniqueBranch,
      prIdentity: null,
    },
  ];

  it("keeps only the branches whose PR merged inside the window, bounds inclusive", () => {
    expect([
      ...resolveNumeratorBranchCohort(branches, {
        start: EARLY,
        end: MID,
      }).keys(),
    ]).toEqual([BRANCH_A, BRANCH_B]);
  });

  it("keeps every branch when no window is selected", () => {
    expect([...resolveNumeratorBranchCohort(branches, null).keys()]).toEqual([
      BRANCH_A,
      BRANCH_B,
      "branch-c",
    ]);
  });

  it("returns nothing when no merged PR landed in the window", () => {
    // The whole probe is skipped on this result: no lines merged in range means
    // no ratio, so there is nothing to gate and nothing to query.
    expect(
      resolveNumeratorBranchCohort(branches, {
        start: LATE + 1,
        end: LATE + 2,
      }).size
    ).toBe(0);
  });

  it("carries every in-window PR identity a reused branch admitted, and only those", () => {
    // ISS-7705: the branch merged two PRs, but only one landed in the window.
    // Collapsing them to a bare branch id is what let the out-of-window PR's
    // sessions be measured as though they had contributed lines.
    const cohort = resolveNumeratorBranchCohort(
      [
        {
          branchArtifactId: BRANCH_A,
          mergedAtMs: EARLY,
          admissionKind: MergedPrBranchAdmissionKind.ExactIdentity,
          prIdentity: `${REPOSITORY}#${PR_A}`,
        },
        {
          branchArtifactId: BRANCH_A,
          mergedAtMs: LATE,
          admissionKind: MergedPrBranchAdmissionKind.ExactIdentity,
          prIdentity: `${REPOSITORY}#${PR_REUSED}`,
        },
      ],
      { start: EARLY, end: MID }
    );

    expect([...cohort.keys()]).toEqual([BRANCH_A]);
    expect([...(cohort.get(BRANCH_A)?.identities ?? [])]).toEqual([
      `${REPOSITORY}#${PR_A}`,
    ]);
    expect(cohort.get(BRANCH_A)?.legacyUniqueFallback).toBe(false);
  });

  it("records a null identity as the unique-Branch legacy fallback", () => {
    // A branch admitted through the legacy arm has exactly one PR, so its links
    // cannot be ambiguous and the probe must still accept them.
    const cohort = resolveNumeratorBranchCohort(
      [
        {
          branchArtifactId: BRANCH_A,
          mergedAtMs: EARLY,
          admissionKind: MergedPrBranchAdmissionKind.LegacyUniqueBranch,
          prIdentity: null,
        },
      ],
      null
    );

    expect(cohort.get(BRANCH_A)).toEqual({
      identities: new Set(),
      legacyUniqueFallback: true,
      tierTwoUniqueBranchFallback: false,
    });
  });

  it("records a tier-two null identity separately from legacy fallback", () => {
    const cohort = resolveNumeratorBranchCohort(
      [
        {
          branchArtifactId: BRANCH_A,
          mergedAtMs: EARLY,
          admissionKind: MergedPrBranchAdmissionKind.TierTwoUniqueBranch,
          prIdentity: null,
        },
      ],
      null
    );

    expect(cohort.get(BRANCH_A)).toEqual({
      identities: new Set(),
      legacyUniqueFallback: false,
      tierTwoUniqueBranchFallback: true,
    });
  });
});

describe("readLocPerDollarCoverageCounts — a REUSED branch (ISS-7705)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * One branch, two PRs. `PR_A` merged in window and admitted the branch;
   * `PR_REUSED` is a second PR that ran on the same branch name and was never
   * admitted. Its session is outside the divisor's window and carries no data
   * revision — so if it reaches the cohort, the card is faulted.
   */
  const REUSED_COHORT: NumeratorBranchCohort = new Map([
    [BRANCH_A, admits(PR_A)],
  ]);
  const REUSED_LINKS = [
    prLink(SESSION_ONE, BRANCH_A, PR_A),
    prLink(SESSION_TWO, BRANCH_A, PR_REUSED),
  ];
  const REUSED_SESSIONS = new Map<string, ProbeSession>([
    [
      SESSION_ONE,
      { dataRevision: 87, pendingChunkRevision: null, covered: true },
    ],
    [
      SESSION_TWO,
      { dataRevision: null, pendingChunkRevision: null, covered: false },
    ],
  ]);

  it("measures only the sessions of the PR that was actually admitted", async () => {
    const captured = installProbeDb({
      links: REUSED_LINKS,
      sessions: REUSED_SESSIONS,
    });

    const counts = await runProbe(REUSED_COHORT);

    expect(sessionIdsIn(captured.findManyWhere ?? {})).toEqual([SESSION_ONE]);
    expect(counts?.numeratorSessionCount).toBe(1);
    expect(counts?.coveredNumeratorSessionCount).toBe(1);
  });

  it("leaves a fully covered card stating its number instead of blanking it", async () => {
    // The user-visible half: pulling every link on the branch admits PR #9's
    // session, which the divisor does not sum and which was never
    // revision-stamped — so a genuinely covered ratio renders `missing`/`stale`
    // instead of its value.
    installProbeDb({ links: REUSED_LINKS, sessions: REUSED_SESSIONS });

    const coverage = foldLocPerDollarCoverage(await runProbe(REUSED_COHORT), {
      denominatorSessionCount: 1,
      costBasisCoveredUsd: 40,
      costBasisExcludedUsd: 0,
    });

    expect(coverage.state).toBe(LocPerDollarCoverageState.Complete);
    expect(coverage.excludedSessionCount).toBe(0);
  });
});

describe("readLocPerDollarCoverageCounts — chunked IN predicates (ISS-7705)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** One more id than a single statement may bind. */
  const OVER_LIMIT = LINK_BRANCH_QUERY_CHUNK_SIZE + 1;

  it("completes a cohort wider than the bind limit instead of reporting failed", async () => {
    // The failure this closes is not a crash: past the limit the probe rejected
    // and published `failed` while the summary read it describes had SUCCEEDED,
    // so the surface contradicted itself. `bindLimit` rejects any statement the
    // driver would.
    const branchIds = Array.from(
      { length: OVER_LIMIT },
      (_unused, index) => `${BRANCH_A}-${index}`
    );
    const cohort: NumeratorBranchCohort = new Map(
      branchIds.map((branchId) => [branchId, admits(PR_A)])
    );
    const links = branchIds.map((branchId, index) =>
      prLink(`session-${index}`, branchId, PR_A)
    );
    const sessions = new Map<string, ProbeSession>(
      links.map((link, index) => [
        link.sourceId,
        {
          dataRevision: 87,
          pendingChunkRevision: null,
          // Half covered, so the summed count is a real figure and not a
          // constant either chunking or its absence would reproduce.
          covered: index % 2 === 0,
        },
      ])
    );
    const captured = installProbeDb({
      links,
      sessions,
      bindLimit: LINK_BRANCH_QUERY_CHUNK_SIZE,
    });

    const counts = await runProbe(cohort);

    expect(counts).not.toBeNull();
    expect(counts?.numeratorSessionCount).toBe(OVER_LIMIT);
    // Summed across chunks, so the total is the whole population's — a chunked
    // count that dropped a chunk would report fewer.
    expect(counts?.coveredNumeratorSessionCount).toBe(
      Math.ceil(OVER_LIMIT / 2)
    );
    expect(
      captured.inLists.every(
        (ids) => ids.length <= LINK_BRANCH_QUERY_CHUNK_SIZE
      )
    ).toBe(true);
  });
});

describe("branch-evidence numerator cohort (ISS-7905)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A non-prose session→BRANCH link — the installation-free lane at rest. */
  function branchLink(
    sourceId: string,
    targetId: string,
    method?: string
  ): ProbeLink {
    return {
      sourceId,
      targetId,
      metadata: {
        linkKind: SessionArtifactLinkKind.SessionBranch,
        linkKinds: [SessionArtifactLinkKind.SessionBranch],
        ...(method ? { method } : {}),
      },
    };
  }

  /**
   * The cohort shape a branch-evidence admission produces: `prIdentity: null`,
   * which `resolveNumeratorBranchCohort` records as `legacyUniqueFallback`.
   */
  const BRANCH_EVIDENCE_COHORT: NumeratorBranchCohort = new Map([
    [
      BRANCH_A,
      {
        identities: new Set<string>(),
        legacyUniqueFallback: false,
        tierTwoUniqueBranchFallback: true,
      },
    ],
  ]);

  it("measures EVERY session on a branch admitted by branch evidence alone", async () => {
    // The whole point of the ISS-7905 arm: with no link naming a PR, the
    // evidence is branch-level, so every session on that branch is in the
    // numerator cohort — and one of them here is NOT covered by the divisor.
    // The Missing verdict that follows is the gate reporting a real gap the
    // card previously could not see (those lines were not in the numerator at
    // all), not a fabricated one. Asserted here so the consequence for the
    // LOC/$ card is pinned rather than discovered in production.
    installProbeDb({
      links: [
        branchLink(SESSION_ONE, BRANCH_A),
        branchLink(SESSION_TWO, BRANCH_A),
      ],
      sessions: new Map([
        [
          SESSION_ONE,
          { dataRevision: 87, pendingChunkRevision: null, covered: true },
        ],
        [
          SESSION_TWO,
          { dataRevision: 87, pendingChunkRevision: null, covered: false },
        ],
      ]),
    });

    const counts = await runProbe(BRANCH_EVIDENCE_COHORT);

    expect(counts?.numeratorSessionCount).toBe(2);
    expect(counts?.coveredNumeratorSessionCount).toBe(1);
    expect(
      foldLocPerDollarCoverage(counts, {
        denominatorSessionCount: 1,
        costBasisCoveredUsd: 10,
        costBasisExcludedUsd: 0,
      }).state
    ).toBe(LocPerDollarCoverageState.Missing);
  });

  it("measures NO session when the only branch link is prose-derived", async () => {
    // The sibling in the opposite state, on the same cohort: prose evidence
    // cannot move a metric (ISS-5823), so it cannot enter this cohort either.
    // Without this, the case above would pass on a mirror that admitted every
    // branch link regardless of tier.
    // The session population is the SAME two rows the case above measures, so
    // this cannot pass merely by having nothing to find: if the prose links were
    // admitted, both sessions would resolve and the counts would read 2 / 1.
    installProbeDb({
      links: [
        branchLink(
          SESSION_ONE,
          BRANCH_A,
          ArtifactRefMethod.BranchMentionInProse
        ),
        branchLink(SESSION_TWO, BRANCH_A, ArtifactRefMethod.PrMentionInProse),
      ],
      sessions: new Map([
        [
          SESSION_ONE,
          { dataRevision: 87, pendingChunkRevision: null, covered: true },
        ],
        [
          SESSION_TWO,
          { dataRevision: 87, pendingChunkRevision: null, covered: false },
        ],
      ]),
    });

    const counts = await runProbe(BRANCH_EVIDENCE_COHORT);

    expect(counts?.numeratorSessionCount).toBe(0);
    expect(counts?.coveredNumeratorSessionCount).toBe(0);
  });
});
