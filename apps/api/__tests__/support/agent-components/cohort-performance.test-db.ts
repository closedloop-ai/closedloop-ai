/**
 * @file cohort-performance.test-db.ts
 * @description The hand-rolled `db` double `computeCohortPerformance` is driven
 * against — cohort vs. baseline reads routed by their `where` shape, no real
 * database. Extracted from `cohort-performance.test.ts` (ISS-9751) so a second
 * suite can exercise the same reader without a second copy of the fake, and so
 * the original file stays clear of the 1,000-line ceiling.
 *
 * The caller still owns `vi.mock("@repo/database", …)`: `computeCohortPerformance`
 * pulls `Prisma.sql` in through `cohort-baseline-loc.ts`, and `vi.mock` is
 * hoisted per test FILE, so it cannot live here.
 */
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { vi } from "vitest";
import type { computeCohortPerformance } from "@/app/agent-components/cohort-performance";

/** The org every fixture row belongs to unless a case says otherwise. */
export const ORG = "org-1";

/** Owner of the rows that must stay invisible to a correctly-scoped read. */
export const FOREIGN_ORG = "org-foreign";

export type MergedPr = { repo: string | null; number: number | null };

export type CohortTestPrDetail = {
  number: number | null;
  prState: GitHubPRState;
  mergedAt: Date;
  isCurrent: boolean;
  lastVerifiedAt?: Date;
  repositoryFullName: string | null;
  repository: { fullName: string } | null;
};

export type CohortTestRow = {
  artifactId: string;
  /**
   * ISS-9751: nullable, because `SessionDetail.lines_added` is `Int?`. Both
   * counts null is UNMEASURED LOC — the state `sessionLoc` folds to 0 and a
   * fixture that cannot express it cannot tell an unmeasured cohort from one
   * that verifiably shipped nothing.
   */
  linesAdded: number | null;
  linesRemoved: number | null;
  locSource: string | null;
  repositoryFullName: string | null;
  /**
   * ISS-9751: nullable, because the column is. A `null` is an UNPRICED session
   * — the state that used to be summed as `$0` — and a fixture that cannot
   * express it cannot fail the population mismatch.
   */
  estimatedCost: number | null;
  inputTokens: bigint;
  outputTokens: bigint;
  sessionStartedAt: Date;
  artifact: {
    sourceLinks: Array<{
      metadata: Record<string, unknown>;
      targetId: string;
      target: {
        branch: {
          repository: { fullName: string } | null;
          currentPullRequestDetail: CohortTestPrDetail;
        };
        pullRequestDetails: CohortTestPrDetail[];
      };
    }>;
  };
};

/** The `sessionDetail.findMany` args `makeFakeDb` records for query assertions. */
export type FakeSessionQuery = {
  where: {
    artifactId?: { in?: string[]; notIn?: string[] };
    artifact?: { organizationId?: string };
    sessionStartedAt?: { gte?: Date; lte?: Date };
  };
  orderBy?: unknown;
  take?: number;
};

/** The baseline `_sum` a case wants the tokens/cost aggregate to return. */
export type FakeBaselineSum = {
  linesAdded: number | null;
  linesRemoved: number | null;
  estimatedCost: number | null;
  inputTokens: bigint | null;
  outputTokens: bigint | null;
};

/**
 * ISS-9751: the baseline LOC/$ coverage counters the tokens/cost aggregate
 * returns ALONGSIDE its `_sum`, in the same statement. `rowCount - pricedRows`
 * is the unpriced set the `_sum` skipped and `minimumEstimatedCost` carries the
 * negative arm. Defaults to a window whose every row is priced.
 */
export type FakeBaselineCostCoverage = {
  rowCount: number;
  pricedRows: number;
  minimumEstimatedCost?: number | null;
};

/** The `sessionDetail.aggregate` args a case wants recorded for assertions. */
export type FakeAggregateQuery = {
  where?: { OR?: unknown };
  _sum?: Record<string, boolean>;
  _count?: Record<string, boolean>;
  _min?: Record<string, boolean>;
};

export type FakeDbOptions = {
  cohortRows: CohortTestRow[];
  baselineRows?: CohortTestRow[];
  baselineSum?: FakeBaselineSum;
  /**
   * ISS-9751: the coverage counters returned by the SAME aggregate as
   * `baselineSum`. Defaults to a fully priced baseline.
   */
  baselineCostCoverage?: FakeBaselineCostCoverage;
  /**
   * What a SEPARATE `sessionDetail.count` statement would return for the
   * unpriced baseline rows. Purely a counterfactual: the coverage verdict must
   * be derived inside the aggregate, so a value here that DISAGREES with
   * `baselineCostCoverage` stages the READ-COMMITTED interleave (a row priced
   * between the two statements) and must not move the verdict.
   */
  racingUnpricedCount?: number;
  // FEA-3633: keyed branch-fallback baseline LOC groups (one per distinct branch,
  // MAX(added+removed) counted once).
  fallbackGroups?: { loc: number | null }[];
  unkeyableFallbackSum?: { loc: number | null };
  /** Org that owns `cohortRows` and `baselineRows`. Defaults to the queried org. */
  organizationId?: string;
  /** Baseline-window rows owned by `FOREIGN_ORG` — never this org's to read. */
  foreignBaselineRows?: CohortTestRow[];
  /** Filled with every `sessionDetail.findMany` args the helper issues. */
  sessionQueries?: FakeSessionQuery[];
  /** ISS-9853: filled with each cohort chunk's `artifactId.in`, in read order. */
  cohortChunkReads?: string[][];
  /** ISS-9853: reject every cohort chunk read after this many have succeeded. */
  rejectCohortChunkAfter?: number;
  /** Filled with every `sessionDetail.count` args the helper issues. */
  countQueries?: FakeCountQuery[];
  /** Filled with every `sessionDetail.aggregate` args the helper issues. */
  aggregateQueries?: FakeAggregateQuery[];
};

