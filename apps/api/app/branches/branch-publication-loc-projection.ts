import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  type BranchMetricLocContribution,
  type BranchMetricLocCoverageGap,
  BranchPublicationLocSource,
} from "@repo/lib/branches/branch-publication-loc";
import {
  isOrgMergedPullRequestDetail,
  type OrgMergedPullRequestAdmissionMap,
} from "@/lib/pull-request-population";
import type { CloudCanonicalMetricRow } from "./branch-canonical-metric-projection";
import type { BranchPushLocAtom } from "./branch-push-loc-read";

/** Normalize complete persisted cloud publication evidence into gross LOC. */
export function cloudPublicationLocEvidence(
  rows: readonly CloudCanonicalMetricRow[],
  orgMergedPullRequestAdmissionByBranchId: OrgMergedPullRequestAdmissionMap
): {
  contributions: BranchMetricLocContribution[];
  coverageGaps: BranchMetricLocCoverageGap[];
  completeBranchIds: string[];
  incompleteBranchIds: string[];
  coverageComplete: boolean;
} {
  const contributions: BranchMetricLocContribution[] = [];
  const coverageGaps: BranchMetricLocCoverageGap[] = [];
  const completeBranchIds: string[] = [];
  const incompleteBranchIds: string[] = [];
  for (const row of rows) {
    const repository = branchRepository(row);
    const atoms = row.branch.pushLocAtoms ?? [];
    const admittedPullRequestContributions = verifiedMergedPullRequestLoc(
      row,
      orgMergedPullRequestAdmissionByBranchId
    );
    const pushContributions = capturedPushLoc(row, repository, atoms);
    // ISS-10009 ruling 3: push evidence is the finer-grained truth, so a merged
    // PR whose head commit a captured push names is dropped rather than summed
    // beside it. The two carry different identities now — a range for the push,
    // a head sha for the PR — so reconciliation can no longer fuse them, and
    // keeping both would double-count the same lines in every fold that sums
    // ALL contributions (`locPerDollar`, and the detail's lifetime total).
    //
    // An UNMEASURED push claims its head too, deliberately. Its lines are
    // unknown, so keeping the PR row beside the branch's other measured pushes
    // would publish a confident total larger than the branch really pushed.
    // Short-with-a-disclosed-gap is the lesser error; inflated is the one this
    // repo treats as worse than incomplete.
    const coveredIdentities = pushedHeadIdentities(repository, atoms);
    const uncoveredPullRequestContributions =
      admittedPullRequestContributions.filter(
        (contribution) =>
          !coveredIdentities.has(contribution.changeIdentity ?? "")
      );
    // If any merged PR is uncovered, fall back to ALL admitted PR diffs and
    // drop the push lane to avoid overlap. A later PR's diff does not include
    // the lines an earlier PR already merged, so retaining only uncovered PRs
    // would lose the covered PRs' lines when their pushes are dropped too.
    const pushEvidenceCoversEveryMergedPullRequest =
      uncoveredPullRequestContributions.length === 0;
    contributions.push(
      ...(pushEvidenceCoversEveryMergedPullRequest
        ? pushContributions
        : admittedPullRequestContributions)
    );
    const rowGaps = [
      ...missingMergedPullRequestGaps(
        row,
        orgMergedPullRequestAdmissionByBranchId,
        admittedPullRequestContributions
      ),
      ...pushLocGaps(row, atoms, admittedPullRequestContributions),
      ...uncoveredMergeFallbackGaps(
        row,
        pushContributions,
        pushEvidenceCoversEveryMergedPullRequest
      ),
    ];
    coverageGaps.push(...rowGaps);
    if (rowGaps.length > 0) {
      incompleteBranchIds.push(row.id);
      continue;
    }
    completeBranchIds.push(row.id);
  }
  return {
    contributions,
    coverageGaps,
    completeBranchIds,
    incompleteBranchIds,
    coverageComplete: incompleteBranchIds.length === 0,
  };
}

