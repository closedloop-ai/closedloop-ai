import { LinkType } from "@repo/api/src/types/artifact";
import { GitHubInstallationStatus } from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { createDbFanoutLimiter, mapWithDbConcurrency } from "@/lib/db-fanout";
import {
  PULL_REQUEST_LABEL_SOURCE_SELECT,
  type PullRequestLabelSourceRow,
  resolvePullRequestLabelSource,
} from "@/lib/github/pull-request-label-source";
import { syncPullRequestLabelsFromArtifactTags } from "@/lib/github/pull-request-label-sync";

/**
 * ISS-4760: converge a linked pull request's GitHub labels when the implementing
 * artifact's TAGS change in Closedloop.
 *
 * Label propagation used to run at two moments only — link/PR-create time, and
 * the `pull_request` webhook's opened/edited/reopened linkage actions. Adding or
 * removing a tag in Closedloop fires neither, so a tag applied after the link
 * existed sat un-propagated until somebody happened to edit or reopen the PR on
 * GitHub.
 *
 * Posture, matching the existing reconcile:
 *  - **Additive.** It reuses `reconcilePullRequestLabels`, which computes
 *    additions only. Removing a tag in Closedloop therefore does NOT strip the
 *    label from GitHub — a label a human added by hand is never clobbered, and
 *    that is the deliberate product choice, not an oversight. A removal still
 *    reconciles because the artifact's OTHER tags may need applying.
 *  - **One shared bound.** Every DB read this pass issues — target resolution
 *    AND the per-PR label sync — runs through ONE `createDbFanoutLimiter()`, so
 *    a batch of artifacts cannot stack limiters into a multiple of the
 *    documented bound (FEA-3299: one fan-out may spend at most half the pool).
 *    The two levels run in SEQUENCE rather than nested, because handing the same
 *    limiter to a fan-out nested inside a task that already holds one of its
 *    slots deadlocks as soon as the outer level fills it.
 *  - **Never silently partial.** The pass pages through the full linked-PR set
 *    rather than reading one bounded page and dropping the rest forever. When
 *    the absolute ceiling does bind, the outcome says so (`Partial` +
 *    `truncated`) instead of reporting a success that quietly means "the first
 *    20"; a retry then converges the remainder.
 *  - **Fail-open.** A GitHub or DB failure must never fail the tag mutation the
 *    user actually asked for; every path here resolves.
 */

/**
 * Absolute ceiling on how many linked pull requests ONE pass will reconcile.
 * A tag change is a small user gesture; it must not turn into an unbounded
 * GitHub write storm because an artifact accumulated a long branch history.
 * Reaching it is REPORTED (`truncated`), never silently swallowed.
 */
const MAX_RECONCILED_PULL_REQUESTS = 100;

/** How many PR-detail rows one paged read fetches. */
const PULL_REQUEST_PAGE_SIZE = 25;

export const ArtifactLabelReconciliationStatus = {
  /** Every linked pull request in scope reconciled. */
  Complete: "complete",
  /**
   * Some work did not land — the ceiling bound the pass, or an individual pull
   * request failed. Retrying is safe and converges the remainder;
   * reconciliation is idempotent and additive.
   */
  Partial: "partial",
  /** The pass could not run at all (the target read failed). Retryable. */
  Failed: "failed",
} as const;
export type ArtifactLabelReconciliationStatus =
  (typeof ArtifactLabelReconciliationStatus)[keyof typeof ArtifactLabelReconciliationStatus];

export type ArtifactLabelReconciliationOutcome = {
  status: ArtifactLabelReconciliationStatus;
  /** Pull requests this pass reconciled. */
  reconciledCount: number;
  /** Pull requests this pass attempted and failed. Excludes ceiling cut-offs. */
  failedCount: number;
  /**
   * True when the ceiling bound the pass, so linked pull requests remain
   * unreconciled. The exact remainder is deliberately not claimed — paging
   * stops at the ceiling, so counting it would mean another unbounded read.
   */
  truncated: boolean;
};

/**
 * Reconcile every pull request whose label source is `artifactId`. Resolves
 * quietly on any failure — callers invoke this AFTER their authoritative tag
 * write has committed, so a throw here would turn a succeeded mutation into a
 * 5xx.
 */
export async function reconcileLinkedPullRequestLabelsForArtifact(input: {
  organizationId: string;
  artifactId: string;
}): Promise<ArtifactLabelReconciliationOutcome> {
  return await reconcileLinkedPullRequestLabelsForArtifacts({
    organizationId: input.organizationId,
    artifactIds: [input.artifactId],
  });
}

/**
 * Reconcile a batch of artifacts under ONE concurrency budget. Used by the
 * batch tag-apply path so tagging 50 artifacts at once cannot fan out
 * per-artifact without a ceiling — and, unlike the previous `.slice(0, 20)`,
 * without permanently dropping the artifacts past it.
 */
