import type {
  PullRequest,
  PullRequestClosedEvent,
  PullRequestConvertedToDraftEvent,
  PullRequestEditedEvent,
  PullRequestOpenedEvent,
  PullRequestReadyForReviewEvent,
  PullRequestReopenedEvent,
  PullRequestSynchronizeEvent,
} from "@octokit/webhooks-types";
import {
  type Artifact,
  ArtifactStatus,
  ArtifactType,
} from "@repo/api/src/types/artifact";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import {
  ExternalLinkType,
  type PullRequestMetadata,
} from "@repo/api/src/types/external-link";
import { FeatureStatus } from "@repo/api/src/types/feature";
import { GitHubPRState } from "@repo/api/src/types/github";
import type { TransactionClient } from "@repo/database";
import { ChecksStatus, WorkstreamType, withDb } from "@repo/database";
import { parsePlanReferences } from "@repo/github/plan-reference-parser";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { generateSlug, SlugPrefix } from "@/lib/slug-generator";

/**
 * Actions this handler processes. All other actions are ignored with an early return.
 * GitHub sends many PR action types (labeled, assigned, etc.)
 * that we don't process.
 */
const HANDLED_ACTIONS = new Set([
  "opened",
  "edited",
  "closed",
  "reopened",
  "synchronize",
  "converted_to_draft",
  "ready_for_review",
]);

/** Actions that trigger plan reference parsing and linkage. */
const LINKAGE_ACTIONS = new Set(["opened", "edited", "reopened"]);

/**
 * Union type for pull request events we handle.
 */
export type HandledPullRequestEvent =
  | PullRequestOpenedEvent
  | PullRequestEditedEvent
  | PullRequestClosedEvent
  | PullRequestReopenedEvent
  | PullRequestSynchronizeEvent
  | PullRequestConvertedToDraftEvent
  | PullRequestReadyForReviewEvent;

/** Parse a nullable ISO date string, falling back to current time if null. */
function parseDateOrNow(value: string | null): Date {
  return value ? new Date(value) : new Date();
}

/**
 * Handle GitHub pull_request webhook events.
 *
 * Supported lifecycle actions:
 * - opened: Parse plan references from title/body, link PR to plan artifact
 * - edited: Parse plan references from title/body, link PR to plan artifact (if not already linked)
 * - closed: Updates state to MERGED (if merged) or CLOSED, creates corresponding workstream event
 * - reopened: Updates state to OPEN, clears closedAt; also re-checks plan references
 * - synchronize: Updates head SHA when PR is updated with new commits
 * - converted_to_draft: Sets isDraft to true
 * - ready_for_review: Sets isDraft to false
 *
 * Other GitHub PR action types (for future reference):
 * - labeled/unlabeled: Labels added/removed
 * - assigned/unassigned: Assignees changed
 * - review_requested/review_request_removed: Reviewers changed
 * - auto_merge_enabled/auto_merge_disabled: Auto-merge toggled
 * - locked/unlocked: Conversation locked/unlocked
 * - milestoned/demilestoned: Milestone changed
 * - enqueued/dequeued: Merge queue operations
 */