/** The `sessionDetail.count` args behind the baseline LOC/$ coverage verdict. */
export type FakeCountQuery = {
  where: {
    artifact?: { organizationId?: string };
    artifactId?: { notIn?: string[] };
    sessionStartedAt?: { gte?: Date; lte?: Date };
    OR?: readonly unknown[];
  };
};

export function row(opts: {
  id: string;
  /** `null` seeds UNMEASURED LOC (both counts null), distinct from a real `0`. */
  loc?: number | null;
  /**
   * `linesRemoved` on its own, so a case can seed the ASYMMETRIC row — one count
   * present, the other null. That row is the only thing telling the AND-of-present
   * measuredness rule apart from a both-null one, and moving the two columns in
   * lockstep would leave that mutation green.
   */
  locRemoved?: number | null;
  locSource?: string | null;
  repositoryFullName?: string | null;
  /** `null` seeds an UNPRICED session; omitted defaults to a measured `$0`. */
  cost?: number | null;
  tokens?: number;
  startedAt?: number;
  mergedPrs?: MergedPr[];
}): CohortTestRow {
  const tokens = opts.tokens ?? 0;
  return {
    artifactId: opts.id,
    // `??` would turn an explicit `null` into the measured `0` this fixture
    // exists to tell apart — same trap as `estimatedCost` below.
    linesAdded: opts.loc === null ? null : (opts.loc ?? 0),
    linesRemoved: fixtureLinesRemoved(opts.loc, opts.locRemoved),
    locSource: opts.locSource ?? null,
    repositoryFullName: opts.repositoryFullName ?? null,
    // `??` would turn an explicit `null` back into the measured `$0` this
    // fixture exists to tell apart.
    estimatedCost: opts.cost === undefined ? 0 : opts.cost,
    inputTokens: BigInt(Math.floor(tokens / 2)),
    outputTokens: BigInt(tokens - Math.floor(tokens / 2)),
    sessionStartedAt: new Date(opts.startedAt ?? 1000),
    artifact: {
      sourceLinks: (opts.mergedPrs ?? []).map((pr, i) => ({
        metadata:
          pr.repo && pr.number != null
            ? {
                linkKind: SessionArtifactLinkKind.SessionPr,
                repositoryFullName: pr.repo,
                prNumber: pr.number,
                relationTypes: [SessionPrRelationType.Created],
              }
            : { linkKind: SessionArtifactLinkKind.SessionPr },
        targetId: `${opts.id}-branch-${i}`,
        target: {
          branch: {
            repository: pr.repo ? { fullName: pr.repo } : null,
            currentPullRequestDetail: {
              number: pr.number,
              prState: GitHubPRState.Merged,
              mergedAt: new Date(2000),
              isCurrent: true,
              lastVerifiedAt: new Date(2100),
              repositoryFullName: pr.repo,
              repository: pr.repo ? { fullName: pr.repo } : null,
            },
          },
          pullRequestDetails: [],
        },
      })),
    },
  };
}

export function cohortPrLink(
  metadata: Record<string, unknown>,
  options: { isCurrent?: boolean; lastVerifiedAt?: Date } = {}
): CohortTestRow["artifact"]["sourceLinks"][number] {
  const detail: CohortTestPrDetail = {
    number: 7,
    prState: GitHubPRState.Merged,
    mergedAt: new Date(2000),
    isCurrent: options.isCurrent ?? true,
    lastVerifiedAt:
      "lastVerifiedAt" in options ? options.lastVerifiedAt : new Date(2100),
    repositoryFullName: "acme/repo",
    repository: { fullName: "acme/repo" },
  };
  return {
    metadata,
    targetId: "branch-reused",
    target: {
      branch: {
        repository: { fullName: "acme/repo" },
        currentPullRequestDetail: detail,
      },
      pullRequestDetails: [detail],
    },
  };
}

