import type { PullRequest } from "@octokit/webhooks-types";
import { LinkType } from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import type { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubDirtyScopeKind,
  GitHubDirtyTrigger,
} from "@repo/api/src/types/github-dirty-scope";
import { expandSlugAliases } from "@repo/api/src/types/slug-prefix";
import type { TransactionClient } from "@repo/database";
import { ArtifactType, ChecksStatus, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { reconcilePullRequestProviderIdentityInTransaction } from "@/app/branches/pull-request-provider-identity";
import { pullRequestProviderLockTxOptions } from "@/app/branches/pull-request-provider-lock";
import { runWithAttributionEvidenceGate } from "@/lib/attribution-evidence-gate-scope";
import type { GitHubWebhookObservationContext } from "@/lib/github/github-webhook-observation";
import { pickPullRequestArtifactReference } from "./artifact-reference";
import {
  GitHubBranchActivityEventName,
  persistGitHubBranchActivity,
} from "./branch-activity-producer";
import { publishGitHubDirtyScopes } from "./dirty-scope-publisher";
import { activeInstallationRepositoryWhere } from "./installation-repository-scope";
import {
  applyPullRequestAction,
  type HandledPullRequestEvent,
} from "./pull-request-action-application";
import { readPullRequestAttributionEvidence } from "./pull-request-attribution-read";
import { repairPullRequestBranchAssociationInTransaction } from "./pull-request-branch-association-repair";
import { materializeWebhookPullRequestBranch } from "./pull-request-branch-materialization";
import { seedPullRequestBranchOwner } from "./pull-request-branch-owner-seed";
import { reconcilePullRequestLabelsForWebhook } from "./pull-request-label-reconciliation";
import {
  shouldApplyCurrentBranchPrEvent,
  shouldApplyPullRequestLifecycleUpdate,
} from "./pull-request-lifecycle-decision";
import { createLinkageRecords } from "./pull-request-linkage-records";
import { writeExistingWebhookPullRequestProjection } from "./pull-request-projection";

/**
 * Actions this handler processes. All other actions are ignored with an early return.
 * GitHub sends many PR action types (labeled, assigned, etc.)
 * that we don't process.
 */
export const HANDLED_ACTIONS = new Set<HandledPullRequestEvent["action"]>([
  "opened",
  "edited",
  "closed",
  "reopened",
  "synchronize",
  "converted_to_draft",
  "ready_for_review",
]);

/** Actions that trigger plan reference parsing and linkage. */
export const LINKAGE_ACTIONS = new Set(["opened", "edited", "reopened"]);

type LinkableDocumentArtifact = {
  id: string;
  organizationId: string;
  projectId: string | null;
  createdById: string | null;
  slug: string;
};

/** Handle the bounded lifecycle/linkage subset of pull_request webhooks. */
export async function handlePullRequest(
  event: HandledPullRequestEvent,
  observationContext?: GitHubWebhookObservationContext
): Promise<Response> {
  const { action, pull_request, repository } = event;
  const installationId = event.installation?.id;

  // Early exit for unhandled actions
  if (!HANDLED_ACTIONS.has(action)) {
    log.debug("[handlePullRequest] Skipping unhandled action", {
      action,
      prNumber: pull_request.number,
      repositoryFullName: repository.full_name,
    });
    return NextResponse.json({
      message: `Ignoring unhandled pull_request action: ${action}`,
      ok: true,
    });
  }
  if (!installationId) {
    log.warn("[handlePullRequest] Missing installation on event", {
      action,
      prNumber: pull_request.number,
      repositoryFullName: repository.full_name,
    });
    return NextResponse.json(
      { message: "Missing installation", ok: false },
      { status: 400 }
    );
  }

  // ISS-7130: sized to the worst-case holder of the PR-provider identity lock.
  // The FEA-3685 #3375 override was dropped because the auto-advance that took
  // a blocking advisory lock had left this handler — true when written, and
  // falsified by ISS-6980, which put a blocking `pg_advisory_xact_lock` back on
  // this path (identity reconcile, then branch-association repair). That wait
  // happens inside the transaction, so on Prisma's 5s default a contended
  // delivery aborts with P2028 mid-wait and its projection write is simply lost.
  // This is also the OUTERMOST transaction for the branch upsert this path
  // reaches (`branchService.upsertBranchArtifact` joins it), whose own options
  // are dropped once nested — same shape as `handleDeploymentStatus`.
  const publication = await runWithAttributionEvidenceGate(async () => {
    // ISS-12552: only a delivery that names an artifact can write the source
    // link that reads this answer, so any other reads nothing (flag-off parity).
    if (
      LINKAGE_ACTIONS.has(action) &&
      pickPullRequestArtifactReference(pull_request)
    ) {
      await readPullRequestAttributionEvidence(repository, installationId);
    }
    return await withDb.tx(
      (tx) =>
        processPullRequestTransaction(
          tx,
          event,
          installationId,
          observationContext
        ),
      pullRequestProviderLockTxOptions
    );
  });
  if (publication) {
    await publishGitHubDirtyScopes(publication);
  }

  // ISS-4664: propagate the implementing document's tags onto the PR as GitHub
  // labels. Runs post-commit (the produces-link is written inside the
  // transaction above) and only for the actions that can (re)establish linkage.
  // Idempotent and additive, so a re-delivered webhook is a no-op and manual
  // labels are never removed.
  if (LINKAGE_ACTIONS.has(action)) {
    await reconcilePullRequestLabelsForWebhook({
      githubRepoId: String(repository.id),
      repositoryFullName: repository.full_name,
      installationId: String(installationId),
      pullNumber: pull_request.number,
    });
  }

  return NextResponse.json({
    message: "Event processed successfully",
    ok: true,
  });
}

async function processPullRequestTransaction(
  tx: TransactionClient,
  event: HandledPullRequestEvent,
  installationId: number,
  observationContext?: GitHubWebhookObservationContext
): Promise<PullRequestDirtyScopePublication | null> {
  const { action, pull_request, repository } = event;
  const repo = await findActivePullRequestRepository(
    tx,
    repository,
    installationId
  );
  if (!repo) {
    log.warn("[handlePullRequest] Repository not found in database", {
      githubRepoId: repository.id,
      repositoryFullName: repository.full_name,
      action,
      prNumber: pull_request.number,
    });
    return null;
  }

  let prDetail = await findPullRequestDetail(tx, repo.id, pull_request.number);
  if (repo.installation.organizationId) {
    await reconcilePullRequestProviderIdentityInTransaction(tx, {
      organizationId: repo.installation.organizationId,
      repositoryId: repo.id,
      repositoryFullName: normalizeRepoFullName(repo.fullName),
      githubId: String(pull_request.id),
      number: pull_request.number,
    });
    prDetail = await findPullRequestDetail(tx, repo.id, pull_request.number);
  }
  const repaired = isAuthoritativeRelinkDelivery(prDetail, pull_request, action)
    ? await repairPullRequestBranchAssociationInTransaction(tx, {
        organizationId:
          (prDetail?.branchArtifact ?? prDetail?.artifact)?.organizationId ??
          null,
        repositoryId: repo.id,
        repositoryFullName: repo.fullName,
        headBranch: pull_request.head.ref,
        headRepositoryFullName: pull_request.head.repo?.full_name ?? null,
        pullRequestNumber: pull_request.number,
        pullRequestDetailId: prDetail?.id ?? "",
        currentBranchArtifactId: prDetail?.branchArtifactId ?? null,
        incomingUpdatedAt: new Date(pull_request.updated_at),
      })
    : false;
  prDetail = await reloadRepairedPullRequestDetail(
    tx,
    repo.id,
    pull_request.number,
    prDetail,
    repaired
  );
  const existingPr = prDetail
    ? buildExistingPr(prDetail)
    : await findExistingBranchPr(tx, repo.id, pull_request.head.ref);

  const wroteProjection = await processExistingPullRequest(
    tx,
    event,
    repo,
    existingPr,
    observationContext
  );
  await seedPullRequestBranchOwner(tx, repo, pull_request);
  if (!wroteProjection) {
    return null;
  }
  if (!repo.installation.organizationId) {
    return null;
  }
  return {
    organizationId: repo.installation.organizationId,
    repositoryId: repo.id,
    repositoryFullName: repo.fullName,
    scopes: [
      {
        kind: GitHubDirtyScopeKind.PullRequest,
        repositoryId: repo.id,
        repositoryFullName: repo.fullName,
        branchName: pull_request.head.ref,
        pullRequestNumber: pull_request.number,
      },
    ],
    triggers: [GitHubDirtyTrigger.PullRequest],
  };
}

function findActivePullRequestRepository(
  tx: TransactionClient,
  repository: HandledPullRequestEvent["repository"],
  installationId: number
): Promise<RepoWithInstallation | null> {
  return tx.gitHubInstallationRepository.findFirst({
    where: activeInstallationRepositoryWhere({
      githubRepoId: String(repository.id),
      fullName: repository.full_name,
      installationId: String(installationId),
    }),
    select: {
      id: true,
      fullName: true,
      installation: {
        select: { organizationId: true, installationId: true },
      },
    },
  });
}

function findPullRequestDetail(
  tx: TransactionClient,
  repositoryId: string,
  number: number
): Promise<ExistingPrDetail | null> {
  return tx.pullRequestDetail.findUnique({
    where: {
      repositoryId_number: {
        repositoryId,
        number,
      },
    },
    select: {
      artifactId: true,
      branchArtifactId: true,
      id: true,
      githubId: true,
      prState: true,
      isDraft: true,
      closedAt: true,
      mergedAt: true,
      githubUpdatedAt: true,
      headRefName: true,
      artifact: {
        select: {
          organizationId: true,
          projectId: true,
          // PR is the TARGET of a DOCUMENT -> produces -> PR link.
          targetLinks: {
            where: {
              linkType: LinkType.Produces,
              source: { type: ArtifactType.DOCUMENT },
            },
            select: {
              source: { select: { id: true, slug: true } },
            },
            orderBy: { createdAt: "asc" },
            take: 1,
          },
        },
      },
      branchArtifact: {
        select: {
          organizationId: true,
          projectId: true,
          branch: {
            select: {
              checksStatus: true,
              currentPullRequestDetailId: true,
              headSha: true,
            },
          },
          targetLinks: {
            where: {
              linkType: LinkType.Produces,
              source: { type: ArtifactType.DOCUMENT },
            },
            select: {
              source: { select: { id: true, slug: true } },
            },
            orderBy: { createdAt: "asc" },
            take: 1,
          },
        },
      },
    },
  });
}

async function reloadRepairedPullRequestDetail(
  tx: TransactionClient,
  repositoryId: string,
  pullRequestNumber: number,
  current: ExistingPrDetail | null,
  repaired: boolean
): Promise<ExistingPrDetail | null> {
  if (!repaired) {
    return current;
  }
  const reloaded = await findPullRequestDetail(
    tx,
    repositoryId,
    pullRequestNumber
  );
  if (!reloaded) {
    throw new Error("relinked pull request could not be reloaded");
  }
  return reloaded;
}

async function processExistingPullRequest(
  tx: TransactionClient,
  event: HandledPullRequestEvent,
  repo: RepoWithInstallation,
  existingPr: ExistingPr | null,
  observationContext?: GitHubWebhookObservationContext
): Promise<boolean> {
  const { action, pull_request } = event;

  if (!existingPr) {
    return processMissingPullRequest(tx, event, repo, observationContext);
  }

  const lifecycleSubject = getLifecycleSubject(
    existingPr,
    pull_request,
    action
  );
  const lifecycleDecision = shouldApplyPullRequestLifecycleUpdate(
    lifecycleSubject,
    pull_request,
    action
  );

  if (!shouldApplyCurrentBranchPrEvent(existingPr)) {
    await persistAssociatedPullRequestActivity(
      event,
      existingPr,
      existingPr.pullRequestDetailId,
      observationContext
    );
    log.debug("[handlePullRequest] Skipping non-current branch PR event", {
      action,
      branchArtifactId: existingPr.id,
      currentPullRequestDetailId: existingPr.currentPullRequestDetailId,
      incomingPullRequestDetailId: existingPr.pullRequestDetailId,
      lifecycleReason: lifecycleDecision.apply
        ? "applicable"
        : lifecycleDecision.reason,
      prNumber: pull_request.number,
    });
    return false;
  }

  if (!lifecycleDecision.apply) {
    log.debug("[handlePullRequest] Skipping stale pull_request lifecycle", {
      action,
      prNumber: pull_request.number,
      branchArtifactId: existingPr.id,
      reason: lifecycleDecision.reason,
    });
    return false;
  }

  await writeExistingWebhookPullRequestProjection(
    tx,
    {
      branchArtifactId: existingPr.id,
      checksStatus: existingPr.checksStatus,
      currentHeadSha: existingPr.headSha,
      hasBranchArtifact: existingPr.hasBranchArtifact,
      organizationId: existingPr.organizationId,
      pullRequestDetailId: existingPr.pullRequestDetailId,
      repositoryId: repo.id,
      repositoryFullName: repo.fullName,
    },
    pull_request,
    action,
    observationContext
  );
  const projectedPullRequest = await findPullRequestDetail(
    tx,
    repo.id,
    pull_request.number
  );

  // For existing PRs, attempt artifact linkage only after replay/order
  // validation so stale terminal events cannot mutate links.
  if (LINKAGE_ACTIONS.has(action)) {
    await attemptArtifactLinkage(
      tx,
      pull_request,
      repo,
      existingPr,
      observationContext
    );
  }

  await applyPullRequestAction(tx, event, existingPr);
  await persistAssociatedPullRequestActivity(
    event,
    existingPr,
    projectedPullRequest?.id,
    observationContext
  );
  return true;
}

async function processMissingPullRequest(
  tx: TransactionClient,
  event: HandledPullRequestEvent,
  repo: RepoWithInstallation,
  observationContext?: GitHubWebhookObservationContext
): Promise<boolean> {
  const { action, pull_request: pullRequest } = event;
  if (LINKAGE_ACTIONS.has(action)) {
    await attemptArtifactLinkage(
      tx,
      pullRequest,
      repo,
      null,
      observationContext
    );
    const materializedPr = await findPullRequestDetail(
      tx,
      repo.id,
      pullRequest.number
    );
    if (materializedPr) {
      const existingPr = buildExistingPr(materializedPr);
      if (existingPr) {
        await persistAssociatedPullRequestActivity(
          event,
          existingPr,
          existingPr.pullRequestDetailId,
          observationContext
        );
      }
    }
    return true;
  }

  log.warn("[handlePullRequest] Pull request not found in database", {
    repositoryId: repo.id,
    prNumber: pullRequest.number,
    action,
    reason: "PR may have been created outside Symphony workflow",
  });
  return false;
}

function getLifecycleSubject(
  existingPr: ExistingPr,
  pullRequest: PullRequest,
  action: string
): ExistingPr | null {
  if (
    existingPr.hasBranchArtifact &&
    existingPr.githubId &&
    existingPr.githubId !== String(pullRequest.id) &&
    LINKAGE_ACTIONS.has(action)
  ) {
    return null;
  }
  return existingPr;
}

type RepoWithInstallation = {
  id: string;
  fullName: string;
  installation: { organizationId: string | null; installationId: string };
};

type ExistingPr = {
  id: string;
  currentPullRequestDetailId: string | null;
  pullRequestDetailId: string | null;
  projectId: string | null;
  organizationId: string;
  documentId: string | null;
  githubId: string | null;
  checksStatus: ChecksStatus;
  prState: GitHubPRState | null;
  isDraft: boolean | null;
  closedAt: Date | null;
  mergedAt: Date | null;
  headSha: string | null;
  document: { slug: string } | null;
  hasBranchArtifact: boolean;
};

type ExistingPrDetail = {
  artifactId: string | null;
  branchArtifactId: string | null;
  id: string;
  // FEA-2732: nullable for desktop-produced PRs with no GitHub node id yet.
  githubId: string | null;
  prState: GitHubPRState;
  isDraft: boolean;
  closedAt: Date | null;
  mergedAt: Date | null;
  githubUpdatedAt: Date | null;
  headRefName: string | null;
  artifact: ExistingPrOwnerArtifact | null;
  branchArtifact: ExistingPrOwnerArtifact | null;
};

type ExistingPrOwnerArtifact = {
  projectId: string | null;
  organizationId: string;
  branch?: {
    checksStatus: ChecksStatus;
    currentPullRequestDetailId: string | null;
    headSha: string | null;
  } | null;
  targetLinks: Array<{ source: { id: string; slug: string | null } }>;
};

function buildExistingPr(prDetail: ExistingPrDetail): ExistingPr | null {
  const ownerArtifact = prDetail.branchArtifact ?? prDetail.artifact;
  const existingArtifactId = prDetail.branchArtifactId ?? prDetail.artifactId;
  if (!(ownerArtifact && existingArtifactId)) {
    return null;
  }

  const linkedDoc = ownerArtifact.targetLinks[0]?.source ?? null;
  return {
    id: existingArtifactId,
    currentPullRequestDetailId:
      ownerArtifact.branch?.currentPullRequestDetailId ?? null,
    pullRequestDetailId: prDetail.id,
    projectId: ownerArtifact.projectId,
    organizationId: ownerArtifact.organizationId,
    documentId: linkedDoc?.id ?? null,
    githubId: prDetail.githubId,
    checksStatus: ownerArtifact.branch?.checksStatus ?? ChecksStatus.UNKNOWN,
    prState: prDetail.prState,
    isDraft: prDetail.isDraft,
    closedAt: prDetail.closedAt,
    mergedAt: prDetail.mergedAt,
    headSha: ownerArtifact.branch?.headSha ?? null,
    document: linkedDoc ? { slug: linkedDoc.slug ?? "" } : null,
    hasBranchArtifact: !!prDetail.branchArtifactId,
  };
}

function isAuthoritativeRelinkDelivery(
  prDetail: ExistingPrDetail | null,
  pullRequest: PullRequest,
  action: HandledPullRequestEvent["action"]
): boolean {
  if (!prDetail) {
    return true;
  }
  const existingPr = buildExistingPr(prDetail);
  if (!existingPr) {
    return true;
  }
  const incomingUpdatedAt = new Date(pullRequest.updated_at);
  if (
    prDetail.githubUpdatedAt &&
    incomingUpdatedAt.getTime() < prDetail.githubUpdatedAt.getTime()
  ) {
    return false;
  }
  if (
    prDetail.githubUpdatedAt &&
    incomingUpdatedAt.getTime() === prDetail.githubUpdatedAt.getTime() &&
    prDetail.headRefName !== null &&
    prDetail.headRefName !== pullRequest.head.ref
  ) {
    return false;
  }
  // ISS-12344: no current-PR gate here. A PR filed under the wrong Branch need
  // not be that Branch's current PR, and the repair only moves the PR.
  return shouldApplyPullRequestLifecycleUpdate(
    getLifecycleSubject(existingPr, pullRequest, action),
    pullRequest,
    action
  ).apply;
}

type PullRequestDirtyScopePublication = {
  organizationId: string;
  repositoryId: string;
  repositoryFullName: string;
  scopes: Array<{
    kind: typeof GitHubDirtyScopeKind.PullRequest;
    repositoryId: string;
    repositoryFullName: string;
    branchName: string;
    pullRequestNumber: number;
  }>;
  triggers: (typeof GitHubDirtyTrigger.PullRequest)[];
};

async function findExistingBranchPr(
  tx: TransactionClient,
  repositoryId: string,
  branchName: string
): Promise<ExistingPr | null> {
  // D2: (repository_id, branch_name) is no longer unique, but the webhook
  // (App-repo) path always has repositoryId (1:1 with a repo full name), so
  // findFirst by it resolves the same single row as the old findUnique.
  const branch = await tx.branchDetail.findFirst({
    where: {
      repositoryId,
      branchName,
    },
    select: {
      artifactId: true,
      currentPullRequestDetailId: true,
      checksStatus: true,
      headSha: true,
      artifact: {
        select: {
          organizationId: true,
          projectId: true,
          targetLinks: {
            where: {
              linkType: LinkType.Produces,
              source: { type: ArtifactType.DOCUMENT },
            },
            select: {
              source: { select: { id: true, slug: true } },
            },
            orderBy: { createdAt: "asc" },
            take: 1,
          },
        },
      },
      currentPullRequestDetail: {
        select: {
          id: true,
          branchArtifactId: true,
          repositoryId: true,
          githubId: true,
          prState: true,
          isDraft: true,
          closedAt: true,
          mergedAt: true,
        },
      },
    },
  });
  if (!branch) {
    return null;
  }

  const currentPullRequestDetail =
    branch.currentPullRequestDetail?.repositoryId === repositoryId &&
    branch.currentPullRequestDetail.branchArtifactId === branch.artifactId
      ? branch.currentPullRequestDetail
      : null;
  const linkedDoc = branch.artifact.targetLinks[0]?.source ?? null;
  return {
    id: branch.artifactId,
    currentPullRequestDetailId: branch.currentPullRequestDetailId,
    pullRequestDetailId: currentPullRequestDetail?.id ?? null,
    projectId: branch.artifact.projectId,
    organizationId: branch.artifact.organizationId,
    documentId: linkedDoc?.id ?? null,
    githubId: currentPullRequestDetail?.githubId ?? null,
    checksStatus: branch.checksStatus,
    prState: currentPullRequestDetail?.prState ?? null,
    isDraft: currentPullRequestDetail?.isDraft ?? null,
    closedAt: currentPullRequestDetail?.closedAt ?? null,
    mergedAt: currentPullRequestDetail?.mergedAt ?? null,
    headSha: branch.headSha,
    document: linkedDoc ? { slug: linkedDoc.slug ?? "" } : null,
    hasBranchArtifact: true,
  };
}

/**
 * Attempt to link a PR to an artifact (implementation plan or feature) based
 * on references in title/body. Handles both existing PRs (edit/reopen) and
 * new PRs (opened).
 */
async function attemptArtifactLinkage(
  tx: TransactionClient,
  pull_request: HandledPullRequestEvent["pull_request"],
  repo: RepoWithInstallation,
  existingPr: ExistingPr | null,
  observationContext?: GitHubWebhookObservationContext
): Promise<void> {
  if (existingPr?.documentId) {
    log.debug(
      "[handlePullRequest] PR already linked to artifact, skipping linkage",
      {
        prNumber: pull_request.number,
        existingDocumentId: existingPr.documentId,
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

  const primaryRef = pickPullRequestArtifactReference(pull_request);
  if (!primaryRef) {
    return;
  }

  log.debug("[handlePullRequest] Found artifact reference in PR", {
    prNumber: pull_request.number,
    slug: primaryRef.slug,
    prefix: primaryRef.prefix,
    docType: primaryRef.docType,
    matchType: primaryRef.matchType,
    source: primaryRef.source,
  });

  // FEA-4137: a PR body may reference `ISS-42` for an existing `FEA-42` row (or
  // the reverse once new slugs mint as ISS). Resolve the parsed slug through its
  // cross-prefix aliases so the reference links the right artifact regardless of
  // which prefix the author typed. Only one row exists per numeric identity, so
  // findFirst over the alias set is unambiguous.
  const artifactRow = await tx.artifact.findFirst({
    where: {
      organizationId,
      slug: { in: expandSlugAliases(primaryRef.slug) },
    },
    select: {
      id: true,
      type: true,
      subtype: true,
      name: true,
      organizationId: true,
      projectId: true,
      assigneeId: true,
      createdById: true,
      slug: true,
    },
  });

  if (!artifactRow || artifactRow.type !== ArtifactType.DOCUMENT) {
    log.warn("[handlePullRequest] Document not found for artifact reference", {
      prNumber: pull_request.number,
      slug: primaryRef.slug,
      organizationId,
    });
    return;
  }

  // Protect against slug-prefix collisions: a document with slug "FEA-42"
  // whose type is not Feature should not be linked.
  if (artifactRow.subtype !== primaryRef.docType) {
    log.warn(
      "[handlePullRequest] Document type does not match ref prefix, skipping",
      {
        prNumber: pull_request.number,
        slug: primaryRef.slug,
        expectedType: primaryRef.docType,
        actualType: artifactRow.subtype,
      }
    );
    return;
  }

  const artifact = {
    id: artifactRow.id,
    title: artifactRow.name,
    organizationId: artifactRow.organizationId,
    projectId: artifactRow.projectId,
    assigneeId: artifactRow.assigneeId,
    createdById: artifactRow.createdById,
    slug: artifactRow.slug ?? "",
  };

  if (existingPr) {
    await linkExistingPrToDocument(tx, existingPr, artifact, pull_request);
  } else {
    await createAndLinkPr(
      tx,
      repo,
      artifact,
      organizationId,
      pull_request,
      observationContext
    );
  }
}

/**
 * Link an existing PR artifact to a plan/feature document artifact.
 * The link itself lives as an ArtifactLink row (DOCUMENT -> produces -> PR).
 */
async function linkExistingPrToDocument(
  tx: TransactionClient,
  existingPr: ExistingPr,
  artifact: {
    id: string;
    organizationId: string;
    projectId: string | null;
    slug: string;
  },
  pull_request: HandledPullRequestEvent["pull_request"]
): Promise<void> {
  await createLinkageRecords(tx, artifact, pull_request);

  log.debug("[handlePullRequest] Linked existing PR to artifact", {
    prId: existingPr.id,
    documentId: artifact.id,
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
  artifact: LinkableDocumentArtifact,
  organizationId: string,
  pullRequest: HandledPullRequestEvent["pull_request"],
  observationContext?: GitHubWebhookObservationContext
): Promise<void> {
  const branchArtifactId = await materializeWebhookPullRequestBranch({
    organizationId,
    repo,
    artifact,
    pullRequest,
    observationContext,
  });
  if (!branchArtifactId) {
    return;
  }
  await createLinkageRecords(tx, artifact, pullRequest, branchArtifactId);

  log.debug("[handlePullRequest] Created and linked new PR to artifact", {
    prNumber: pullRequest.number,
    documentId: artifact.id,
    slug: artifact.slug,
  });
}

/** Persist activity after repository lookup proves the PR-to-Branch association. */
function persistAssociatedPullRequestActivity(
  event: HandledPullRequestEvent,
  existingPr: ExistingPr,
  pullRequestDetailId: string | null | undefined,
  observationContext?: GitHubWebhookObservationContext
) {
  return persistGitHubBranchActivity({
    eventName: GitHubBranchActivityEventName.PullRequest,
    deliveryId: observationContext?.deliveryId,
    payload: event,
    attribution: {
      organizationId: existingPr.organizationId,
      branchArtifactId: existingPr.id,
      pullRequestDetailId,
    },
  });
}