export async function handlePullRequest(
  event: HandledPullRequestEvent
): Promise<Response> {
  const { action, pull_request, repository } = event;

  // Early exit for unhandled actions
  if (!HANDLED_ACTIONS.has(action)) {
    log.info("[handlePullRequest] Skipping unhandled action", {
      action,
      prNumber: pull_request.number,
      repositoryFullName: repository.full_name,
    });
    return NextResponse.json({
      message: `Ignoring unhandled pull_request action: ${action}`,
      ok: true,
    });
  }

  log.info("[handlePullRequest] Processing pull_request event", {
    action,
    prNumber: pull_request.number,
    prTitle: pull_request.title,
    prState: pull_request.state,
    isDraft: pull_request.draft,
    merged: "merged" in pull_request ? pull_request.merged : undefined,
    repositoryId: repository.id,
  });

  await withDb.tx(async (tx) => {
    // Step 1: Find GitHubInstallationRepository by githubRepoId
    const repo = await tx.gitHubInstallationRepository.findFirst({
      where: { githubRepoId: String(repository.id) },
      select: {
        id: true,
        installation: {
          select: { organizationId: true },
        },
      },
    });

    if (!repo) {
      log.warn("[handlePullRequest] Repository not found in database", {
        githubRepoId: repository.id,
        repositoryFullName: repository.full_name,
        action,
        prNumber: pull_request.number,
      });
      return;
    }

    // Step 2: Find GitHubPullRequest by repositoryId + number
    const existingPr = await tx.gitHubPullRequest.findUnique({
      where: {
        repositoryId_number: {
          repositoryId: repo.id,
          number: pull_request.number,
        },
      },
      select: {
        id: true,
        workstreamId: true,
        artifactId: true,
        checksStatus: true,
        artifact: { select: { slug: true } },
      },
    });

    // For linkage actions, attempt plan reference linking even if PR doesn't exist yet
    if (LINKAGE_ACTIONS.has(action)) {
      await attemptPlanLinkage(tx, pull_request, repo, existingPr);
    }

    if (!existingPr) {
      if (!LINKAGE_ACTIONS.has(action)) {
        log.warn("[handlePullRequest] Pull request not found in database", {
          repositoryId: repo.id,
          prNumber: pull_request.number,
          action,
          reason: "PR may have been created outside Symphony workflow",
        });
      }
      return;
    }

    await applyPrAction(tx, action, event, existingPr, pull_request);
  });

  log.info("[handlePullRequest] Successfully processed pull_request event", {
    action,
    prNumber: pull_request.number,
    githubRepoId: repository.id,
  });

  return NextResponse.json({
    message: "Event processed successfully",
    ok: true,
  });
}

type RepoWithInstallation = {
  id: string;
  installation: { organizationId: string | null };
};

type ExistingPr = {
  id: string;
  workstreamId: string;
  artifactId: string | null;
  checksStatus: string;
  artifact: { slug: string } | null;
};

/**
 * Attempt to link a PR to a plan artifact based on plan references in title/body.
 * Handles both existing PRs (edit/reopen) and new PRs (opened).
 */
async function attemptPlanLinkage(
  tx: TransactionClient,
  pull_request: HandledPullRequestEvent["pull_request"],
  repo: RepoWithInstallation,
  existingPr: ExistingPr | null
): Promise<void> {
  if (existingPr?.artifactId) {
    log.info(
      "[handlePullRequest] PR already linked to artifact, skipping linkage",
      {
        prNumber: pull_request.number,
        existingArtifactId: existingPr.artifactId,
      }
    );
    return;
  }

  const organizationId = repo.installation.organizationId;
  if (!organizationId) {
    log.warn(
      "[handlePullRequest] Installation has no organizationId, skipping linkage",
      {
        prNumber: pull_request.number,
      }
    );
    return;
  }

  // Parse plan references from title and body
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL;
  const refs = parsePlanReferences(
    pull_request.title,
    pull_request.body,
    appBaseUrl
  );

  if (refs.length === 0) {
    return;
  }

  // Use first match (title precedence, then first in body)
  const firstRef = refs[0];

  log.info("[handlePullRequest] Found plan reference in PR", {
    prNumber: pull_request.number,
    slug: firstRef.slug,
    matchType: firstRef.matchType,
    source: firstRef.source,
  });

  // Look up artifact by (organizationId, slug)
  const artifact = await tx.artifact.findUnique({
    where: {
      organizationId_slug: {
        organizationId,
        slug: firstRef.slug,
      },
    },
    select: {
      id: true,
      type: true,
      title: true,
      organizationId: true,
      projectId: true,
      workstreamId: true,
      assigneeId: true,
      createdById: true,
      slug: true,
    },
  });

  // AC-006: Invalid slug — do not fail, just skip
  if (!artifact) {
    log.warn("[handlePullRequest] Artifact not found for plan reference", {
      prNumber: pull_request.number,
      slug: firstRef.slug,
      organizationId,
    });
    return;
  }

  // AC-007: Only link IMPLEMENTATION_PLAN artifacts
  if (artifact.type !== ArtifactType.ImplementationPlan) {
    log.info(
      "[handlePullRequest] Artifact is not an implementation plan, skipping",
      {
        prNumber: pull_request.number,
        slug: firstRef.slug,
        artifactType: artifact.type,
      }
    );
    return;
  }

  // Resolve workstreamId: prefer artifact's, then existing PR's, or auto-create
  let workstreamId: string | null | undefined =
    artifact.workstreamId ?? existingPr?.workstreamId;
  if (!workstreamId) {
    workstreamId = await autoCreateWorkstream(tx, artifact, organizationId);
    if (!workstreamId) {
      log.warn(
        "[handlePullRequest] Cannot link PR — no workstreamId and cannot auto-create (missing projectId)",
        {
          prNumber: pull_request.number,
          slug: firstRef.slug,
          artifactId: artifact.id,
        }
      );
      return;
    }
  }

  if (existingPr) {
    // Update existing PR with artifactId
    await linkExistingPrToArtifact(
      tx,
      existingPr,
      artifact,
      workstreamId,
      pull_request
    );
  } else {
    // Create new PR record and link it
    await createAndLinkPr(
      tx,
      repo,
      artifact,
      organizationId,
      workstreamId,
      pull_request
    );
  }
}

