import type { PushEvent } from "@octokit/webhooks-types";
import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
  BranchPushSource,
  LinkType,
} from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  GitHubDirtyScopeKind,
  GitHubDirtyTrigger,
} from "@repo/api/src/types/github-dirty-scope";
import {
  type RepositoryDefaultAuthority,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { Status } from "@repo/api/src/types/result";
import { MAX_SYNCED_COMMIT_MESSAGE_LENGTH } from "@repo/api/src/types/session-artifact-link";
import { expandSlugAliases } from "@repo/api/src/types/slug-prefix";
import {
  ArtifactType,
  GitHubInstallationStatus,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { parseArtifactReferences } from "@repo/github/artifact-reference-parser";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import {
  branchService,
  type UpsertBranchArtifactInput,
} from "@/app/branches/branch-service";
import { resolveCloudBranchWriteEligibility } from "@/app/branches/branch-write-eligibility";
import { refreshBranchFileChangeCache } from "@/app/branches/file-cache-service";
import {
  commitService,
  type WebhookCommitInput,
} from "@/app/commits/commit-service";
import { bulkUpsertInstallationRepositories } from "@/app/integrations/github/service/repository-sync";
import type { GitHubWebhookObservationContext } from "@/lib/github/github-webhook-observation";
import { mapGitHubWebhookRepositoryDefaultAuthority } from "@/lib/github/repository-default-authority";
import {
  claimRepositoryDefaultObservationReceipt,
  RepositoryDefaultObservationTargetKind,
} from "@/lib/github/repository-default-observation-receipt";
import { githubAppWebhookFetchProvenance } from "@/lib/github-fetch-provenance";
import { pickPrimaryArtifactReference } from "./artifact-reference";
import {
  GitHubBranchActivityEventName,
  persistGitHubBranchActivity,
} from "./branch-activity-producer";
import { publishGitHubDirtyScopes } from "./dirty-scope-publisher";

const HEAD_REF_PREFIX = "refs/heads/";

/**
 * Handle GitHub push webhook events.
 *
 * Updates lastPushedAt timestamp for the repository and logs push metadata.
 * Silently skips if no matching installation repository found.
 *
 * Security: Scopes updates to the specific installation to prevent updating
 * repositories across multiple installations with the same githubRepoId.
 */
export async function handlePush(
  event: PushEvent,
  observation?: GitHubWebhookObservationContext
): Promise<Response> {
  const {
    ref,
    repository,
    before,
    after,
    commits,
    installation,
    created,
    deleted,
  } = event;

  const installationId = installation?.id;
  const branchName = parseBranchName(ref);

  log.debug("[handlePush] Processing push event", {
    repositoryFullName: repository.full_name,
    githubRepoId: repository.id,
    installationId,
    ref,
    commitsCount: commits.length,
    beforeSha: before,
    afterSha: after,
  });

  if (!installationId) {
    log.error("github_repository_default_authority_malformed", {
      outcome: "missing_installation_id",
      providerRepositoryId: String(repository.id),
      repositoryFullName: repository.full_name,
      source: RepositoryDefaultSource.PushWebhook,
    });
    return NextResponse.json({
      message: "Push event missing installation identity, ignoring",
      ok: true,
    });
  }

  if (!branchName) {
    log.debug("[handlePush] Skipping non-branch ref", { ref });
    return NextResponse.json({
      message: "Ignoring non-branch push ref",
      ok: true,
    });
  }

  const repositoryRow = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        githubRepoId: String(repository.id),
        fullName: repository.full_name,
        removedAt: null,
        installation: {
          installationId: String(installationId),
          status: GitHubInstallationStatus.ACTIVE,
          organizationId: { not: null },
        },
      },
      select: {
        id: true,
        installationId: true,
        fullName: true,
        installation: { select: { organizationId: true } },
      },
    })
  );

  if (!repositoryRow?.installation.organizationId) {
    log.debug("[handlePush] Repository not found in database, skipping", {
      githubRepoId: repository.id,
      repositoryFullName: repository.full_name,
    });
    return NextResponse.json({
      message: "Repository not tracked, ignoring push event",
      ok: true,
    });
  }
  const organizationId = repositoryRow.installation.organizationId;

  const lastPushedAt = repository.pushed_at
    ? new Date(
        typeof repository.pushed_at === "number"
          ? repository.pushed_at * 1000
          : repository.pushed_at
      )
    : new Date();

  const defaultAuthority = mapGitHubWebhookRepositoryDefaultAuthority(
    repository,
    RepositoryDefaultSource.PushWebhook,
    observation,
    lastPushedAt
  );
  const authorityEventIsCurrent = await withDb.tx(async (tx) => {
    if (
      observation &&
      !(await claimRepositoryDefaultObservationReceipt(tx, {
        organizationId,
        targetKind:
          RepositoryDefaultObservationTargetKind.GitHubInstallationRepository,
        targetId: repositoryRow.id,
        source: RepositoryDefaultSource.PushWebhook,
        observationKey: observation.deliveryId,
        observedAt: observation.observedAt,
      }))
    ) {
      return false;
    }
    const pushedAtUpdate = await tx.gitHubInstallationRepository.updateMany({
      where: {
        id: repositoryRow.id,
        OR: [{ lastPushedAt: null }, { lastPushedAt: { lt: lastPushedAt } }],
      },
      data: { lastPushedAt },
    });
    const authorityEventIsCurrent =
      pushedAtUpdate.count > 0 ||
      (await hasEqualStoredPushTime(tx, repositoryRow.id, lastPushedAt));
    if (defaultAuthority && authorityEventIsCurrent) {
      await bulkUpsertInstallationRepositories(
        tx,
        repositoryRow.installationId,
        [
          {
            githubRepoId: String(repository.id),
            fullName: repository.full_name,
            name: repository.name,
            owner: repository.owner.login,
            private: repository.private,
            defaultAuthority,
          },
        ]
      );
    }
    return authorityEventIsCurrent;
  });
  const eligibilityInput = buildPushEligibilityInput({
    organizationId,
    repositoryId: repositoryRow.id,
    repositoryFullName: repositoryRow.fullName,
    branchName,
    defaultAuthority,
    useFreshObservation: Boolean(authorityEventIsCurrent && observation),
  });
  const branchEligibility = await withDb((db) =>
    resolveCloudBranchWriteEligibility(db, eligibilityInput)
  );
  if (branchEligibility.kind === "not_materialized") {
    log.debug("[handlePush] Branch push excluded by default authority", {
      cause: branchEligibility.cause,
      reason: branchEligibility.reason,
      branchName,
      repositoryFullName: repository.full_name,
    });
    return NextResponse.json({
      message: "Default branch push ignored",
      ok: true,
    });
  }

  const source = await resolvePushSourceArtifact({
    organizationId: repositoryRow.installation.organizationId,
    repositoryFullName: repositoryRow.fullName,
    branchName,
  });
  if (source.kind === "skipped") {
    log.debug("[handlePush] Branch push skipped, no resolvable lineage", {
      branchName,
      repositoryFullName: repository.full_name,
      reason: source.reason,
    });
    return NextResponse.json({
      message: "No resolvable lineage for branch push",
      ok: true,
    });
  }

  const result = await branchService.upsertBranchArtifact({
    ...eligibilityInput,
    defaultBranch: repository.default_branch,
    projectId: source.projectId,
    sourceArtifactId: source.sourceArtifactId,
    createdById: source.createdById,
    baseBranch: repository.default_branch,
    baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
    headSha: deleted ? null : after,
    headShaSource: deleted ? null : BranchHeadShaSource.PushWebhook,
    headShaObservedAt: lastPushedAt,
    // The push payload has no documented per-delivery occurrence timestamp.
    // Keep head ordering metadata, but let the canonical activity producer
    // fail closed instead of treating repository state or receipt time as
    // qualifying Last-active evidence.
    activityAt: null,
    // PRD-510 FR2 / PLN-1099 Phase 2: a non-delete push is unambiguous push
    // evidence — stamp it set-once/earliest-wins in the service. A delete is not
    // a push, so leave push state untouched (null → service no-op, never clears).
    firstPushedAt: deleted ? null : lastPushedAt,
    pushSource: deleted ? null : BranchPushSource.Webhook,
    fetchProvenance: githubAppWebhookFetchProvenance(),
    beforeSha: before,
    isCreate: created,
    isDelete: deleted,
    deletedAt: deleted ? lastPushedAt : null,
  });

  if (!result.ok) {
    const message =
      result.error === Status.Conflict
        ? "Stale branch push ignored"
        : "Branch push rejected";
    log.debug("[handlePush] Branch materialization skipped", {
      branchName,
      repositoryFullName: repository.full_name,
      status: result.error,
    });
    return NextResponse.json({ message, ok: true });
  }
  await persistGitHubBranchActivity({
    eventName: GitHubBranchActivityEventName.Push,
    deliveryId: observation?.deliveryId,
    payload: event,
    attribution: {
      organizationId,
      branchArtifactId: result.value.id,
    },
  });

  if (!deleted) {
    waitUntil(
      refreshBranchFileChangeCache(result.value.id, {
        organizationId: repositoryRow.installation.organizationId,
      })
        .then((refreshResult) => {
          if (!refreshResult.ok) {
            log.warn(
              "[handlePush] Branch file-cache refresh did not complete",
              {
                branchArtifactId: result.value.id,
                status: refreshResult.error,
              }
            );
          }
        })
        .catch((error) => {
          log.warn("[handlePush] Branch file-cache refresh failed", {
            branchArtifactId: result.value.id,
            organizationId: repositoryRow.installation.organizationId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
    );
  }

  log.debug("[handlePush] Materialized branch artifact from push", {
    branchArtifactId: result.value.id,
    branchName,
    githubRepoId: repository.id,
  });

  // FEA-2731 / PRD-510 D7: persist the push payload's commits into the
  // CommitDetail SSOT. Runs after materialization so the branch artifact FK
  // exists; skipped for deletes inside the helper.
  await persistPushCommits({
    deleted,
    organizationId: repositoryRow.installation.organizationId,
    repositoryFullName: repositoryRow.fullName,
    branchArtifactId: result.value.id,
    commits,
  });

  await publishGitHubDirtyScopes({
    organizationId: repositoryRow.installation.organizationId,
    repositoryId: repositoryRow.id,
    repositoryFullName: repositoryRow.fullName,
    scopes: [
      {
        kind: GitHubDirtyScopeKind.Branch,
        repositoryId: repositoryRow.id,
        repositoryFullName: repositoryRow.fullName,
        branchName,
      },
    ],
    triggers: [GitHubDirtyTrigger.Push],
  });

  return NextResponse.json({
    message: "Push event processed successfully",
    ok: true,
  });
}

/** Preserve repository authority when a newly received push is provider-stale. */
async function hasEqualStoredPushTime(
  tx: TransactionClient,
  repositoryId: string,
  incomingPushedAt: Date
): Promise<boolean> {
  const current = await tx.gitHubInstallationRepository.findUnique({
    where: { id: repositoryId },
    select: { lastPushedAt: true },
  });
  return current?.lastPushedAt?.getTime() === incomingPushedAt.getTime();
}

/** Parse a GitHub push `commit.timestamp`/`author.date` into a Date, else null. */
function toWebhookCommitTimestamp(
  value: string | null | undefined
): Date | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Map a push payload's `commits[]` to the commit service's input. GitHub is
 * authoritative for the full sha, author, and dates; `filesChanged` is derived
 * from the changed-file lists. The push event carries NO per-line counts, so
 * `linesAdded`/`linesRemoved` are omitted and left for the desktop fallback
 * (which fills only nulls) or a later github_api enrichment.
 */
function mapPushCommits(commits: PushEvent["commits"]): WebhookCommitInput[] {
  return commits.map((commit) => ({
    sha: commit.id,
    // Bound the message to the same cap the desktop lane enforces
    // (MAX_SYNCED_COMMIT_MESSAGE_LENGTH): both producers write the same unbounded
    // `@db.Text` column, so a pathological commit message must not bloat storage
    // from the webhook side either. Author fields are naturally bounded by GitHub.
    message: commit.message.slice(0, MAX_SYNCED_COMMIT_MESSAGE_LENGTH),
    committedAt: toWebhookCommitTimestamp(commit.timestamp),
    authoredAt: toWebhookCommitTimestamp(commit.author.date),
    authorName: commit.author.name,
    authorEmail: commit.author.email,
    authorLogin: commit.author.username ?? null,
    // Derived from the push payload's per-commit file lists, which GitHub can
    // TRUNCATE for very large commits — so this may UNDERCOUNT, and since it is
    // written as GitHub-authoritative (overwrites a desktop value via pickField)
    // it could clobber a more accurate desktop-parsed count. Accepted: it is the
    // only source for webhook-only repos and is correct for the common case
    // (null would be worse); the authoritative correction is a later github_api
    // enrichment (source `github_api`), which reads the full file count.
    filesChanged:
      commit.added.length + commit.modified.length + commit.removed.length,
  }));
}

/**
 * Best-effort commit persistence for a push. Skips deletes (no commits) and
 * empty pushes, and never throws: a commit-write failure is logged but must not
 * fail branch materialization or the webhook ack — commits converge via GitHub
 * re-delivery and the desktop sync lane.
 */
async function persistPushCommits(input: {
  deleted: boolean;
  organizationId: string;
  repositoryFullName: string;
  branchArtifactId: string;
  commits: PushEvent["commits"];
}): Promise<void> {
  if (input.deleted || input.commits.length === 0) {
    return;
  }
  try {
    await commitService.recordWebhookCommits({
      organizationId: input.organizationId,
      repositoryFullName: input.repositoryFullName,
      branchArtifactId: input.branchArtifactId,
      commits: mapPushCommits(input.commits),
    });
  } catch (error) {
    log.warn("[handlePush] Commit persistence failed", {
      branchArtifactId: input.branchArtifactId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseBranchName(ref: string): string | null {
  return ref.startsWith(HEAD_REF_PREFIX)
    ? ref.slice(HEAD_REF_PREFIX.length)
    : null;
}

function buildPushEligibilityInput(input: {
  organizationId: string;
  repositoryId: string;
  repositoryFullName: string;
  branchName: string;
  defaultAuthority: RepositoryDefaultAuthority | undefined;
  useFreshObservation: boolean;
}): Pick<
  UpsertBranchArtifactInput,
  | "organizationId"
  | "repositoryId"
  | "repositoryFullName"
  | "branchName"
  | "repositoryDefaultObservation"
> {
  const base = {
    organizationId: input.organizationId,
    repositoryId: input.repositoryId,
    repositoryFullName: input.repositoryFullName,
    branchName: input.branchName,
  };
  if (!input.useFreshObservation) {
    return base;
  }
  return {
    ...base,
    repositoryDefaultObservation: input.defaultAuthority
      ? { authority: input.defaultAuthority }
      : undefined,
  };
}

type PushSourceResolution = {
  kind: "resolved";
  sourceArtifactId: string | null;
  projectId: string | null;
  createdById: string | null;
};

type PushSourceSkip = {
  kind: "skipped";
  reason: PushSourceSkipReason;
};

async function resolvePushSourceArtifact({
  organizationId,
  repositoryFullName,
  branchName,
}: {
  organizationId: string;
  repositoryFullName: string;
  branchName: string;
}): Promise<PushSourceResolution | PushSourceSkip> {
  const primaryRef = pickPrimaryArtifactReference(
    parseArtifactReferences(branchName, "", process.env.NEXT_PUBLIC_APP_URL)
  );

  if (primaryRef) {
    // FEA-4137: an `iss-42-*` branch may reference an existing `FEA-42` row (and
    // an old `fea-42-*` branch a new `ISS-42` row). Resolve through cross-prefix
    // aliases so the push links the right source artifact under either spelling.
    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: {
          organizationId,
          slug: { in: expandSlugAliases(primaryRef.slug) },
          type: ArtifactType.DOCUMENT,
          subtype: primaryRef.docType,
        },
        select: { id: true, createdById: true, projectId: true },
      })
    );
    if (artifact) {
      return {
        kind: "resolved",
        sourceArtifactId: artifact.id,
        projectId: artifact.projectId,
        createdById: artifact.createdById,
      };
    }
  }

  // Resolve any existing branch row by the PRD-510 D2 identity
  // `(organizationId, repositoryFullName, branchName)` — the same org-scoped,
  // App-installation-independent key `upsertBranchArtifact` writes and reads by.
  // The webhook must NOT key this on repositoryId: the desktop producer creates
  // a branch first-seen as non-App with `repositoryId = null` (D2/FR8), so a
  // concrete-repositoryId lookup would miss that row, skip the push, and never
  // reach `upsertBranchArtifact` — where the same D2 key finds the row and
  // adopts the concrete repositoryId (upgrade-only). Using the D2 key here lets
  // a pre-App desktop row resolve so the push adopts its id and updates it.
  const existingBranch = await withDb((db) =>
    db.branchDetail.findUnique({
      where: {
        organizationId_repositoryFullName_branchName: {
          organizationId,
          repositoryFullName: normalizeRepoFullName(repositoryFullName),
          branchName,
        },
      },
      select: {
        artifact: {
          select: {
            projectId: true,
            targetLinks: {
              where: {
                linkType: LinkType.Produces,
                source: { type: ArtifactType.DOCUMENT },
              },
              select: { source: { select: { id: true, createdById: true } } },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
      },
    })
  );
  if (!existingBranch) {
    // FEA-3325 / FEA-1749 (PLN-1354 Phase 4): there is deliberately NO
    // repository -> project fallback here. A project may nominate default
    // repositories for agentic execution, but that does not make a repository
    // belong to a project — the relation does not exist in the domain. The
    // fallback removed here inferred one anyway whenever exactly one project
    // marked the repo `isDefaultSelected`, silently attributing an ad-hoc
    // branch to an arbitrary project and re-attributing it the moment a second
    // project nominated the same repo. Mirrors `resolveProjectId` in
    // app/agent-sessions/service/project-resolution.ts, which dropped the
    // equivalent inference from the session attribution lane.
    //
    // Reaching here means the branch name resolved to no artifact (no slug, or
    // a slug that matched none) AND no producer has created a branch row under
    // the D2 key yet, so nothing associates this branch with a project. Skip it
    // rather than materialize under a fabricated parent. Once any producer
    // (typically the desktop sync lane) creates the row, the lookup above
    // resolves and subsequent pushes update it normally.
    return {
      kind: "skipped",
      reason: PushSourceSkipReason.UnresolvedBranchLineage,
    };
  }
  const linkedSource = existingBranch.artifact.targetLinks[0]?.source ?? null;
  return {
    kind: "resolved",
    sourceArtifactId: linkedSource?.id ?? null,
    projectId: existingBranch.artifact.projectId,
    createdById: linkedSource?.createdById ?? null,
  };
}

/** Why a push did not materialize or update a branch artifact. */
export const PushSourceSkipReason = {
  /**
   * The branch name resolved to no artifact (no slug reference, or a slug that
   * matched none) and no producer has created a branch row under the D2 key
   * yet, so nothing establishes lineage for it. See the FEA-3325 note in
   * `resolvePushSourceArtifact`.
   */
  UnresolvedBranchLineage: "unresolved_branch_lineage",
} as const;

export type PushSourceSkipReason =
  (typeof PushSourceSkipReason)[keyof typeof PushSourceSkipReason];
