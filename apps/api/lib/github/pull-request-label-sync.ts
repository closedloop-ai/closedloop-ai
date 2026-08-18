import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import {
  mapTagsToPullRequestLabels,
  type PullRequestLabelMapping,
} from "@repo/api/src/types/pull-request-label";
import {
  emptyPullRequestLabelSyncResult,
  type PullRequestLabelSyncResult,
  PullRequestLabelSyncStatus,
} from "@repo/api/src/types/pull-request-label-sync-status";
import { withDb } from "@repo/database";
import { getInstallationOctokit } from "@repo/github/installation-auth";
import { reconcilePullRequestLabels } from "@repo/github/pull-request-labels";
import { log } from "@repo/observability/log";

/**
 * ISS-4664: propagate an implementing artifact's Closedloop tags onto its pull
 * request as GitHub labels.
 *
 * Best-effort by contract: labelling a PR must never fail PR creation, PR
 * linking, webhook processing, or a tag mutation. Every failure path returns a
 * `Failed` result and logs; nothing throws to the caller by design.
 *
 * Both current callers nonetheless wrap the call, and that is deliberate rather
 * than redundant: each invokes this AFTER its authoritative write has already
 * committed, where a throw would turn a succeeded write into a 5xx (and, on the
 * webhook path, make GitHub re-deliver work it already applied). The guard is
 * structural — it keeps that contract true even if the no-throw handling below
 * ever regresses. A new caller on a response path should do the same; a caller
 * that can safely propagate need not.
 */

/**
 * ISS-4759: the artifact subtypes whose tags may become GitHub labels. Mirrors
 * the set `branchService.upsertBranchArtifact` already accepts as a produces-link
 * owner, so the tag source and the link owner are held to one standard.
 */
export const PULL_REQUEST_LABEL_SOURCE_SUBTYPES = [
  ArtifactSubtype.Prd,
  ArtifactSubtype.ImplementationPlan,
  ArtifactSubtype.Feature,
] as const;

export type ArtifactPullRequestLabelSyncInput = {
  organizationId: string;
  /**
   * ISS-4759: the project the PR is being linked within. The tag source must
   * belong to it — org scoping alone let any same-org uuid paint its taxonomy
   * onto this repository's pull request.
   */
  projectId: string;
  /** The artifact whose tags are the source of truth (the ISS/FEATURE row). */
  artifactId: string;
  /** GitHub App installation that owns the repository. */
  installationId: string;
  owner: string;
  repo: string;
  pullNumber: number;
};

/**
 * Read a VALIDATED artifact's tags and turn them into GitHub label specs.
 *
 * Returns `null` when the artifact is not a legitimate label source for this
 * project — a different project's artifact, a non-DOCUMENT, or a subtype that
 * does not implement work (ISS-4759). `null` means "make no GitHub call", which
 * is materially different from "this artifact has no tags".
 *
 * Exported so callers can skip the GitHub round-trip on an untagged artifact
 * without duplicating either the validation or the mapping.
 */
export async function resolveArtifactTagLabels(input: {
  organizationId: string;
  projectId: string;
  artifactId: string;
}): Promise<PullRequestLabelMapping | null> {
  const source = await withDb((db) =>
    db.artifact.findFirst({
      where: {
        id: input.artifactId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        type: ArtifactType.Document,
        subtype: { in: [...PULL_REQUEST_LABEL_SOURCE_SUBTYPES] },
      },
      select: { id: true },
    })
  );
  if (!source) {
    return null;
  }

  const rows = await withDb((db) =>
    db.tagArtifact.findMany({
      where: {
        artifactId: input.artifactId,
        tag: { organizationId: input.organizationId },
      },
      select: { tag: { select: { name: true, color: true } } },
      // Stable ordering is load-bearing, not cosmetic: it decides WHICH tags win
      // when an artifact exceeds the label ceiling (ISS-4762).
      orderBy: { tag: { name: "asc" } },
    })
  );
  return mapTagsToPullRequestLabels(rows.map((row) => row.tag));
}

/**
 * Apply every tag on `artifactId` to the given pull request as a GitHub label,
 * creating labels the repository does not have yet. Idempotent and additive —
 * manually-added labels are never removed.
 */
export async function syncPullRequestLabelsFromArtifactTags(
  input: ArtifactPullRequestLabelSyncInput
): Promise<PullRequestLabelSyncResult> {
  try {
    const mapping = await resolveArtifactTagLabels({
      organizationId: input.organizationId,
      projectId: input.projectId,
      artifactId: input.artifactId,
    });
    // ISS-4759: an unvalidated source never reaches GitHub. Reported as its own
    // status rather than `Failed` so a caller can tell a rejected input (retry
    // will never help) from a provider problem (retry might).
    if (mapping === null) {
      log.warn("[pullRequestLabelSync] Rejected tag source for PR labels", {
        artifactId: input.artifactId,
        projectId: input.projectId,
        owner: input.owner,
        repo: input.repo,
        pullNumber: input.pullNumber,
      });
      return emptyPullRequestLabelSyncResult(
        PullRequestLabelSyncStatus.SourceRejected
      );
    }

    if (mapping.droppedTagNames.length > 0) {
      // ISS-4762: past the ceiling the pass CANNOT converge, so say so loudly
      // here (where the artifact id is known) rather than returning a success
      // that quietly means "most of them".
      log.warn(
        "[pullRequestLabelSync] Tag count exceeds the PR label ceiling",
        {
          artifactId: input.artifactId,
          owner: input.owner,
          repo: input.repo,
          pullNumber: input.pullNumber,
          appliedLabelCount: mapping.labels.length,
          droppedLabels: mapping.droppedTagNames,
        }
      );
    }

    if (mapping.labels.length === 0) {
      return {
        ...emptyPullRequestLabelSyncResult(PullRequestLabelSyncStatus.NoOp),
        droppedLabels: mapping.droppedTagNames,
      };
    }

    const octokit = await getInstallationOctokit(input.installationId);
    const result = await reconcilePullRequestLabels(
      octokit,
      {
        owner: input.owner,
        repo: input.repo,
        pullNumber: input.pullNumber,
      },
      mapping.labels
    );

    if (result.status === PullRequestLabelSyncStatus.Applied) {
      log.info("[pullRequestLabelSync] Applied artifact tags as PR labels", {
        artifactId: input.artifactId,
        owner: input.owner,
        repo: input.repo,
        pullNumber: input.pullNumber,
        createdLabelCount: result.createdLabels.length,
        addedLabelCount: result.addedLabels.length,
      });
    }
    // The ceiling drop belongs to the mapping, not to the provider pass, so
    // merge it in rather than letting a clean GitHub call erase it.
    return { ...result, droppedLabels: mapping.droppedTagNames };
  } catch (error) {
    log.warn("[pullRequestLabelSync] Label propagation failed", {
      artifactId: input.artifactId,
      owner: input.owner,
      repo: input.repo,
      pullNumber: input.pullNumber,
      error: error instanceof Error ? error.message : String(error),
    });
    return emptyPullRequestLabelSyncResult(PullRequestLabelSyncStatus.Failed);
  }
}
