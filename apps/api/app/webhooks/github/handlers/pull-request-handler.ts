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
  BranchBaseBranchSource,
  BranchHeadShaSource,
  BranchPushSource,
  LinkType,
} from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import type { Document } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubDirtyScopeKind,
  GitHubDirtyTrigger,
} from "@repo/api/src/types/github-dirty-scope";
import type { TransactionClient } from "@repo/database";
import {
  ArtifactType,
  ChecksStatus,
  GitHubInstallationStatus,
  withDb,
} from "@repo/database";
import { parseArtifactReferences } from "@repo/github/artifact-reference-parser";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import {
  bumpBranchActivity,
  stampBranchFirstPush,
} from "@/app/branches/branch-push-state";
import { branchService } from "@/app/branches/branch-service";
import {
  adoptRepolessPullRequestByRepoIdentity,
  BranchProjectionMode,
  writeExistingBranchPullRequestProjection,
} from "@/app/branches/github-projection-writer";
import { invalidateBranchStatusChecksForHeadChange } from "@/lib/branch-status-checks";
import { githubAppWebhookFetchProvenance } from "@/lib/github-fetch-provenance";
import { pickPrimaryArtifactReference } from "./artifact-reference";
import { publishGitHubDirtyScopes } from "./dirty-scope-publisher";

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
 * - closed: Updates state to MERGED (if merged) or CLOSED
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
  const installationId = event.installation?.id;

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

  log.info("[handlePullRequest] Processing pull_request event", {
    action,
    prNumber: pull_request.number,
    prTitle: pull_request.title,
    prState: pull_request.state,
    isDraft: pull_request.draft,
    merged: "merged" in pull_request ? pull_request.merged : undefined,
    repositoryId: repository.id,
    installationId,
  });

  const publication = await withDb.tx((tx) =>
    processPullRequestTransaction(tx, event, installationId)
  );
  if (publication) {
    await publishGitHubDirtyScopes(publication);
  }

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

