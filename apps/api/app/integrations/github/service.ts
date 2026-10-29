import type {
  GitHubInstallationStatus as ApiGitHubInstallationStatus,
  GetBranchesResponse,
  GetPullRequestsResponse,
  GitHubIntegrationStatus,
} from "@repo/api/src/types/github";
import { GitHubInstallationStatus as ApiGitHubInstallationStatusValue } from "@repo/api/src/types/github";
import { Result, Status } from "@repo/api/src/types/result";
import type {
  GitHubInstallation,
  GitHubInstallationRepository,
} from "@repo/database";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { deleteInstallation } from "@repo/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { projectsService } from "@/app/projects/service";
import type { GitHubReadCostRoute } from "@/lib/github/github-read-cost-log";
import { filterUnclaimedRepositoryWebhookObservations } from "@/lib/github/repository-default-observation-receipt";
import type { OrganizationWriteOutcome } from "@/lib/organization-write-receipt";
import {
  type RecordWriteInTransaction,
  writeInShape,
} from "@/lib/record-write-in-transaction";
import { resolveGitHubDataConnectionStatus } from "./data-connection-status";
import {
  type ClaimGitHubInstallationDeps,
  claimGitHubInstallation,
  type InstallationClaimResult,
} from "./service/installation-claim";
import type { VerifiedObservedRepository } from "./service/observed-repository-read";
import type { RepositoryPullRequestReadOptions } from "./service/pull-request-list-read";
import { runRepositoryArtifactRelink } from "./service/repository-artifact-relink";
import {
  readBranches,
  readInstallationRepositories,
  readObservedRepositories,
  readPullRequests,
} from "./service/repository-read";
import {
  createRepositoryArtifactRelinkResult,
  RepositoryArtifactRelinkFailureStage,
  RepositoryArtifactRelinkReason,
  type RepositoryArtifactRelinkResult,
} from "./service/repository-relink-telemetry";
import {
  bulkUpsertInstallationRepositories,
  findInstallationRepositoriesByIds,
  type RepositoryInput,
  tombstoneRepositoriesAbsentFrom,
} from "./service/repository-sync";

/**
 * Canonical repo-input shape lives in the leaf `service/repository-sync.ts`.
 * Re-exported here to preserve the historical `RepositoryInput` public surface
 * of this module.
 */
export type { RepositoryInput } from "./service/repository-sync";

/**
 * GitHub integration service - handles all business logic and database operations
 */