export async function reconcileLinkedPullRequestLabelsForArtifacts(input: {
  organizationId: string;
  artifactIds: readonly string[];
}): Promise<ArtifactLabelReconciliationOutcome> {
  const unique = [...new Set(input.artifactIds)];
  if (unique.length === 0) {
    return emptyOutcome();
  }

  // ONE limiter for the whole pass, shared by both levels below.
  const limiter = createDbFanoutLimiter();
  try {
    // Level 1 — resolve targets, bounded by the shared limiter.
    const loaded = await mapWithDbConcurrency(
      unique,
      (artifactId) =>
        loadLinkedPullRequestTargets({
          organizationId: input.organizationId,
          artifactId,
        }),
      limiter
    );

    const { targets, truncated } = collectTargets(loaded);
    if (targets.length === 0) {
      return {
        ...emptyOutcome(),
        truncated,
        status: outcomeStatus(truncated, 0),
      };
    }

    // Level 2 — one FLAT fan-out over every target, under the same limiter.
    const failedCount = await syncTargets({
      organizationId: input.organizationId,
      targets,
      limiter,
    });

    if (truncated) {
      log.warn("[artifactTagLabels] Reconciliation stopped at the ceiling", {
        organizationId: input.organizationId,
        artifactIds: unique,
        reconciledCount: targets.length,
        ceiling: MAX_RECONCILED_PULL_REQUESTS,
      });
    }
    return {
      status: outcomeStatus(truncated, failedCount),
      reconciledCount: targets.length - failedCount,
      failedCount,
      truncated,
    };
  } catch (error) {
    log.warn("[artifactTagLabels] Reconciliation after tag change failed", {
      artifactIds: unique,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ...emptyOutcome(),
      status: ArtifactLabelReconciliationStatus.Failed,
    };
  }
}

type LinkedPullRequestTarget = {
  /** `PullRequestDetail.id` — the row's non-nullable primary key. */
  pullRequestDetailId: string;
  projectId: string;
  /** The artifact whose tags become this PR's labels (ISS-4760 identity). */
  labelSourceArtifactId: string;
  installationId: string;
  owner: string;
  repo: string;
  pullNumber: number;
};

type LoadedTargets = {
  targets: LinkedPullRequestTarget[];
  truncated: boolean;
};

/**
 * Apply the label sync to every target, returning how many failed.
 *
 * Per-target tolerance is deliberate: `mapWithDbConcurrency` is fail-fast, so
 * without the inner guard one bad pull request would abandon every other pull
 * request the user's tag change was supposed to converge.
 */
async function syncTargets(input: {
  organizationId: string;
  targets: readonly LinkedPullRequestTarget[];
  limiter: ReturnType<typeof createDbFanoutLimiter>;
}): Promise<number> {
  let failedCount = 0;
  await mapWithDbConcurrency(
    input.targets,
    async (target) => {
      try {
        await syncPullRequestLabelsFromArtifactTags({
          organizationId: input.organizationId,
          projectId: target.projectId,
          artifactId: target.labelSourceArtifactId,
          installationId: target.installationId,
          owner: target.owner,
          repo: target.repo,
          pullNumber: target.pullNumber,
        });
      } catch (error) {
        failedCount++;
        log.warn("[artifactTagLabels] Pull request did not reconcile", {
          pullRequestDetailId: target.pullRequestDetailId,
          artifactId: target.labelSourceArtifactId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    input.limiter
  );
  return failedCount;
}

/**
 * Flatten per-artifact target sets into one deduped list, clamped to the pass
 * ceiling. One PR-detail row is reachable from several artifacts in a batch (an
 * issue and its plan both resolve to it), so dedupe on the row's primary key —
 * `githubId`/`repositoryId` are both NULLABLE for desktop-produced rows and
 * would silently collapse distinct PRs or double-count one.
 */
function collectTargets(loaded: readonly LoadedTargets[]): LoadedTargets {
  const seen = new Set<string>();
  const targets: LinkedPullRequestTarget[] = [];
  let truncated = loaded.some((entry) => entry.truncated);
  for (const entry of loaded) {
    for (const target of entry.targets) {
      if (seen.has(target.pullRequestDetailId)) {
        continue;
      }
      seen.add(target.pullRequestDetailId);
      if (targets.length >= MAX_RECONCILED_PULL_REQUESTS) {
        truncated = true;
        continue;
      }
      targets.push(target);
    }
  }
  return { targets, truncated };
}

/**
 * Resolve the App-installed pull requests whose label source is this artifact,
 * paging through the FULL set rather than reading one bounded page.
 *
 * The query selects PR-detail ROWS rather than walking artifact links and
 * collecting whatever PR each one reaches: one artifact can produce several
 * branch artifacts, and a PR-detail row is reachable through both its
 * branch-owned and its legacy PR-owned artifact. `PullRequestDetail.id` is the
 * row's non-nullable primary key, so selecting rows directly makes the result
 * inherently one-per-PR.
 *
 * Candidate selection is deliberately a SUPERSET — a link owned by this
 * artifact, or owned by an artifact this artifact produces — and the real
 * decision is made per row by `resolvePullRequestLabelSource`, the same helper
 * the webhook path uses. That single identity is what stops the two paths from
 * labelling one pull request out of two different documents.
 */
async function loadLinkedPullRequestTargets(input: {
  organizationId: string;
  artifactId: string;
}): Promise<LoadedTargets> {
  const targets: LinkedPullRequestTarget[] = [];
  let cursor: string | null = null;

  while (targets.length < MAX_RECONCILED_PULL_REQUESTS) {
    const rows = await readPullRequestPage({ ...input, cursor });
    for (const row of rows) {
      const target = toTarget(row);
      if (target) {
        targets.push(target);
      }
    }
    if (rows.length < PULL_REQUEST_PAGE_SIZE) {
      return { targets, truncated: false };
    }
    cursor = rows.at(-1)?.id ?? null;
    if (!cursor) {
      return { targets, truncated: false };
    }
  }
  return { targets, truncated: true };
}

type PullRequestDetailRow = {
  id: string;
  number: number;
  artifact: PullRequestLabelSourceRow | null;
  branchArtifact: PullRequestLabelSourceRow | null;
  repository: {
    owner: string;
    name: string;
    installation: { installationId: string };
  } | null;
};

async function readPullRequestPage(input: {
  organizationId: string;
  artifactId: string;
  cursor: string | null;
}): Promise<PullRequestDetailRow[]> {
  const linkedSide = {
    organizationId: input.organizationId,
    targetLinks: { some: producesLinkFilter(input.artifactId) },
  };
  return await withDb((db) =>
    db.pullRequestDetail.findMany({
      where: {
        organizationId: input.organizationId,
        // BOTH supported ownership shapes, exactly like the webhook path.
        // Restricting to `branchArtifact` excluded every pre-branch-first row
        // whose PRODUCES link hangs off the legacy `artifact` relation.
        OR: [{ branchArtifact: linkedSide }, { artifact: linkedSide }],
        // Only App-installed repositories can be labelled: the cloud path
        // authenticates as the installation. A desktop-produced row with no
        // installation simply has no way to write, so it is not a target.
        repository: {
          removedAt: null,
          installation: {
            organizationId: input.organizationId,
            status: GitHubInstallationStatus.Active,
          },
        },
      },
      select: {
        id: true,
        number: true,
        artifact: { select: PULL_REQUEST_LABEL_SOURCE_SELECT },
        branchArtifact: { select: PULL_REQUEST_LABEL_SOURCE_SELECT },
        repository: {
          select: {
            owner: true,
            name: true,
            installation: { select: { installationId: true } },
          },
        },
      },
      orderBy: { id: "asc" },
      take: PULL_REQUEST_PAGE_SIZE,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    })
  );
}

/**
 * A PRODUCES link owned by this artifact, OR owned by an artifact this artifact
 * produces. The second arm is what makes an issue's tag change reach the pull
 * requests whose link the PLAN owns — the split the link-PR dialog creates with
 * `linkSourceArtifactId` (plan) vs `sourceArtifactId` (issue).
 */
function producesLinkFilter(artifactId: string) {
  return {
    linkType: LinkType.Produces,
    OR: [
      { sourceId: artifactId },
      {
        source: {
          targetLinks: {
            some: { linkType: LinkType.Produces, sourceId: artifactId },
          },
        },
      },
    ],
  };
}

function toTarget(row: PullRequestDetailRow): LinkedPullRequestTarget | null {
  const source = resolvePullRequestLabelSource(row);
  const installationId = row.repository?.installation.installationId;
  const owner = row.repository?.owner;
  const repo = row.repository?.name;
  if (!(source && installationId && owner && repo)) {
    return null;
  }
  return {
    pullRequestDetailId: row.id,
    projectId: source.projectId,
    labelSourceArtifactId: source.artifactId,
    installationId,
    owner,
    repo,
    pullNumber: row.number,
  };
}

function emptyOutcome(): ArtifactLabelReconciliationOutcome {
  return {
    status: ArtifactLabelReconciliationStatus.Complete,
    reconciledCount: 0,
    failedCount: 0,
    truncated: false,
  };
}

function outcomeStatus(
  truncated: boolean,
  failedCount: number
): ArtifactLabelReconciliationStatus {
  if (truncated || failedCount > 0) {
    return ArtifactLabelReconciliationStatus.Partial;
  }
  return ArtifactLabelReconciliationStatus.Complete;
}
