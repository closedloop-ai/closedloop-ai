import { GitHubPRState } from "@repo/api/src/types/github";
import type { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the session→PR-link DB seam so the adapter runs against synthetic
// records without a database. `hasMatchingSessionPrLinks` returns true (there
// are links to read) and `findMergedPrsLinkedToSessions` yields the merged-PR
// rows the test supplies — the ISS-6028 shape: one row per PR, carrying the
// branch artifacts it is current for. `mergedPrIdentity` is the REAL shared
// helper (via importActual) so dedup stays exercised; the merged-PR predicate
// itself now lives in that seam's query and is pinned in session-pr-links.test.
const readRows: MergedPrRow[] = [];
let hasLinks = true;

vi.mock("./session-pr-links", async () => {
  const actual =
    await vi.importActual<typeof import("./session-pr-links")>(
      "./session-pr-links"
    );
  return {
    ...actual,
    hasMatchingSessionPrLinks: vi.fn(() => Promise.resolve(hasLinks)),
    findMergedPrsLinkedToSessions: vi.fn(
      (_organizationId: string, _where: unknown) => Promise.resolve(readRows)
    ),
  };
});

const {
  collectMergedPrsForScope,
  computeDeliveryMetricsFromPrs,
  resolveDeliveryMergeWindow,
} = await import("./agent-session-delivery-metrics");

/**
 * The two production halves composed exactly as `delivery-metrics.ts` composes
 * them: collect the window-independent merged-PR set for `where`, then evaluate it
 * against one `DeliveryWindow`. ISS-5809 split them so the service can evaluate one
 * collected set against two windows, and the review of that split removed the
 * single-call wrapper these cases used to drive. They drive the real seam instead.
 */
async function runDeliveryMetrics(
  where: Parameters<typeof collectMergedPrsForScope>[1],
  costUsd: number | null,
  mergeWindow: Parameters<typeof computeDeliveryMetricsFromPrs>[2]
) {
  return computeDeliveryMetricsFromPrs(
    await collectMergedPrsForScope(ORGANIZATION_ID, where),
    costUsd,
    mergeWindow
  );
}
const { findMergedPrsLinkedToSessions } = await import("./session-pr-links");

const ORGANIZATION_ID = "org-1";

// Epoch-ms anchors for a July 2026 window and PRs on either side of it.
const WINDOW_START = Date.parse("2026-07-01T00:00:00Z");
const WINDOW_END = Date.parse("2026-07-31T23:59:59Z");
const IN_WINDOW_MERGE = new Date("2026-07-15T12:00:00Z");
const BEFORE_WINDOW_MERGE = new Date("2026-06-15T12:00:00Z");
const AFTER_WINDOW_MERGE = new Date("2026-08-15T12:00:00Z");

/** The merged-PR row shape the DB seam returns (ISS-6028). */
type MergedPrRow = {
  number: number | null;
  prState: string;
  mergedAt: Date | null;
  additions: number | null;
  deletions: number | null;
  isCurrent: boolean;
  repositoryFullName: string | null;
  repository: { fullName: string } | null;
  currentForBranches: { artifactId: string }[];
};

type LinkedPr = {
  /** The LINKED branch artifact — `mergedPrIdentity`'s `branch:` fallback. */
  targetId: string;
  number: number | null;
  repositoryFullName: string | null;
  mergedAt: Date | null;
  prState?: string;
  additions?: number | null;
  deletions?: number | null;
  isCurrent?: boolean;
};

/**
 * One merged-PR row as the DB seam returns it: the PR's own scalars plus the
 * branch artifacts it is current for that carry a matching session link.
 * Multiple `targetIds` stand for one PR reached through several linked branches.
 */
function mergedPr(pr: LinkedPr, ...alsoCurrentFor: string[]): MergedPrRow {
  return {
    number: pr.number,
    prState: pr.prState ?? GitHubPRState.Merged,
    mergedAt: pr.mergedAt,
    additions: pr.additions ?? 100,
    deletions: pr.deletions ?? 50,
    isCurrent: pr.isCurrent ?? true,
    repositoryFullName: pr.repositoryFullName,
    repository: pr.repositoryFullName
      ? { fullName: pr.repositoryFullName }
      : null,
    currentForBranches: [pr.targetId, ...alsoCurrentFor].map((artifactId) => ({
      artifactId,
    })),
  };
}

beforeEach(() => {
  readRows.length = 0;
  hasLinks = true;
});

describe("delivery metrics — merge-window bounding (FEA-4295)", () => {
  const where = {} as Prisma.SessionDetailWhereInput;
  const window = { start: WINDOW_START, end: WINDOW_END };

  it("counts a PR merged INSIDE the selected window", async () => {
    readRows.push(
      mergedPr({
        targetId: "branch-a",
        number: 1,
        repositoryFullName: "org/repo",
        mergedAt: IN_WINDOW_MERGE,
      })
    );

    const metrics = await runDeliveryMetrics(where, 10, window);

    expect(metrics.mergedPrCount).toBe(1);
    // LOC/$ is bounded to the same in-window PR set and divides by real cost.
    expect(metrics.mergedLocPerDollar).not.toBeNull();
  });

  it("EXCLUDES a PR merged AFTER the selected window", async () => {
    readRows.push(
      mergedPr({
        targetId: "branch-a",
        number: 1,
        repositoryFullName: "org/repo",
        mergedAt: AFTER_WINDOW_MERGE,
      })
    );

    const metrics = await runDeliveryMetrics(where, 10, window);

    // The PR is linked to a matched session but merged outside the range, so
    // "merged in range" is 0 → null (no data).
    expect(metrics.mergedPrCount).toBeNull();
    expect(metrics.mergedLocPerDollar).toBeNull();
  });

  it("EXCLUDES a PR merged BEFORE the selected window", async () => {
    readRows.push(
      mergedPr({
        targetId: "branch-a",
        number: 1,
        repositoryFullName: "org/repo",
        mergedAt: BEFORE_WINDOW_MERGE,
      })
    );

    const metrics = await runDeliveryMetrics(where, 10, window);

    expect(metrics.mergedPrCount).toBeNull();
  });

  it("counts only the in-window PRs from a mixed set", async () => {
    readRows.push(
      mergedPr({
        targetId: "branch-in",
        number: 1,
        repositoryFullName: "org/repo",
        mergedAt: IN_WINDOW_MERGE,
      }),
      mergedPr({
        targetId: "branch-after",
        number: 2,
        repositoryFullName: "org/repo",
        mergedAt: AFTER_WINDOW_MERGE,
      }),
      mergedPr({
        targetId: "branch-before",
        number: 3,
        repositoryFullName: "org/repo",
        mergedAt: BEFORE_WINDOW_MERGE,
      })
    );

    const metrics = await runDeliveryMetrics(where, 10, window);

    expect(metrics.mergedPrCount).toBe(1);
  });

  it("EXCLUDES a row carrying a null mergedAt (unknown merge instant)", async () => {
    // The query's MERGED_PR_DETAIL_WHERE already excludes a null `mergedAt`
    // (pinned in session-pr-links.test.ts, which replaces the two row-level
    // predicate cases this file used to carry). This pins the collector's own
    // narrow: a row that reached it without a merge instant contributes nothing
    // rather than fabricating one.
    readRows.push(
      mergedPr({
        targetId: "branch-open",
        number: 1,
        repositoryFullName: "org/repo",
        mergedAt: null,
      })
    );

    const metrics = await runDeliveryMetrics(where, 10, window);

    expect(metrics.mergedPrCount).toBeNull();
  });

  it("with a null window counts ALL merged PRs regardless of merge date (all-time)", async () => {
    readRows.push(
      mergedPr({
        targetId: "branch-in",
        number: 1,
        repositoryFullName: "org/repo",
        mergedAt: IN_WINDOW_MERGE,
      }),
      mergedPr({
        targetId: "branch-after",
        number: 2,
        repositoryFullName: "org/repo",
        mergedAt: AFTER_WINDOW_MERGE,
      }),
      mergedPr({
        targetId: "branch-before",
        number: 3,
        repositoryFullName: "org/repo",
        mergedAt: BEFORE_WINDOW_MERGE,
      })
    );

    const metrics = await runDeliveryMetrics(where, 10, null);

    expect(metrics.mergedPrCount).toBe(3);
  });

  it("MEDIAN PR size is bounded to the in-window PRs and reflects their distinct LOC", async () => {
    // Three merged PRs, distinct gross LOC. Two land IN the window (100, 300),
    // one lands AFTER (5000). Bounding to the window drops the 5000-LOC PR, so
    // the median is over {100, 300} = 200 — NOT (100+300+5000)/… nor 300.
    readRows.push(
      mergedPr({
        targetId: "branch-small",
        number: 1,
        repositoryFullName: "org/repo",
        mergedAt: IN_WINDOW_MERGE,
        additions: 60,
        deletions: 40, // gross 100
      }),
      mergedPr({
        targetId: "branch-mid",
        number: 2,
        repositoryFullName: "org/repo",
        mergedAt: new Date("2026-07-20T12:00:00Z"),
        additions: 200,
        deletions: 100, // gross 300
      }),
      mergedPr({
        targetId: "branch-huge-after",
        number: 3,
        repositoryFullName: "org/repo",
        mergedAt: AFTER_WINDOW_MERGE,
        additions: 4000,
        deletions: 1000, // gross 5000 — outside the window, excluded
      })
    );

    const metrics = await runDeliveryMetrics(where, 10, window);

    expect(metrics.mergedPrCount).toBe(2);
    // Median of the two in-window sizes {100, 300} = 200. If the count were right
    // but the median drifted (e.g. still folded the 5000-LOC out-of-window PR),
    // this pins it.
    expect(metrics.medianPrSize).toBe(200);
  });

  it("counts a PR reached through several linked branches ONCE (dedup)", async () => {
    // The SAME PR (org/repo#7) is the current PR of two linked branch artifacts
    // — the PR-side shape of "linked from two sessions". It must be counted once,
    // and its single LOC must drive the median (not doubled).
    readRows.push(
      mergedPr(
        {
          targetId: "branch-shared",
          number: 7,
          repositoryFullName: "org/repo",
          mergedAt: IN_WINDOW_MERGE,
          additions: 150,
          deletions: 50, // gross 200
        },
        "branch-shared-fork"
      )
    );

    const metrics = await runDeliveryMetrics(where, 10, window);

    expect(metrics.mergedPrCount).toBe(1);
    expect(metrics.medianPrSize).toBe(200);
  });

  it("counts two repo-less PRs on distinct branches separately (dedup-by-nullable trap)", async () => {
    // With no repo identity the shared `mergedPrIdentity` falls back to the
    // LINKED branch artifact, so two such PRs must not collapse into one bucket.
    readRows.push(
      mergedPr({
        targetId: "branch-x",
        number: 1,
        repositoryFullName: null,
        mergedAt: IN_WINDOW_MERGE,
      }),
      mergedPr({
        targetId: "branch-y",
        number: 1,
        repositoryFullName: null,
        mergedAt: IN_WINDOW_MERGE,
      })
    );

    const metrics = await runDeliveryMetrics(where, 10, window);

    expect(metrics.mergedPrCount).toBe(2);
  });

  it("includes PRs merged EXACTLY on the inclusive window boundaries (offset-bearing timestamps)", async () => {
    // Both bounds are inclusive. Use timestamps expressed in a non-UTC offset that
    // resolve to the exact window start/end instants, so a subtle exclusive-bound
    // or timezone bug would drop one and undercount.
    readRows.push(
      mergedPr({
        targetId: "branch-at-start",
        number: 1,
        repositoryFullName: "org/repo",
        // 2026-07-01T00:00:00Z expressed as +02:00 wall-clock.
        mergedAt: new Date("2026-07-01T02:00:00+02:00"),
      }),
      mergedPr({
        targetId: "branch-at-end",
        number: 2,
        repositoryFullName: "org/repo",
        // 2026-07-31T23:59:59Z expressed as -05:00 wall-clock.
        mergedAt: new Date("2026-07-31T18:59:59-05:00"),
      })
    );

    const metrics = await runDeliveryMetrics(where, 10, window);

    expect(metrics.mergedPrCount).toBe(2);
  });

  it("observes the SAME PRs differently across two distinct ranges (window is authoritative)", async () => {
    // Two merged PRs linked to the scope: one in June, one in July. The identical
    // row set yields count 1 for a July window and count 1 for a June window,
    // proving the window — not the collected set — decides membership.
    const rows = () => [
      mergedPr({
        targetId: "branch-july",
        number: 1,
        repositoryFullName: "org/repo",
        mergedAt: IN_WINDOW_MERGE, // July
      }),
      mergedPr({
        targetId: "branch-june",
        number: 2,
        repositoryFullName: "org/repo",
        mergedAt: BEFORE_WINDOW_MERGE, // June
      }),
    ];

    readRows.push(...rows());
    const july = await runDeliveryMetrics(where, 10, window);
    expect(july.mergedPrCount).toBe(1);

    readRows.length = 0;
    readRows.push(...rows());
    const juneWindow = {
      start: Date.parse("2026-06-01T00:00:00Z"),
      end: Date.parse("2026-06-30T23:59:59Z"),
    };
    const june = await runDeliveryMetrics(where, 10, juneWindow);
    expect(june.mergedPrCount).toBe(1);
  });

  it("keeps the LOC/$ denominator non-zero for a bounded window (synthetic cost session stays in-window)", async () => {
    readRows.push(
      mergedPr({
        targetId: "branch-in",
        number: 1,
        repositoryFullName: "org/repo",
        mergedAt: IN_WINDOW_MERGE,
        additions: 800,
        deletions: 200,
      })
    );

    const metrics = await runDeliveryMetrics(where, 5, window);

    // ISS-4667: 1000 gross LINES ÷ $5 = 200 LOC/$ (no divide-by-1000). A
    // regression where the synthetic cost carrier fell outside the window would
    // zero the denominator → null.
    expect(metrics.mergedLocPerDollar).toBeCloseTo(200, 5);
  });
});

describe("delivery metrics — scan scoping (ISS-4549 / ISS-6028)", () => {
  const window = { start: WINDOW_START, end: WINDOW_END };

  it("reads merged PRs semi-joined through the links, not the session rows", async () => {
    const where = { userId: "user-1" } as Prisma.SessionDetailWhereInput;
    vi.mocked(findMergedPrsLinkedToSessions).mockClear();
    readRows.push(
      mergedPr({
        targetId: "branch-a",
        number: 1,
        repositoryFullName: "org/repo",
        mergedAt: IN_WINDOW_MERGE,
      })
    );

    await runDeliveryMetrics(where, 10, window);

    // ISS-6028: the scan population is the merged PRs, reached from the PR side
    // with the matched-session `where` carried into the link semi-join —
    // NOT a page-by-page drain of every PR-linked session in the org. The org is
    // passed alongside so the PR-side read is scoped in the statement itself.
    expect(vi.mocked(findMergedPrsLinkedToSessions).mock.calls[0]?.[0]).toBe(
      ORGANIZATION_ID
    );
    expect(vi.mocked(findMergedPrsLinkedToSessions).mock.calls[0]?.[1]).toEqual(
      where
    );
  });

  it("skips the PR read entirely when the scope carries no session→PR links", async () => {
    hasLinks = false;
    vi.mocked(findMergedPrsLinkedToSessions).mockClear();

    const metrics = await runDeliveryMetrics(
      {} as Prisma.SessionDetailWhereInput,
      10,
      window
    );

    expect(vi.mocked(findMergedPrsLinkedToSessions)).not.toHaveBeenCalled();
    expect(metrics.mergedPrCount).toBeNull();
  });
});

describe("resolveDeliveryMergeWindow (FEA-4295)", () => {
  it("returns null when NEITHER bound is set (all-time)", () => {
    expect(resolveDeliveryMergeWindow(undefined, undefined)).toBeNull();
  });

  it("bounds both sides when both dates are set", () => {
    const result = resolveDeliveryMergeWindow(
      "2026-07-01T00:00:00Z",
      "2026-07-31T23:59:59Z"
    );

    expect(result).toEqual({
      start: Date.parse("2026-07-01T00:00:00Z"),
      end: Date.parse("2026-07-31T23:59:59Z"),
    });
  });

  it("leaves the upper side open when only startDate is set", () => {
    const result = resolveDeliveryMergeWindow(
      "2026-07-01T00:00:00Z",
      undefined
    );

    expect(result).toEqual({
      start: Date.parse("2026-07-01T00:00:00Z"),
      end: Number.MAX_SAFE_INTEGER,
    });
  });

  it("leaves the lower side open at 0 when only endDate is set", () => {
    const result = resolveDeliveryMergeWindow(
      undefined,
      "2026-07-31T23:59:59Z"
    );

    expect(result).toEqual({
      start: 0,
      end: Date.parse("2026-07-31T23:59:59Z"),
    });
  });

  it("treats an unparseable bound as absent (degrades to a wider window)", () => {
    expect(resolveDeliveryMergeWindow("not-a-date", "also-bad")).toBeNull();
    expect(
      resolveDeliveryMergeWindow("not-a-date", "2026-07-31T23:59:59Z")
    ).toEqual({
      start: 0,
      end: Date.parse("2026-07-31T23:59:59Z"),
    });
  });
});