/**
 * One contribution per captured push, under the RANGE identity ruling 3 sets.
 *
 * `repo:before..after` rather than `repo:after`: a push and the merged PR whose
 * head it landed used to share `repo:sha` while carrying different lines — an
 * incremental delta against a whole-branch diff — which
 * `reconcileBranchPublicationLoc` reads as a contested change and deletes.
 */
function capturedPushLoc(
  row: CloudCanonicalMetricRow,
  repository: string,
  atoms: readonly BranchPushLocAtom[]
): BranchMetricLocContribution[] {
  return atoms.flatMap((atom) => {
    if (!(validLoc(atom.linesAdded) && validLoc(atom.linesRemoved))) {
      return [];
    }
    return [
      {
        sourceEventId: `push-loc:${atom.sourceEventId}`,
        changeIdentity: pushRangeIdentity(repository, atom),
        branchId: row.id,
        occurredAt: atom.occurredAt.toISOString(),
        additions: atom.linesAdded,
        deletions: atom.linesRemoved,
        source: BranchPublicationLocSource.SuccessfulPush,
      },
    ];
  });
}

/**
 * Every shortfall the push lane can name for one branch, each stamped with the
 * instant it affects so a window it cannot reach stays Complete.
 */
function pushLocGaps(
  row: CloudCanonicalMetricRow,
  atoms: readonly BranchPushLocAtom[],
  pullRequestContributions: readonly BranchMetricLocContribution[]
): BranchMetricLocCoverageGap[] {
  const gaps: BranchMetricLocCoverageGap[] = atoms.flatMap((atom) =>
    validLoc(atom.linesAdded) && validLoc(atom.linesRemoved)
      ? []
      : [
          {
            sourceEventId: `push-loc:${atom.sourceEventId}`,
            occurredAt: atom.occurredAt.toISOString(),
          },
        ]
  );
  // A captured push the read could not place on a sha range. Disclosed on the
  // same footing as an unmeasured one: dropping it silently would let a branch
  // read Complete while that push's lines are missing.
  for (const atom of row.branch.unusablePushLocAtoms ?? []) {
    gaps.push({
      sourceEventId: `push-loc:${atom.sourceEventId}`,
      occurredAt: atom.occurredAt.toISOString(),
    });
  }
  if (row.branch.pushLocEvidenceTruncated) {
    // Unplaceable on purpose: an unread page could hold a push in any window,
    // so `locEvidenceAffectsWindow` must treat it as reaching all of them.
    gaps.push({
      sourceEventId: `push-loc-truncated:${row.id}`,
      occurredAt: null,
    });
  }
  const preCaptureGap = preCapturePushGap(row, atoms);
  if (preCaptureGap) {
    gaps.push(preCaptureGap);
  }
  const uncapturedGap = uncapturedPushGap(row, atoms, pullRequestContributions);
  if (uncapturedGap) {
    gaps.push(uncapturedGap);
  }
  return gaps;
}

/**
 * ISS-10009 ruling 2: no backfill, so a branch whose earliest CAPTURED push
 * post-dates its first push has lines nothing can attribute. Stamped at
 * `firstPushedAt` so only the windows that actually predate capture are
 * disclosed, rather than starring every period the branch appears in.
 *
 * Compared on `occurredAt`, and NOT on the row's server-side `createdAt`, even
 * though `firstPushedAt` is itself server-observed. `createdAt` is stamped when
 * the webhook is persisted, so for a branch whose very first push WAS captured
 * it is always strictly LATER than that push's `firstPushedAt` — the comparison
 * would then fire for every captured branch and star every window forever,
 * which is a disclosure that never clears rather than one that means something.
 *
 * The cost of using `occurredAt` is a known, bounded under-disclosure: it is a
 * git AUTHOR date, so a rebase or amend that carries an old author date onto a
 * captured push can read as "captured before the first push" and silence this
 * gap on a branch whose earliest lines really are missing. That is the lesser
 * error of the two available here, not a property to rely on.
 *
 * The shortfall SPANS `[firstPushedAt, firstCapturedPush)` rather than happening
 * at an instant, so the gap carries both bounds: ruling 2 says pre-capture
 * windows disclose Partial, and a window lying wholly inside that era contains
 * neither bound, so an instant-shaped gap would leave it reading Complete on a
 * period nothing captured.
 */
