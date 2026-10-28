import {
  BranchActivitySource,
  branchActivityAtomProducerValidator,
} from "@repo/api/src/types/branch-activity";
import type { GitHubReadModelPullRequest } from "@repo/api/src/types/github-read-model";
import type { TransactionClient } from "@repo/database";
import { persistedAtomIdentity } from "@/app/branches/branch-activity-evidence";
import {
  buildPullRequestLifecycleActivityRecords,
  type PersistedPullRequestLifecycleActivityAtom,
  resolvePullRequestLifecycleActivityRecordIdentities,
} from "@/app/branches/pull-request-lifecycle-activity";
import { parseNullableDate } from "./backfill-projection-helpers";

type LifecycleProjectionDiff = {
  lifecycleAtomProjectionChangeCount: number;
  branchLastActivityProjectionChangeCount: number;
};

/** Branch fields needed to predict lifecycle aggregate advancement. */
export type LifecycleBranch = {
  artifactId: string;
  branchName: string;
  lastActivityAt: Date | null;
};

/** Persisted PR identity needed to build canonical lifecycle atom keys. */
export type LifecyclePullRequest = {
  id: string;
  number: number;
};

/** Predict atom inserts and monotonic Last-active writes for one bounded payload. */
export async function predictBackfillLifecycleProjectionDiff(
  db: TransactionClient,
  input: {
    organizationId: string;
    pullRequests: readonly GitHubReadModelPullRequest[];
    branches: readonly LifecycleBranch[];
    existingPullRequests: readonly LifecyclePullRequest[];
  }
): Promise<LifecycleProjectionDiff> {
  const branchesByName = new Map(
    input.branches.map((branch) => [branch.branchName, branch])
  );
  const pullRequestsByNumber = new Map(
    input.existingPullRequests.map((pullRequest) => [
      pullRequest.number,
      pullRequest,
    ])
  );
  const persistedAtoms = await loadPersistedLifecycleAtoms(db, input);
  const persistedIdentities = new Set(
    persistedAtoms.map((atom) => persistedAtomIdentity(atom))
  );
  const branchesAdvancingLastActivity = new Set<string>();
  let lifecycleAtomProjectionChangeCount = 0;

  for (const pullRequest of input.pullRequests) {
    const branch = branchesByName.get(pullRequest.headBranch);
    if (!branch) {
      continue;
    }
    const occurrenceDates = lifecycleOccurrenceDates(pullRequest);
    const latestOccurrence = latestDate(occurrenceDates);
    if (
      latestOccurrence &&
      (!branch.lastActivityAt || branch.lastActivityAt < latestOccurrence)
    ) {
      branchesAdvancingLastActivity.add(branch.artifactId);
    }
    const existingPullRequest = pullRequestsByNumber.get(pullRequest.number);
    if (!existingPullRequest) {
      lifecycleAtomProjectionChangeCount += occurrenceDates.length;
      continue;
    }
    const records = resolvePullRequestLifecycleActivityRecordIdentities(
      buildPullRequestLifecycleActivityRecords({
        organizationId: input.organizationId,
        branchArtifactId: branch.artifactId,
        pullRequestDetailId: existingPullRequest.id,
        openedAt: parseNullableDate(pullRequest.openedAt),
        mergedAt: parseNullableDate(pullRequest.mergedAt),
        closedAt: parseNullableDate(pullRequest.closedAt),
      }),
      persistedAtoms
    );
    for (const record of records) {
      const atom = branchActivityAtomProducerValidator.parse(record.atom);
      if (
        !persistedIdentities.has(
          persistedAtomIdentity({
            branchArtifactId: record.branchArtifactId,
            source: atom.source,
            sourceEventId: atom.sourceEventId,
          })
        )
      ) {
        lifecycleAtomProjectionChangeCount += 1;
      }
    }
  }

  return {
    lifecycleAtomProjectionChangeCount,
    branchLastActivityProjectionChangeCount: branchesAdvancingLastActivity.size,
  };
}

function loadPersistedLifecycleAtoms(
  db: TransactionClient,
  input: {
    organizationId: string;
    branches: readonly LifecycleBranch[];
    existingPullRequests: readonly LifecyclePullRequest[];
  }
): Promise<PersistedPullRequestLifecycleActivityAtom[]> {
  if (input.existingPullRequests.length === 0) {
    return Promise.resolve([]);
  }
  return db.branchActivityAtom.findMany({
    where: {
      organizationId: input.organizationId,
      branchArtifactId: {
        in: input.branches.map(({ artifactId }) => artifactId),
      },
      source: BranchActivitySource.PullRequestLifecycle,
      pullRequestDetailId: {
        in: input.existingPullRequests.map(({ id }) => id),
      },
    },
    select: {
      version: true,
      source: true,
      sourceEventId: true,
      occurredAt: true,
      attributionKind: true,
      pullRequestDetailId: true,
      completeness: true,
      branchArtifactId: true,
    },
  });
}

function lifecycleOccurrenceDates(
  pullRequest: GitHubReadModelPullRequest
): Date[] {
  const openedAt = parseNullableDate(pullRequest.openedAt);
  const terminalAt = parseNullableDate(
    pullRequest.mergedAt ?? pullRequest.closedAt
  );
  return [openedAt, terminalAt].filter((date): date is Date => date !== null);
}

function latestDate(dates: readonly Date[]): Date | null {
  return dates.reduce<Date | null>(
    (latest, date) => (!latest || latest < date ? date : latest),
    null
  );
}