/**
 * Auto-create a workstream for an artifact that lacks one.
 * Follows the same pattern as artifactsService.findOrCreateWorkstream.
 * Returns the new workstreamId, or null if the artifact has no projectId.
 */
async function autoCreateWorkstream(
  tx: TransactionClient,
  artifact: Pick<
    Artifact,
    | "id"
    | "title"
    | "organizationId"
    | "projectId"
    | "assigneeId"
    | "createdById"
    | "slug"
  >,
  organizationId: string
): Promise<string | null> {
  if (!artifact.projectId) {
    return null;
  }

  const slug = await generateSlug(organizationId, SlugPrefix.Workstream);

  const workstream = await tx.workstream.create({
    data: {
      organizationId,
      projectId: artifact.projectId,
      title: artifact.title,
      description: `Auto-created for PR linkage: ${artifact.title}`,
      type: WorkstreamType.FEATURE_DELIVERY,
      createdById: artifact.assigneeId ?? artifact.createdById,
      slug,
    },
  });

  // Attach the artifact to the new workstream
  await tx.artifact.update({
    where: { id: artifact.id, organizationId },
    data: { workstreamId: workstream.id },
  });

  log.info("[handlePullRequest] Auto-created workstream for artifact", {
    workstreamId: workstream.id,
    artifactId: artifact.id,
    slug: artifact.slug,
  });

  return workstream.id;
}

/**
 * Link an existing GitHubPullRequest record to a plan artifact.
 * Creates ExternalLink, EntityLink, and WorkstreamEvent records.
 */
async function linkExistingPrToArtifact(
  tx: TransactionClient,
  existingPr: ExistingPr,
  artifact: {
    id: string;
    organizationId: string;
    projectId: string | null;
    slug: string;
  },
  workstreamId: string,
  pull_request: HandledPullRequestEvent["pull_request"]
): Promise<void> {
  // Update artifactId on the PR
  await tx.gitHubPullRequest.update({
    where: { id: existingPr.id },
    data: { artifactId: artifact.id },
  });

  await createLinkageRecords(tx, artifact, workstreamId, pull_request);

  log.info("[handlePullRequest] Linked existing PR to artifact", {
    prId: existingPr.id,
    artifactId: artifact.id,
    slug: artifact.slug,
  });
}

/**
 * Create a new GitHubPullRequest record and link it to a plan artifact.
 * Used for PRs opened outside Symphony that reference a plan slug.
 */
async function createAndLinkPr(
  tx: TransactionClient,
  repo: RepoWithInstallation,
  artifact: Pick<Artifact, "id" | "organizationId" | "projectId" | "slug">,
  organizationId: string,
  workstreamId: string,
  pullRequest: HandledPullRequestEvent["pull_request"]
): Promise<void> {
  let state: GitHubPRState = GitHubPRState.Open;
  if (pullRequest.state === "closed") {
    state = pullRequest.merged ? GitHubPRState.Merged : GitHubPRState.Closed;
  }

  await tx.gitHubPullRequest.create({
    data: {
      workstreamId,
      organizationId,
      repositoryId: repo.id,
      artifactId: artifact.id,
      githubId: String(pullRequest.id),
      number: pullRequest.number,
      title: pullRequest.title,
      htmlUrl: pullRequest.html_url,
      headBranch: pullRequest.head.ref,
      baseBranch: pullRequest.base.ref,
      headSha: pullRequest.head.sha,
      state,
      isDraft: pullRequest.draft ?? false,
    },
  });

  await createLinkageRecords(tx, artifact, workstreamId, pullRequest);

  log.info("[handlePullRequest] Created and linked new PR to artifact", {
    prNumber: pullRequest.number,
    artifactId: artifact.id,
    slug: artifact.slug,
  });
}