async function processPullRequestTransaction(
  tx: TransactionClient,
  event: HandledPullRequestEvent,
  installationId: number
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
  if (!prDetail && repo.installation.organizationId) {
    // FEA-2732: no App-owned row for this (repo, PR#) yet — adopt a desktop-
    // produced repo-less row if one exists (fills repositoryId + githubId, and
    // the branch's repositoryId), so a webhook arriving AFTER the App install
    // reuses it instead of dropping state or inserting a duplicate. The githubId
    // stamp is required before the githubId-keyed action updates below.
    const adopted = await adoptRepolessPullRequestByRepoIdentity(tx, {
      organizationId: repo.installation.organizationId,
      repositoryFullName: normalizeRepoFullName(repo.fullName),
      number: pull_request.number,
      repositoryId: repo.id,
      githubId: String(pull_request.id),
    });
    if (adopted) {
      prDetail = await findPullRequestDetail(tx, repo.id, pull_request.number);
    }
  }
  // FEA-2732: a desktop-synced row can already occupy this (repo, PR#) with
  // repositoryId set but githubId still null — the session referenced an
  // existing PR before any webhook fired for it. findPullRequestDetail matches
  // that row, so the repo-less adopt above is skipped and the githubId is never
  // stamped. Left null, the githubId-keyed updates in applyPrAction throw P2025
  // ("record to update not found"), rolling back the entire webhook tx
  // (including the ensureCurrentPullRequestForExistingBranch write). Adopt the
  // row in place by stamping its githubId here. Safe: githubId is GitHub's
  // globally-unique PR id, and (repositoryId, number) is unique, so no other
  // row can already hold this githubId.
  if (prDetail && prDetail.githubId === null) {
    await tx.pullRequestDetail.update({
      where: { id: prDetail.id },
      data: { githubId: String(pull_request.id) },
    });
    prDetail = { ...prDetail, githubId: String(pull_request.id) };
  }
  const existingPr = prDetail
    ? buildExistingPr(prDetail)
    : await findExistingBranchPr(tx, repo.id, pull_request.head.ref);

  const wroteProjection = await processExistingPullRequest(
    tx,
    event,
    repo,
    existingPr
  );
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
    where: {
      githubRepoId: String(repository.id),
      fullName: repository.full_name,
      removedAt: null,
      installation: {
        installationId: String(installationId),
        status: GitHubInstallationStatus.ACTIVE,
      },
    },
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

async function processExistingPullRequest(
  tx: TransactionClient,
  event: HandledPullRequestEvent,
  repo: RepoWithInstallation,
  existingPr: ExistingPr | null
): Promise<boolean> {
  const { action, pull_request } = event;

  if (!existingPr) {
    return processMissingPullRequest(tx, action, pull_request, repo);
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
    log.info("[handlePullRequest] Skipping non-current branch PR event", {
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
    log.info("[handlePullRequest] Skipping stale pull_request lifecycle", {
      action,
      prNumber: pull_request.number,
      branchArtifactId: existingPr.id,
      reason: lifecycleDecision.reason,
    });
    return false;
  }

  if (existingPr.hasBranchArtifact) {
    await ensureCurrentPullRequestForExistingBranch(
      tx,
      repo,
      existingPr,
      pull_request,
      action
    );
  }

  // For existing PRs, attempt artifact linkage only after replay/order
  // validation so stale terminal events cannot mutate links.
  if (LINKAGE_ACTIONS.has(action)) {
    await attemptArtifactLinkage(tx, pull_request, repo, existingPr);
  }

  await applyPrAction(tx, action, event, existingPr, pull_request);
  return true;
}

async function processMissingPullRequest(
  tx: TransactionClient,
  action: string,
  pullRequest: PullRequest,
  repo: RepoWithInstallation
): Promise<boolean> {
  if (LINKAGE_ACTIONS.has(action)) {
    await attemptArtifactLinkage(tx, pullRequest, repo, null);
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

function shouldApplyCurrentBranchPrEvent(existingPr: ExistingPr): boolean {
  if (!existingPr.hasBranchArtifact) {
    return true;
  }
  if (
    !(existingPr.currentPullRequestDetailId && existingPr.pullRequestDetailId)
  ) {
    return true;
  }
  return (
    existingPr.currentPullRequestDetailId === existingPr.pullRequestDetailId
  );
}

type LifecycleDecision = { apply: true } | { apply: false; reason: string };

/**
 * Protect current PR lifecycle state from duplicate webhook delivery and
 * stale open-ish events. GitHub webhooks are at-least-once; the DB row remains
 * authoritative when a terminal merge or newer close is already persisted.
 */
export function shouldApplyPullRequestLifecycleUpdate(
  current: ExistingPr | null,
  incoming: PullRequest,
  action: string
): LifecycleDecision {
  if (!current) {
    return { apply: true };
  }

  const incomingState = pullRequestState(incoming);
  if (
    action !== "edited" &&
    action !== "synchronize" &&
    current.prState === incomingState &&
    current.isDraft === (incoming.draft ?? false) &&
    current.headSha === incoming.head.sha
  ) {
    return { apply: false, reason: "duplicate" };
  }
  if (current.prState === GitHubPRState.Merged) {
    return { apply: false, reason: "merged_terminal" };
  }

  const terminalObservedAt = current.mergedAt ?? current.closedAt;
  const incomingUpdatedAt = new Date(incoming.updated_at);
  const opensLifecycle =
    action === "opened" ||
    action === "edited" ||
    action === "synchronize" ||
    action === "converted_to_draft" ||
    action === "ready_for_review" ||
    action === "reopened";
  if (
    terminalObservedAt &&
    opensLifecycle &&
    incomingUpdatedAt.getTime() <= terminalObservedAt.getTime()
  ) {
    return { apply: false, reason: "stale_open_event" };
  }

  if (
    current.prState === GitHubPRState.Closed &&
    action !== "reopened" &&
    opensLifecycle
  ) {
    return { apply: false, reason: "closed_terminal_for_action" };
  }

  return { apply: true };
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
  existingPr: ExistingPr | null
): Promise<void> {
  if (existingPr?.documentId) {
    log.info(
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

  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL;
  const refs = parseArtifactReferences(
    pull_request.title,
    pull_request.body,
    appBaseUrl
  );

  if (refs.length === 0) {
    return;
  }

  const primaryRef = pickPrimaryArtifactReference(refs);
  if (!primaryRef) {
    return;
  }

  log.info("[handlePullRequest] Found artifact reference in PR", {
    prNumber: pull_request.number,
    slug: primaryRef.slug,
    prefix: primaryRef.prefix,
    docType: primaryRef.docType,
    matchType: primaryRef.matchType,
    source: primaryRef.source,
  });

  const artifactRow = await tx.artifact.findUnique({
    where: {
      organizationId_slug: {
        organizationId,
        slug: primaryRef.slug,
      },
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
    await createAndLinkPr(tx, repo, artifact, organizationId, pull_request);
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

  log.info("[handlePullRequest] Linked existing PR to artifact", {
    prId: existingPr.id,
    documentId: artifact.id,
    slug: artifact.slug,
  });
}

/**
 * Ensure an existing branch artifact points at the PR detail for this GitHub
 * PR. Lifecycle/status mutations are intentionally left to `applyPrAction`
 * so each webhook action has a single owner for state transitions.
 */
async function ensureCurrentPullRequestForExistingBranch(
  tx: TransactionClient,
  repo: RepoWithInstallation,
  existingPr: ExistingPr,
  pullRequest: HandledPullRequestEvent["pull_request"],
  action: string
): Promise<void> {
  await writeExistingBranchPullRequestProjection(
    tx,
    {
      branchArtifactId: existingPr.id,
      branchProjectionMode:
        action === "synchronize"
          ? BranchProjectionMode.PointerOnly
          : BranchProjectionMode.Full,
      currentHeadSha: existingPr.headSha,
      pullRequestDetailId: existingPr.pullRequestDetailId,
    },
    {
      organizationId: existingPr.organizationId,
      repositoryId: repo.id,
      githubId: String(pullRequest.id),
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body ?? null,
      htmlUrl: pullRequest.html_url,
      headBranch: pullRequest.head.ref,
      baseBranch: pullRequest.base.ref,
      headSha: pullRequest.head.sha,
      prState: pullRequestState(pullRequest),
      isDraft: pullRequest.draft ?? false,
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
      changedFiles: pullRequest.changed_files,
      checksStatus:
        action === "synchronize" ? undefined : existingPr.checksStatus,
      closedAt: pullRequest.closed_at ? new Date(pullRequest.closed_at) : null,
      mergedAt: pullRequest.merged_at ? new Date(pullRequest.merged_at) : null,
      mergeCommitSha: pullRequest.merge_commit_sha ?? null,
      fetchProvenance: githubAppWebhookFetchProvenance(),
    }
  );
}

/**
 * Create a new GitHubPullRequest record and link it to a plan artifact.
 * Used for PRs opened outside Symphony that reference a plan slug.
 */
async function createAndLinkPr(
  tx: TransactionClient,
  repo: RepoWithInstallation,
  artifact: Pick<Document, "id" | "organizationId" | "projectId" | "slug">,
  organizationId: string,
  pullRequest: HandledPullRequestEvent["pull_request"]
): Promise<void> {
  let state: GitHubPRState = GitHubPRState.Open;
  if (pullRequest.state === "closed") {
    state = pullRequest.merged ? GitHubPRState.Merged : GitHubPRState.Closed;
  }

  if (!artifact.projectId) {
    log.warn(
      "[handlePullRequest] Cannot create PR artifact — artifact has no projectId",
      {
        prNumber: pullRequest.number,
        documentId: artifact.id,
      }
    );
    return;
  }

  const upsertResult = await branchService.upsertBranchArtifact({
    organizationId,
    repositoryFullName: repo.fullName,
    projectId: artifact.projectId,
    repositoryId: repo.id,
    baseBranch: pullRequest.base.ref,
    baseBranchSource: BranchBaseBranchSource.PullRequestBase,
    branchName: pullRequest.head.ref,
    defaultBranch: pullRequest.base.repo?.default_branch ?? null,
    headSha: pullRequest.head.sha,
    headShaSource: BranchHeadShaSource.PullRequestWebhook,
    headShaObservedAt: new Date(),
    sourceArtifactId: artifact.id,
    fetchProvenance: githubAppWebhookFetchProvenance(),
    pullRequest: {
      githubId: String(pullRequest.id),
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body ?? null,
      htmlUrl: pullRequest.html_url,
      state,
      isDraft: pullRequest.draft ?? false,
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
      changedFiles: pullRequest.changed_files,
      closedAt: pullRequest.closed_at ? new Date(pullRequest.closed_at) : null,
      mergedAt: pullRequest.merged_at ? new Date(pullRequest.merged_at) : null,
      mergeCommitSha: pullRequest.merge_commit_sha ?? null,
    },
  });

  if (!upsertResult.ok) {
    log.warn(
      "[handlePullRequest] Skipping linkage — branch artifact rejected",
      {
        prNumber: pullRequest.number,
        organizationId,
        githubPrId: pullRequest.id,
      }
    );
    return;
  }

  await createLinkageRecords(tx, artifact, pullRequest, upsertResult.value.id);

  log.info("[handlePullRequest] Created and linked new PR to artifact", {
    prNumber: pullRequest.number,
    documentId: artifact.id,
    slug: artifact.slug,
  });
}

/**
 * Create the ArtifactLink row for a PR-to-plan link. Lifecycle/status mutations
 * are intentionally owned by `applyPrAction` or the branch service create path
 * so linkage cannot double-write PR state.
 */
async function createLinkageRecords(
  tx: TransactionClient,
  artifact: Pick<Document, "id" | "organizationId" | "projectId" | "slug">,
  pullRequest: HandledPullRequestEvent["pull_request"],
  knownBranchArtifactId?: string
): Promise<void> {
  // Find the branch artifact by current PR detail github id.
  const existingPrDetail = await tx.pullRequestDetail.findUnique({
    where: { githubId: String(pullRequest.id) },
    select: { artifactId: true, branchArtifactId: true },
  });

  const branchArtifactId =
    knownBranchArtifactId ?? existingPrDetail?.branchArtifactId ?? null;
  const legacyArtifactId = branchArtifactId
    ? null
    : (existingPrDetail?.artifactId ?? null);
  const targetArtifactId = branchArtifactId ?? legacyArtifactId;
  if (!targetArtifactId) {
    return;
  }

  // Dedup ArtifactLink — enforced by the unique constraint but we check first
  // to avoid the round-trip when it already exists.
  const existingLink = await tx.artifactLink.findFirst({
    where: {
      organizationId: artifact.organizationId,
      sourceId: artifact.id,
      targetId: targetArtifactId,
      linkType: LinkType.Produces,
    },
    select: { id: true },
  });

  if (!existingLink) {
    await tx.artifactLink.create({
      data: {
        organizationId: artifact.organizationId,
        sourceId: artifact.id,
        targetId: targetArtifactId,
        linkType: LinkType.Produces,
      },
    });
  }
}

// PLN-1034: PR-lifecycle actions that count as genuine branch activity. Excludes
// label/assignment/review-request churn (handled by the switch's `default`),
// which is not code or review activity.
const PR_ACTIVITY_ACTIONS = new Set<string>([
  "opened",
  "edited",
  "closed",
  "reopened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
]);

async function applyPrAction(
  tx: TransactionClient,
  action: string,
  event: HandledPullRequestEvent,
  existingPr: ExistingPr,
  pullRequest: HandledPullRequestEvent["pull_request"]
): Promise<void> {
  switch (action) {
    case "opened":
    case "edited": {
      await tx.artifact.update({
        where: { id: existingPr.id },
        data: { status: pullRequestState(pullRequest) },
      });
      await tx.pullRequestDetail.update({
        where: { githubId: String(pullRequest.id) },
        data: pullRequestToDetailUpdate(pullRequest),
      });

      log.info("[handlePullRequest] PR metadata refreshed", {
        action,
        prNumber: pullRequest.number,
      });
      break;
    }

    case "closed": {
      const isMerged = (event as PullRequestClosedEvent).pull_request.merged;
      const newState = isMerged ? GitHubPRState.Merged : GitHubPRState.Closed;

      await tx.artifact.update({
        where: { id: existingPr.id },
        data: {
          status: newState,
        },
      });
      await tx.pullRequestDetail.update({
        where: { githubId: String(pullRequest.id) },
        data: {
          ...pullRequestToDetailUpdate(pullRequest),
          prState: newState,
          closedAt: parseDateOrNow(pullRequest.closed_at),
        },
      });

      log.info("[handlePullRequest] PR closed", {
        prNumber: pullRequest.number,
        newState,
        isMerged,
      });
      break;
    }

    case "reopened": {
      await tx.artifact.update({
        where: { id: existingPr.id },
        data: { status: GitHubPRState.Open },
      });
      await tx.pullRequestDetail.update({
        where: { githubId: String(pullRequest.id) },
        data: pullRequestToDetailUpdate(pullRequest),
      });

      log.info("[handlePullRequest] PR reopened", {
        prNumber: pullRequest.number,
      });
      break;
    }

    case "synchronize": {
      await tx.artifact.update({
        where: { id: existingPr.id },
        data: { status: GitHubPRState.Open },
      });
      await tx.pullRequestDetail.update({
        where: { githubId: String(pullRequest.id) },
        data: pullRequestToDetailUpdate(pullRequest),
      });
      const branchUpdate = await tx.branchDetail.updateMany({
        where: { artifactId: existingPr.id },
        data: {
          headSha: pullRequest.head.sha,
          headShaSource: BranchHeadShaSource.PullRequestWebhook,
          headShaObservedAt: new Date(),
          lastPushBeforeSha: null,
          checksStatus: ChecksStatus.PENDING,
        },
      });
      if (
        branchUpdate.count > 0 &&
        existingPr.headSha !== pullRequest.head.sha
      ) {
        await invalidateBranchStatusChecksForHeadChange(tx, existingPr.id);
      }
      // PRD-510 FR2 / PLN-1099 Phase 2: a `synchronize` is new commits pushed to
      // the PR head — genuine push evidence. Stamp it set-once/earliest-wins
      // (`existingPr.id` is the branch artifact); a no-op once already pushed.
      await stampBranchFirstPush(
        tx,
        existingPr.id,
        parseDateOrNow(pullRequest.updated_at),
        BranchPushSource.Webhook
      );

      log.info("[handlePullRequest] PR synchronized", {
        prNumber: pullRequest.number,
        before: (event as PullRequestSynchronizeEvent).before,
        after: (event as PullRequestSynchronizeEvent).after,
        newHeadSha: pullRequest.head.sha,
      });
      break;
    }

    case "converted_to_draft": {
      await tx.artifact.update({
        where: { id: existingPr.id },
        data: { status: GitHubPRState.Open },
      });
      await tx.pullRequestDetail.update({
        where: { githubId: String(pullRequest.id) },
        data: pullRequestToDetailUpdate(pullRequest),
      });

      log.info("[handlePullRequest] PR converted to draft", {
        prNumber: pullRequest.number,
      });
      break;
    }

    case "ready_for_review": {
      await tx.artifact.update({
        where: { id: existingPr.id },
        data: { status: GitHubPRState.Open },
      });
      await tx.pullRequestDetail.update({
        where: { githubId: String(pullRequest.id) },
        data: pullRequestToDetailUpdate(pullRequest),
      });

      log.info("[handlePullRequest] PR ready for review", {
        prNumber: pullRequest.number,
      });
      break;
    }

    default:
      break;
  }

  // PLN-1034: record genuine branch activity for PR-lifecycle events. `existingPr.id`
  // is the branch artifact; the monotonic bump is a no-op when it has no branch row.
  if (PR_ACTIVITY_ACTIONS.has(action)) {
    await bumpBranchActivity(
      tx,
      existingPr.id,
      parseDateOrNow(pullRequest.updated_at)
    );
  }
}

/** Derive the PR state from a webhook pull_request payload. */
function pullRequestState(pullRequest: PullRequest): GitHubPRState {
  if (pullRequest.state === "closed") {
    return pullRequest.merged ? GitHubPRState.Merged : GitHubPRState.Closed;
  }
  return GitHubPRState.Open;
}

/**
 * Build a PullRequestDetail update payload from a webhook pull_request payload.
 * Only covers fields that may change on edit/reopen/sync.
 */
function pullRequestToDetailUpdate(pullRequest: PullRequest) {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    htmlUrl: pullRequest.html_url,
    body: pullRequest.body ?? null,
    prState: pullRequestState(pullRequest),
    isDraft: pullRequest.draft ?? false,
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    changedFiles: pullRequest.changed_files,
    closedAt: pullRequest.closed_at ? new Date(pullRequest.closed_at) : null,
    mergedAt: pullRequest.merged_at ? new Date(pullRequest.merged_at) : null,
    mergeCommitSha: pullRequest.merge_commit_sha ?? null,
  };
}