/** Build a fake db that routes findMany by `where` shape. */
export function makeFakeDb(opts: FakeDbOptions) {
  const ownerOrg = opts.organizationId ?? ORG;
  let cohortChunkCount = 0;
  return {
    sessionDetail: {
      findMany: vi.fn((args: FakeSessionQuery) => {
        opts.sessionQueries?.push(args);
        const orgFilter = args.where.artifact?.organizationId;
        if (args.where.artifactId?.notIn) {
          return Promise.resolve(
            rowsVisibleToOrgFilter(orgFilter, [
              { organizationId: ownerOrg, rows: opts.baselineRows ?? [] },
              {
                organizationId: FOREIGN_ORG,
                rows: opts.foreignBaselineRows ?? [],
              },
            ])
          );
        }
        const chunkReads = opts.cohortChunkReads;
        if (chunkReads) {
          chunkReads.push(args.where.artifactId?.in ?? []);
        }
        if (opts.rejectCohortChunkAfter !== undefined) {
          cohortChunkCount += 1;
          if (cohortChunkCount > opts.rejectCohortChunkAfter) {
            return Promise.reject(new Error("cohort chunk read failed"));
          }
        }
        // ISS-9853: the cohort read is now a CHUNKED walk, so the fake has to
        // honour `artifactId.in` — a double that replays every seeded row for
        // any chunk cannot tell a walk that covers its input from one that
        // reads the same prefix twice.
        return Promise.resolve(
          rowsVisibleToOrgFilter(orgFilter, [
            { organizationId: ownerOrg, rows: opts.cohortRows },
          ]).filter((seeded) =>
            args.where.artifactId?.in?.includes(seeded.artifactId)
          )
        );
      }),
      // FEA-3633: `computeCohortPerformance` issues TWO aggregate calls:
      //  1. tokens/cost baseline — `where` has NO `locSource` filter;
      //  2. non-fallback LOC baseline — `where.OR` filters locSource (git/null).
      // Fallback LOC is grouped through `$queryRaw` on artifact links below.
      aggregate: vi.fn((args: FakeAggregateQuery) => {
        opts.aggregateQueries?.push(args);
        const sum = opts.baselineSum ?? {
          linesAdded: null,
          linesRemoved: null,
          estimatedCost: null,
          inputTokens: null,
          outputTokens: null,
        };
        const where = args.where ?? {};
        if (where.OR) {
          // Non-fallback LOC baseline (all baseline LOC is non-fallback here).
          return Promise.resolve({
            _sum: {
              linesAdded: sum.linesAdded,
              linesRemoved: sum.linesRemoved,
            },
          });
        }
        // tokens/cost baseline, plus ISS-9751's coverage verdict over the SAME
        // snapshot: `_count` skips nulls exactly as `_sum` does, so the fixture
        // states the window's row count and how many of them were priced.
        const coverage = opts.baselineCostCoverage ?? {
          rowCount: 0,
          pricedRows: 0,
        };
        return Promise.resolve({
          _sum: {
            estimatedCost: sum.estimatedCost,
            inputTokens: sum.inputTokens,
            outputTokens: sum.outputTokens,
          },
          _count: {
            _all: coverage.rowCount,
            estimatedCost: coverage.pricedRows,
          },
          _min: { estimatedCost: coverage.minimumEstimatedCost ?? null },
        });
      }),
      // The retired second statement. Kept purely so a case can stage the
      // interleave it used to lose: production must never consult it, which
      // `countQueries` proves.
      count: vi.fn((args: FakeCountQuery) => {
        opts.countQueries?.push(args);
        return Promise.resolve(opts.racingUnpricedCount ?? 0);
      }),
    },
    // ISS-9114: the unkeyable sum and the keyed per-branch groups come back
    // from ONE statement over a single `fallback_sessions` derivation, as one
    // row carrying the scalar plus the ordered group array.
    $queryRaw: vi.fn().mockResolvedValue([
      {
        unkeyableLoc: (opts.unkeyableFallbackSum ?? { loc: 0n }).loc,
        keyedLocs: (opts.fallbackGroups ?? []).map((group) => group.loc),
      },
    ]),
    // ISS-12435: cohort quality no longer reads judge scores (Loops removed);
    // the fake stays so a case can assert the reader never issues it.
    judgeScore: { aggregate: vi.fn() },
    // A minimal structural fake satisfying only the reads the helper performs.
  } as unknown as Parameters<typeof computeCohortPerformance>[0];
}

/**
 * Prisma constrains a read only by the keys the `where` actually carries, so an
 * ABSENT `artifact.organizationId` is NO constraint and every seeded org's rows
 * come back. Modelling omission as a failed match instead would keep the
 * tenant-boundary cases green under the exact mutation they claim to cover.
 */
function rowsVisibleToOrgFilter(
  orgFilter: string | undefined,
  groups: readonly { organizationId: string; rows: CohortTestRow[] }[]
): CohortTestRow[] {
  return groups.flatMap((group) =>
    orgFilter === undefined || orgFilter === group.organizationId
      ? group.rows
      : []
  );
}

/**
 * A fixture row's `linesRemoved`. Explicit `locRemoved` wins so a case can seed
 * the ASYMMETRIC row (one count present, one null); otherwise it tracks `loc`,
 * so `loc: null` leaves BOTH counts null and `loc: 0` leaves both a measured 0.
 */
function fixtureLinesRemoved(
  loc: number | null | undefined,
  locRemoved: number | null | undefined
): number | null {
  if (locRemoved !== undefined) {
    return locRemoved;
  }
  return loc === null ? null : 0;
}