function preCapturePushGap(
  row: CloudCanonicalMetricRow,
  atoms: readonly BranchPushLocAtom[]
): BranchMetricLocCoverageGap | null {
  const firstPushedAt = row.branch.firstPushedAt;
  // Every captured push bounds the era, INCLUDING one this read could not place
  // on a sha range: capture had started by the time it was written, and it is
  // its own instant's gap that discloses it. Counting only the usable ones would
  // leave the era before an unusable-only branch's single capture undisclosed.
  const capturedAt = [
    ...atoms.map((atom) => atom.occurredAt),
    ...(row.branch.unusablePushLocAtoms ?? []).map((atom) => atom.occurredAt),
  ];
  if (capturedAt.length === 0 || firstPushedAt === null) {
    return null;
  }
  // Folded rather than spread into `Math.min`: a long-lived branch's push
  // history is bounded only by the read cap, and a spread that wide is an
  // argument-count hazard.
  const earliestPushedAt = capturedAt.reduce(
    (oldest, occurredAt) => Math.min(oldest, occurredAt.getTime()),
    Number.POSITIVE_INFINITY
  );
  if (earliestPushedAt <= firstPushedAt.getTime()) {
    return null;
  }
  return {
    sourceEventId: `push-loc-pre-capture:${row.id}`,
    occurredAt: firstPushedAt.toISOString(),
    affectsUntil: new Date(earliestPushedAt).toISOString(),
  };
}

/**
 * A branch known to have been pushed for which capture holds nothing at all.
 *
 * "Nothing at all" counts the unusable atoms too: a branch whose only captured
 * push could not be placed on a sha range HAS been captured, and the era before
 * it is disclosed by {@link preCapturePushGap}'s interval instead.
 *
 * Deliberately UNPLACEABLE. The shortfall runs from `firstPushedAt` with no end
 * — nothing was ever captured for this branch, so no instant closes it — and an
 * interval needs both bounds. Stamped at `firstPushedAt` it would disclose only
 * the one window containing that instant, and every other window would read
 * Complete on a branch whose lines are entirely unknown: exactly the `0` that
 * means "we don't know" that ruling 2 forbids. Every branch pushed before
 * capture began is in this state, so it is the common case, not the edge.
 */
function uncapturedPushGap(
  row: CloudCanonicalMetricRow,
  atoms: readonly BranchPushLocAtom[],
  pullRequestContributions: readonly BranchMetricLocContribution[]
): BranchMetricLocCoverageGap | null {
  if (
    atoms.length > 0 ||
    (row.branch.unusablePushLocAtoms ?? []).length > 0 ||
    row.branch.firstPushedAt === null
  ) {
    return null;
  }
  const currentChangeIdentity = row.branch.headSha
    ? `${branchRepository(row)}:${row.branch.headSha.toLowerCase()}`
    : null;
  if (
    currentChangeIdentity &&
    pullRequestContributions.some(
      (candidate) => candidate.changeIdentity === currentChangeIdentity
    )
  ) {
    return null;
  }
  return { sourceEventId: `successful-push:${row.id}`, occurredAt: null };
}

function missingMergedPullRequestGaps(
  row: CloudCanonicalMetricRow,
  orgMergedPullRequestAdmissionByBranchId: OrgMergedPullRequestAdmissionMap,
  pullRequestContributions: readonly BranchMetricLocContribution[]
): BranchMetricLocCoverageGap[] {
  return row.pullRequestDetails.flatMap((pullRequest) => {
    const mergedAt = pullRequest.mergedAt;
    return isAdmittedOrgMergedPullRequest(
      row,
      pullRequest,
      orgMergedPullRequestAdmissionByBranchId
    ) &&
      mergedAt !== null &&
      !pullRequestContributions.some(
        (contribution) =>
          contribution.sourceEventId === `merged-pr:${pullRequest.id}`
      )
      ? [
          {
            sourceEventId: `merged-pr:${pullRequest.id}`,
            occurredAt: mergedAt.toISOString(),
          },
        ]
      : [];
  });
}