export const githubService = {
  /**
   * Get the GitHub integration status for an organization.
   * Returns legacy App-installation status plus the additive GitHub data
   * connection predicate used by product-surface gating.
   */
  async getIntegrationStatus(
    organizationId: string,
    userId?: string | null
  ): Promise<GitHubIntegrationStatus> {
    const { githubDataConnection, installation } = await withDb(async (db) => {
      const installationResult = await db.gitHubInstallation.findFirst({
        where: {
          organizationId,
          status: {
            in: [
              GitHubInstallationStatus.ACTIVE,
              GitHubInstallationStatus.SUSPENDED,
            ],
          },
        },
        include: {
          repositories: { where: { removedAt: null } },
        },
      });
      const githubDataConnectionResult =
        await resolveGitHubDataConnectionStatus(db, {
          hasActiveInstallation:
            installationResult?.status === GitHubInstallationStatus.ACTIVE,
          organizationId,
          userId,
        });
      return {
        githubDataConnection: githubDataConnectionResult,
        installation: installationResult,
      };
    });

    if (!installation) {
      return {
        connected: false,
        githubDataConnection,
      };
    }

    return {
      connected: true,
      githubDataConnection,
      installation: {
        id: installation.id,
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        status: installation.status as ApiGitHubInstallationStatus,
        repositorySelection: installation.repositorySelection,
        repositoryCount: installation.repositories.length,
        claimedAt: installation.claimedAt?.toISOString() ?? null,
        createdAt: installation.createdAt.toISOString(),
      },
    };
  },

  /**
   * Create or update a GitHubInstallation record.
   * Uses upsert by installationId.
   */
  upsertInstallation(
    installationId: string,
    data: {
      accountId: string;
      accountLogin: string;
      accountType: string;
      senderLogin: string;
      senderId: string;
      status?: GitHubInstallationStatus;
      permissions?: unknown;
      events?: unknown;
      repositorySelection?: string;
      organizationId?: string;
    }
  ): Promise<GitHubInstallation> {
    return withDb((db) =>
      db.gitHubInstallation.upsert({
        where: { installationId },
        create: {
          installationId,
          accountId: data.accountId,
          accountLogin: data.accountLogin,
          accountType: data.accountType,
          senderLogin: data.senderLogin,
          senderId: data.senderId,
          status: data.status ?? "PENDING_CLAIM",
          permissions: data.permissions ?? undefined,
          events: data.events ?? undefined,
          repositorySelection: data.repositorySelection,
          organizationId: data.organizationId,
        },
        update: {
          accountId: data.accountId,
          accountLogin: data.accountLogin,
          accountType: data.accountType,
          senderLogin: data.senderLogin,
          senderId: data.senderId,
          status: data.status,
          permissions: data.permissions ?? undefined,
          events: data.events ?? undefined,
          repositorySelection: data.repositorySelection,
          organizationId: data.organizationId,
        },
      })
    );
  },

  /**
   * Update the status field of a GitHubInstallation.
   */
  async updateInstallationStatus(
    installationId: string,
    status: GitHubInstallationStatus,
    metadata?: {
      suspendedAt?: Date | null;
      suspendedBy?: string | null;
      claimedAt?: Date | null;
      claimedByUserId?: string | null;
    }
  ): Promise<GitHubInstallation> {
    try {
      const installation = await withDb((db) =>
        db.gitHubInstallation.update({
          where: { id: installationId },
          data: {
            status,
            ...metadata,
          },
        })
      );

      log.info("[github] Updated installation status", {
        installationId,
        status,
        organizationId: installation.organizationId,
      });

      return installation;
    } catch (error) {
      log.error("[github] Failed to update installation status", {
        installationId,
        status,
        error: parseError(error),
      });
      throw error;
    }
  },

  /**
   * Relink stale Branch View rows to the active credential repository chosen
   * by the resolver, then let callers reload a pinned-active context before
   * running any provider-backed sync writes.
   */
  async relinkBranchViewRepositoryCredential(input: {
    organizationId: string;
    activeRepositoryId: string;
  }): Promise<RepositoryArtifactRelinkResult> {
    const activeRepository = await withDb((db) =>
      db.gitHubInstallationRepository.findFirst({
        where: {
          id: input.activeRepositoryId,
          removedAt: null,
          installation: {
            organizationId: input.organizationId,
            status: GitHubInstallationStatus.ACTIVE,
          },
        },
        select: {
          id: true,
          githubRepoId: true,
          fullName: true,
          installationId: true,
        },
      })
    );
    if (!activeRepository) {
      return createRepositoryArtifactRelinkResult({
        reasons: [RepositoryArtifactRelinkReason.NoActiveRepositories],
      });
    }

    return await runRepositoryArtifactRelink({
      installationId: activeRepository.installationId,
      repositories: [activeRepository],
      expectedOrganizationId: input.organizationId,
      failureStage: RepositoryArtifactRelinkFailureStage.SyncPreflightRelink,
    });
  },

  /**
   * Sync repositories for an installation.
   * Uses upsert to preserve record IDs and tombstones repos no longer in the
   * active installation grant so historical projection FKs stay resolvable.
   */
  syncRepositories(
    installationId: string,
    repositories: RepositoryInput[]
  ): Promise<GitHubInstallationRepository[]> {
    return withDb
      .tx(async (tx) => {
        // Get the set of GitHub repo IDs we're syncing
        const incomingRepoIds = new Set(
          repositories.map((r) => r.githubRepoId)
        );

        // ISS-4618: tombstone repos absent from the incoming set by diffing the
        // installation's current non-removed ids in memory and updating only the
        // difference through chunked `in` statements. The old `notIn:
        // [...incomingRepoIds]` update bound one parameter per incoming id, which
        // overflows Postgres's 65,535 bind-parameter ceiling on a 65k+ grant
        // (davetho CR). Semantics are identical — precisely the repos no longer
        // present are tombstoned — and only the delta is written, so a
        // steady-state re-sync writes nothing.
        await tombstoneRepositoriesAbsentFrom(
          tx,
          installationId,
          incomingRepoIds
        );

        if (repositories.length === 0) {
          return [];
        }

        // ISS-4618: preserve IDs via one chunked set-based upsert (shared with
        // addRepositories) instead of a per-row Promise.all(upsert) loop that
        // serialized N round trips on the tx's pinned connection and would
        // P2028-time-out on a large sync batch. Clears removed_at tombstones so
        // a re-added repo becomes visible again (PLN-634).
        const repositoriesToUpsert =
          await filterUnclaimedRepositoryWebhookObservations(
            tx,
            installationId,
            repositories
          );
        await bulkUpsertInstallationRepositories(
          tx,
          installationId,
          repositoriesToUpsert
        );

        const syncedRepositories =
          await tx.gitHubInstallationRepository.findMany({
            where: { installationId, removedAt: null },
          });
        return syncedRepositories;
      })
      .then(async (syncedRepositories) => {
        if (syncedRepositories.length > 0) {
          await runRepositoryArtifactRelink({
            installationId,
            repositories: syncedRepositories,
            failureStage: RepositoryArtifactRelinkFailureStage.SyncRepositories,
          });
        }
        return syncedRepositories;
      });
  },

  /**
   * Add repositories to an installation (without removing existing ones).
   * Uses upsert to handle duplicates gracefully.
   */
  async addRepositories(
    installationId: string,
    repositories: RepositoryInput[]
  ): Promise<GitHubInstallationRepository[]> {
    if (repositories.length === 0) {
      log.info("[github] No repositories to add");
      return [];
    }

    const result = await withDb.tx(async (tx) => {
      // ISS-4618: one chunked set-based upsert (shared with syncRepositories)
      // instead of a per-row Promise.all(upsert) loop that serialized N round
      // trips on the tx's pinned connection and would P2028-time-out on a large
      // `installation_repositories` webhook batch (which GitHub redelivers on
      // failure). Clears removed_at tombstones from a prior disconnect (PLN-634).
      const repositoriesToUpsert =
        await filterUnclaimedRepositoryWebhookObservations(
          tx,
          installationId,
          repositories
        );
      await bulkUpsertInstallationRepositories(
        tx,
        installationId,
        repositoriesToUpsert
      );

      // ISS-4618: read the just-upserted rows through a chunked `in` lookup so
      // no single findMany binds one parameter per repo id — an unbounded
      // `in: [...ids]` list would overflow Postgres's 65,535 bind-parameter
      // ceiling on a large `installation_repositories` webhook batch. Semantics
      // are unchanged: the same rows are returned (ids deduped so a repeated id
      // in the batch can't duplicate a row).
      const githubRepoIds = repositories.map((r) => r.githubRepoId);
      const addedRepositories = await findInstallationRepositoriesByIds(
        tx,
        installationId,
        githubRepoIds
      );
      return addedRepositories;
    });

    await runRepositoryArtifactRelink({
      installationId,
      repositories: result,
      failureStage: RepositoryArtifactRelinkFailureStage.AddRepositories,
    });

    log.info("[github] Added repositories", {
      installationId,
      count: result.length,
    });

    return result;
  },

  /**
   * Find a GitHubInstallation by our internal id.
   */
  findInstallationById(id: string): Promise<GitHubInstallation | null> {
    return withDb((db) =>
      db.gitHubInstallation.findUnique({
        where: { id },
        include: {
          repositories: true,
        },
      })
    );
  },

  /**
   * Find a GitHubInstallation by GitHub's installationId.
   */
  findInstallationByInstallationId(
    installationId: string
  ): Promise<GitHubInstallation | null> {
    return withDb((db) =>
      db.gitHubInstallation.findUnique({
        where: { installationId },
        include: {
          repositories: true,
        },
      })
    );
  },

  /**
   * Find the GitHub installationId for a repository fullName owned by an organization.
   * Skips tombstoned repos (PLN-634) so dispatch never targets a removed repo.
   */
  async findInstallationForRepoFullName(
    organizationId: string,
    fullName: string
  ): Promise<string | null> {
    const repository = await withDb((db) =>
      db.gitHubInstallationRepository.findFirst({
        where: {
          fullName,
          removedAt: null,
          installation: {
            organizationId,
            status: ApiGitHubInstallationStatusValue.Active,
          },
        },
        select: {
          installation: {
            select: {
              installationId: true,
            },
          },
        },
      })
    );

    return repository?.installation.installationId ?? null;
  },

  /**
   * Tombstone GitHubInstallationRepository records by githubRepoId.
   * Used when repositories are removed from an installation. Rows are
   * preserved so historical PR/branch records and pending dirty-scope nudges
   * keep a resolvable repository identity.
   */
  async removeRepositories(
    installationId: string,
    githubRepoIds: string[]
  ): Promise<void> {
    if (githubRepoIds.length === 0) {
      log.info("[github] No repositories to remove");
      return;
    }

    await withDb((db) =>
      db.gitHubInstallationRepository.updateMany({
        where: {
          installationId,
          githubRepoId: { in: githubRepoIds },
          removedAt: null,
        },
        data: {
          removedAt: new Date(),
        },
      })
    );

    log.info("[github] Tombstoned repositories", {
      installationId,
      count: githubRepoIds.length,
      githubRepoIds,
    });
  },

  /**
   * Disconnect an installation from an organization.
   *
   * Marks the installation UNINSTALLED but preserves `organizationId` so a
   * subsequent reconnect from the same GitHub account can reuse the row
   * in-place (see `reconnectByAccount`). Without preservation, the cascade
   * chain GitHubInstallation → GitHubInstallationRepository → TeamRepository
   * (and BranchDetail / PullRequestDetail) would destroy org-level repo
   * configuration and branch/PR history on every disconnect.
   *
   * Idempotent because Settings may send a DELETE from stale cached UI after
   * another tab, webhook, or local repair has already disconnected.
   */
  async disconnectInstallation(
    organizationId: string,
    /**
     * Runs on the local UNINSTALLED transition's transaction (ISS-12552),
     * before the GitHub uninstall; not called when there is nothing to
     * disconnect.
     */
    recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>
  ): Promise<void> {
    const installation = await withDb((db) =>
      db.gitHubInstallation.findFirst({
        where: { organizationId },
        select: { id: true, installationId: true },
      })
    );

    if (!installation) {
      log.info("[github] No installation found to disconnect", {
        organizationId,
      });
      return;
    }

    const markUninstalled = () =>
      withDb((db) =>
        db.gitHubInstallation.updateMany({
          where: { id: installation.id, organizationId },
          data: { status: GitHubInstallationStatus.UNINSTALLED },
        })
      );
    const leaseResult = await writeInShape(recordWrite, {
      unrecorded: markUninstalled,
      recorded: (record) =>
        withDb.tx(async (tx) => {
          const updated = await markUninstalled();
          if (updated.count === 1) {
            await record(tx, { changed: true });
          }
          return updated;
        }),
    });
    if (leaseResult.count !== 1) {
      log.warn("[github] Skipped disconnect because ownership changed", {
        installationId: installation.id,
        githubInstallationId: installation.installationId,
        organizationId,
      });
      return;
    }

    // Uninstall from GitHub only after the org-scoped local transition wins.
    const result = await deleteInstallation(installation.installationId);

    if (!result.success) {
      log.warn(
        "[github] Failed to uninstall from GitHub, continuing with local disconnect",
        {
          installationId: installation.installationId,
          error: result.error,
        }
      );
      // Continue anyway - we've marked UNINSTALLED locally.
    }

    log.info("[github] Disconnected and uninstalled", {
      installationId: installation.id,
      githubInstallationId: installation.installationId,
      organizationId,
      uninstalledFromGitHub: result.success,
    });
  },

  /**
   * Claim a GitHub App installation for an organization (PLN-1742 M5).
   * Thin delegate: the concern module must not import this composition root
   * back (apps/api AGENTS.md), so the two service methods it needs are
   * injected here. `deps` overrides are test seams — realdb tests inject the
   * app-JWT lookup and the per-caller access proofs.
   */
  claimGitHubInstallation(
    input: { installationId: string; organizationId: string; userId: string },
    deps: Partial<ClaimGitHubInstallationDeps> = {}
  ): Promise<InstallationClaimResult> {
    return claimGitHubInstallation(input, {
      findInstallationByInstallationId: (installationId) =>
        this.findInstallationByInstallationId(installationId),
      syncRepositories: (installationRecordId, repositories) =>
        this.syncRepositories(installationRecordId, repositories),
      ...deps,
    });
  },

  /**
   * Confirm and execute the different-account reset (PLN-634 Phase 3).
   *
   * Runs once the admin has confirmed the destructive cleanup that swaps the
   * org from GitHub account A to account B. Side effects, all in one
   * transaction:
   *  - Delete `TeamRepository` rows for every team in the org.
   *  - Tombstone `GitHubInstallationRepository` rows owned by the prior
   *    installation. Branch / PR repository FKs remain non-null, so old
   *    repository rows stay FK-resolvable while render recovery and explicit
   *    relink paths restore visibility through a live installation generation.
   *  - Clear `organizationId` on the prior `GitHubInstallation` row to
   *    release the `@unique` slot. The row remains in the DB as an orphan.
   *  - Claim the new installation row for the org (mark ACTIVE).
   *  - Wipe `Project.settings.repositoryOverrides` for every project in the
   *    org.
   *  - Emit an audit log line with prior/new account ids and counts.
   *
   * `RepoBootstrapConfig` is not touched here: ISS-12435 deleted its rows,
   * and the table stays until the drop follow-up.
   */
  confirmDifferentAccountReset(input: {
    organizationId: string;
    userId: string;
  }): Promise<Result<{ confirmed: true }>> {
    return withDb.tx<Result<{ confirmed: true }>>(async (tx) => {
      const prior = await tx.gitHubInstallation.findFirst({
        where: {
          organizationId: input.organizationId,
          status: GitHubInstallationStatus.UNINSTALLED,
        },
        select: {
          id: true,
          accountId: true,
          accountLogin: true,
          pendingNewInstallationId: true,
        },
      });
      if (!prior) {
        log.warn("[github/reset] No prior UNINSTALLED installation found", {
          organizationId: input.organizationId,
        });
        return Result.err(Status.BadRequest);
      }
      // Read the installation to claim from the prior row, not from the
      // request body. The OAuth callback pins this value when it detects the
      // mismatch, so a phished admin posting a crafted body cannot redirect
      // the claim to an attacker-owned installation.
      if (!prior.pendingNewInstallationId) {
        log.warn(
          "[github/reset] No pending new installation pinned on prior row",
          {
            organizationId: input.organizationId,
            priorInstallationId: prior.id,
          }
        );
        return Result.err(Status.BadRequest);
      }

      const newInstall = await tx.gitHubInstallation.findUnique({
        where: { installationId: prior.pendingNewInstallationId },
        select: {
          id: true,
          organizationId: true,
          accountId: true,
          accountLogin: true,
        },
      });
      if (!newInstall) {
        log.warn("[github/reset] Pinned new installation not found", {
          organizationId: input.organizationId,
          pendingNewInstallationId: prior.pendingNewInstallationId,
        });
        return Result.err(Status.BadRequest);
      }
      if (newInstall.accountId === prior.accountId) {
        log.warn(
          "[github/reset] Reset called with same-account install; reject",
          {
            organizationId: input.organizationId,
            accountId: prior.accountId,
          }
        );
        return Result.err(Status.BadRequest);
      }
      if (
        newInstall.organizationId &&
        newInstall.organizationId !== input.organizationId
      ) {
        log.warn(
          "[github/reset] New installation already claimed by another org",
          {
            organizationId: input.organizationId,
            newInstallationOrgId: newInstall.organizationId,
          }
        );
        return Result.err(Status.Forbidden);
      }

      const teamReposDeleted = await tx.teamRepository.deleteMany({
        where: { team: { organizationId: input.organizationId } },
      });

      // Tombstone all repos previously linked to this installation row.
      // `installationId` here is the FK to GitHubInstallation.id (UUID),
      // not the GitHub App installation ID string.
      await tx.gitHubInstallationRepository.updateMany({
        where: { installationId: prior.id, removedAt: null },
        data: { removedAt: new Date() },
      });

      // Releasing the @unique(organizationId) slot must happen before we
      // claim the new row for the same org. Clearing pendingNewInstallationId
      // here prevents a second confirm-reset call from re-firing this flow.
      await tx.gitHubInstallation.update({
        where: { id: prior.id },
        data: { organizationId: null, pendingNewInstallationId: null },
        select: { id: true },
      });

      await tx.gitHubInstallation.update({
        where: { id: newInstall.id },
        data: {
          organizationId: input.organizationId,
          status: GitHubInstallationStatus.ACTIVE,
          claimedAt: new Date(),
          claimedByUserId: input.userId,
        },
        select: { id: true },
      });

      // Sibling-service call — joins the outer transaction via
      // AsyncLocalStorage so the wipe is atomic with the installation swap.
      const projectsCleared =
        await projectsService.clearRepositorySettingsForOrganization(
          input.organizationId
        );

      log.info("[github/reset] Different-account reset completed", {
        organizationId: input.organizationId,
        userId: input.userId,
        priorAccountId: prior.accountId,
        priorAccountLogin: prior.accountLogin,
        newAccountId: newInstall.accountId,
        newAccountLogin: newInstall.accountLogin,
        priorInstallationId: prior.id,
        newInstallationId: newInstall.id,
        teamRepositoriesDeleted: teamReposDeleted.count,
        projectsWithOverridesCleared: projectsCleared,
      });

      return Result.ok({ confirmed: true as const });
    });
  },

  /**
   * The organization's ACTIVE installation repositories, and only those. The
   * installation-free lane is `getObservedRepositories`, and the public store
   * is reachable only through `getBranches`; a caller assembling the org's full
   * repository list has to call both. Implementations live in
   * `service/repository-read.ts`.
   */
  getRepositories(
    organizationId: string,
    orderBy?: Array<{
      lastPushedAt?: { sort: "asc" | "desc"; nulls?: "first" | "last" };
      name?: "asc" | "desc";
    }>
  ): Promise<GitHubInstallationRepository[]> {
    return readInstallationRepositories(organizationId, orderBy);
  },

  getObservedRepositories(
    organizationId: string
  ): Promise<VerifiedObservedRepository[]> {
    return readObservedRepositories(organizationId);
  },

  getBranches(
    repositoryId: string,
    organizationId: string,
    limit = 20,
    allowPublicFallback = true,
    readerUserId?: string
  ): Promise<GetBranchesResponse> {
    return readBranches(
      repositoryId,
      organizationId,
      limit,
      allowPublicFallback,
      readerUserId
    );
  },

  getPullRequests(
    repositoryId: string,
    organizationId: string,
    projectId: string | null,
    options?: RepositoryPullRequestReadOptions,
    costRoute?: GitHubReadCostRoute,
    readerUserId?: string
  ): Promise<GetPullRequestsResponse> {
    return readPullRequests(
      repositoryId,
      organizationId,
      projectId,
      options,
      costRoute,
      readerUserId
    );
  },
};