/**
 * Create ExternalLink, EntityLink, and WorkstreamEvent records for a PR-to-plan link.
 */
async function createLinkageRecords(
  tx: TransactionClient,
  artifact: Pick<Artifact, "id" | "organizationId" | "projectId" | "slug">,
  workstreamId: string,
  pullRequest: HandledPullRequestEvent["pull_request"]
): Promise<void> {
  // AC-008: Check for existing ExternalLink to prevent duplicates
  const existingExternalLink = await tx.externalLink.findFirst({
    where: {
      organizationId: artifact.organizationId,
      type: ExternalLinkType.PullRequest,
      externalUrl: pullRequest.html_url,
    },
    select: { id: true },
  });

  let externalLinkId: string;

  if (existingExternalLink) {
    externalLinkId = existingExternalLink.id;

    await tx.externalLink.update({
      where: { id: externalLinkId },
      data: {
        title: pullRequest.title,
        metadata: pullRequestToMetadata(pullRequest),
      },
    });
  } else {
    const prLink = await tx.externalLink.create({
      data: {
        organizationId: artifact.organizationId,
        workstreamId,
        projectId: artifact.projectId!,
        type: ExternalLinkType.PullRequest,
        title: pullRequest.title,
        externalUrl: pullRequest.html_url,
        metadata: pullRequestToMetadata(pullRequest),
      },
    });
    externalLinkId = prLink.id;
  }

  // AC-008: Check for existing EntityLink to prevent duplicates
  const existingEntityLink = await tx.entityLink.findFirst({
    where: {
      sourceId: artifact.id,
      targetId: externalLinkId,
      linkType: LinkType.Produces,
    },
    select: { id: true },
  });

  if (!existingEntityLink) {
    await tx.entityLink.create({
      data: {
        organizationId: artifact.organizationId,
        sourceId: artifact.id,
        sourceType: EntityType.Artifact,
        targetId: externalLinkId,
        targetType: EntityType.ExternalLink,
        linkType: LinkType.Produces,
      },
    });
  }

  // Create WorkstreamEvent — use GITHUB_PR_LINKED for all linkage actions
  // (opened/edited/reopened all represent a PR being linked to a plan, not a comment)
  const eventType = "GITHUB_PR_LINKED";

  await tx.workstreamEvent.create({
    data: {
      workstreamId,
      type: eventType,
      actorType: "system",
      data: {
        prNumber: pullRequest.number,
        prUrl: pullRequest.html_url,
        prTitle: pullRequest.title,
        branch: pullRequest.head.ref,
        artifactId: artifact.id,
        slug: artifact.slug,
      },
    },
  });
}