function verifiedMergedPullRequestLoc(
  row: CloudCanonicalMetricRow,
  orgMergedPullRequestAdmissionByBranchId: OrgMergedPullRequestAdmissionMap
): BranchMetricLocContribution[] {
  const branchRepositoryFullName = branchRepository(row);
  return row.pullRequestDetails.flatMap((pullRequest) => {
    const mergedAt = pullRequest.mergedAt;
    const headRepository = normalizeRepoFullName(
      pullRequest.headRepositoryFullName ?? ""
    );
    if (
      !isAdmittedOrgMergedPullRequest(
        row,
        pullRequest,
        orgMergedPullRequestAdmissionByBranchId
      ) ||
      mergedAt === null ||
      pullRequest.headRefOid === null ||
      !SHA_PATTERN.test(pullRequest.headRefOid) ||
      pullRequest.headRefName !== row.branch.branchName ||
      headRepository !== branchRepositoryFullName ||
      !validLoc(pullRequest.additions) ||
      !validLoc(pullRequest.deletions)
    ) {
      return [];
    }
    return [
      {
        sourceEventId: `merged-pr:${pullRequest.id}`,
        changeIdentity: `${branchRepositoryFullName}:${pullRequest.headRefOid.toLowerCase()}`,
        branchId: row.id,
        occurredAt: mergedAt.toISOString(),
        additions: pullRequest.additions,
        deletions: pullRequest.deletions,
        source: BranchPublicationLocSource.MergedPullRequest,
      },
    ];
  });
}

function isAdmittedOrgMergedPullRequest(
  row: CloudCanonicalMetricRow,
  pullRequest: CloudCanonicalMetricRow["pullRequestDetails"][number],
  orgMergedPullRequestAdmissionByBranchId: OrgMergedPullRequestAdmissionMap
): boolean {
  return isOrgMergedPullRequestDetail(
    {
      ...pullRequest,
      repositoryFullName: pullRequest.repositoryFullName ?? null,
      repository: pullRequest.repository ?? null,
      branchArtifact: branchAdmissionSource(row),
    },
    orgMergedPullRequestAdmissionByBranchId
  );
}

function branchRepository(row: CloudCanonicalMetricRow): string {
  return normalizeRepoFullName(
    row.branch.repository?.fullName ?? row.branch.repositoryFullName ?? ""
  );
}

/** The change identity a push contribution reconciles under (ruling 3). */
function pushRangeIdentity(
  repository: string,
  atom: Pick<BranchPushLocAtom, "beforeSha" | "afterSha">
): string {
  return `${repository}:${atom.beforeSha.toLowerCase()}..${atom.afterSha.toLowerCase()}`;
}

/** The merged-PR identities a captured push already accounts for. */
function pushedHeadIdentities(
  repository: string,
  atoms: readonly BranchPushLocAtom[]
): Set<string> {
  return new Set(
    atoms.map((atom) => `${repository}:${atom.afterSha.toLowerCase()}`)
  );
}

function validLoc(value: number | null): value is number {
  return (
    value !== null &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function branchAdmissionSource(row: CloudCanonicalMetricRow): {
  id: string;
  _count: { pullRequestDetails: number };
} {
  return {
    id: row.id,
    _count: row._count,
  };
}

/**
 * The shortfall a merged-PR fallback leaves behind.
 *
 * Falling back drops measured push contributions, and a push outside the PR's
 * range — anything pushed after the merge — goes with them. Deliberately
 * unplaceable: the dropped pushes can sit in any window, so a stamped instant
 * would leave the rest of them reading Complete on a total they are missing
 * from. Silent on a branch that had no push contributions to drop, because
 * nothing was then given up.
 */
function uncoveredMergeFallbackGaps(
  row: CloudCanonicalMetricRow,
  pushContributions: readonly BranchMetricLocContribution[],
  pushEvidenceCoversEveryMergedPullRequest: boolean
): BranchMetricLocCoverageGap[] {
  if (
    pushEvidenceCoversEveryMergedPullRequest ||
    pushContributions.length === 0
  ) {
    return [];
  }
  return [
    {
      sourceEventId: `push-loc-uncovered-merge:${row.id}`,
      occurredAt: null,
    },
  ];
}