async function applyPrAction(
  tx: TransactionClient,
  action: string,
  event: HandledPullRequestEvent,
  existingPr: ExistingPr,
  pullRequest: HandledPullRequestEvent["pull_request"]
): Promise<void> {
  switch (action) {
    case "closed": {
      const isMerged = (event as PullRequestClosedEvent).pull_request.merged;
      const newState = isMerged ? GitHubPRState.Merged : GitHubPRState.Closed;

      await tx.gitHubPullRequest.update({
        where: { id: existingPr.id },
        data: {
          state: newState,
          closedAt: parseDateOrNow(pullRequest.closed_at),
          mergedAt: pullRequest.merged_at
            ? new Date(pullRequest.merged_at)
            : null,
          mergeCommitSha: pullRequest.merge_commit_sha,
        },
      });

      await tx.externalLink.updateMany({
        where: {
          workstreamId: existingPr.workstreamId,
          type: ExternalLinkType.PullRequest,
          metadata: { path: ["githubId"], equals: String(pullRequest.id) },
        },
        data: {
          metadata: pullRequestToMetadata(pullRequest),
        },
      });

      await tx.workstreamEvent.create({
        data: {
          workstreamId: existingPr.workstreamId,
          type: isMerged ? "GITHUB_PR_MERGED" : "GITHUB_PR_CLOSED",
          actorType: "system",
          data: {
            prNumber: pullRequest.number,
            prTitle: pullRequest.title,
            prUrl: pullRequest.html_url,
            artifactId: existingPr.artifactId,
            slug: existingPr.artifact?.slug,
            ...(isMerged
              ? {
                  mergedAt: pullRequest.merged_at,
                  mergeCommitSha: pullRequest.merge_commit_sha,
                }
              : {}),
          },
        },
      });

      if (isMerged && existingPr.artifactId) {
        await tx.artifact.update({
          where: { id: existingPr.artifactId },
          data: { status: ArtifactStatus.Executed },
        });
        log.info("[handlePullRequest] Marked artifact as EXECUTED", {
          artifactId: existingPr.artifactId,
        });

        // Cascade: mark linked Features as COMPLETED when their plan ships.
        await markLinkedFeaturesCompleted(tx, existingPr.artifactId);
      }

      log.info("[handlePullRequest] PR closed", {
        prNumber: pullRequest.number,
        newState,
        isMerged,
      });
      break;
    }

    case "reopened": {
      await tx.gitHubPullRequest.update({
        where: { id: existingPr.id },
        data: {
          state: GitHubPRState.Open,
          closedAt: null,
        },
      });

      await tx.externalLink.updateMany({
        where: {
          workstreamId: existingPr.workstreamId,
          type: ExternalLinkType.PullRequest,
          metadata: { path: ["githubId"], equals: String(pullRequest.id) },
        },
        data: {
          metadata: pullRequestToMetadata(pullRequest),
        },
      });

      log.info("[handlePullRequest] PR reopened", {
        prNumber: pullRequest.number,
      });
      break;
    }

    case "synchronize": {
      await tx.gitHubPullRequest.update({
        where: { id: existingPr.id },
        data: {
          headSha: pullRequest.head.sha,
          checksStatus: ChecksStatus.PENDING,
        },
      });

      await tx.workstreamEvent.create({
        data: {
          workstreamId: existingPr.workstreamId,
          type: "GITHUB_CI_STATUS_CHANGED",
          actorType: "system",
          data: {
            prNumber: pullRequest.number,
            prTitle: pullRequest.title,
            prUrl: pullRequest.html_url,
            artifactId: existingPr.artifactId,
            slug: existingPr.artifact?.slug,
            checksStatus: ChecksStatus.PENDING,
            previousChecksStatus: existingPr.checksStatus,
            headSha: pullRequest.head.sha,
          },
        },
      });

      log.info("[handlePullRequest] PR synchronized", {
        prNumber: pullRequest.number,
        before: (event as PullRequestSynchronizeEvent).before,
        after: (event as PullRequestSynchronizeEvent).after,
        newHeadSha: pullRequest.head.sha,
      });
      break;
    }

    case "converted_to_draft": {
      await tx.gitHubPullRequest.update({
        where: { id: existingPr.id },
        data: { isDraft: true },
      });

      log.info("[handlePullRequest] PR converted to draft", {
        prNumber: pullRequest.number,
      });
      break;
    }

    case "ready_for_review": {
      await tx.gitHubPullRequest.update({
        where: { id: existingPr.id },
        data: { isDraft: false },
      });

      log.info("[handlePullRequest] PR ready for review", {
        prNumber: pullRequest.number,
      });
      break;
    }

    default:
      break;
  }
}

/**
 * When an Implementation Plan is marked EXECUTED (PR merged), find any Features
 * linked to it, mark them as COMPLETED.
 */
async function markLinkedFeaturesCompleted(
  tx: TransactionClient,
  artifactId: string
): Promise<void> {
  const links = await tx.entityLink.findMany({
    where: {
      sourceType: EntityType.Feature,
      targetId: artifactId,
      targetType: EntityType.Artifact,
      linkType: LinkType.Produces,
    },
    select: {
      sourceId: true,
    },
  });

  const featureIds = links.map((link) => link.sourceId);

  if (featureIds.length === 0) {
    return;
  }

  // Mark features as COMPLETED
  const { count } = await tx.feature.updateMany({
    where: {
      id: { in: featureIds },
      status: { not: FeatureStatus.Completed },
    },
    data: { status: FeatureStatus.Completed },
  });

  if (count > 0) {
    log.info("[handlePullRequest] Marked linked features as COMPLETED", {
      artifactId,
      featureIds,
      updatedCount: count,
    });
  }
}

function pullRequestToMetadata(pullRequest: PullRequest): PullRequestMetadata {
  let state: GitHubPRState = GitHubPRState.Open;

  if (pullRequest.state === "closed") {
    state = pullRequest.merged ? GitHubPRState.Merged : GitHubPRState.Closed;
  }

  return {
    number: pullRequest.number,
    githubId: String(pullRequest.id),
    headBranch: pullRequest.head.ref,
    baseBranch: pullRequest.base.ref,
    state,
  };
}
