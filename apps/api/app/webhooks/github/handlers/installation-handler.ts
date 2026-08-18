import type {
  InstallationCreatedEvent,
  InstallationDeletedEvent,
  InstallationSuspendEvent,
  InstallationUnsuspendEvent,
} from "@octokit/webhooks-types";
import { RepositoryDefaultSource } from "@repo/api/src/types/repository-default-identity";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { githubService } from "@/app/integrations/github/service";
import type { RepositoryInput } from "@/app/integrations/github/service/repository-sync";
import type { GitHubWebhookObservationContext } from "@/lib/github/github-webhook-observation";
import { mapGitHubWebhookRepositoryDefaultAuthority } from "@/lib/github/repository-default-authority";

/**
 * Convert webhook repository data to RepositoryInput format.
 */
export function toRepositoryInput(
  repo: {
    id: number;
    full_name: string;
    name: string;
    private: boolean;
    default_branch?: unknown;
  },
  fallbackOwner: string,
  authorityContext?: {
    observation: GitHubWebhookObservationContext | undefined;
  }
): RepositoryInput {
  const [owner] = repo.full_name.split("/");
  return {
    githubRepoId: String(repo.id),
    fullName: repo.full_name,
    name: repo.name,
    owner: owner || fallbackOwner,
    private: repo.private,
    ...(authorityContext
      ? {
          defaultAuthority: mapGitHubWebhookRepositoryDefaultAuthority(
            repo,
            RepositoryDefaultSource.InstallationWebhook,
            authorityContext.observation
          ),
        }
      : {}),
  };
}

/**
 * Handle GitHub App installation created event.
 * Upserts installation record and syncs repositories.
 */
export async function handleInstallationCreated(
  event: InstallationCreatedEvent,
  observation?: GitHubWebhookObservationContext
): Promise<void> {
  const { installation, repositories = [], sender } = event;

  // Upsert installation record
  // On reinstall, preserve organizationId only if the installation is still ACTIVE (Q-003)
  // If the installation was UNINSTALLED (user disconnected), we need fresh claim via OAuth
  const existingInstallation =
    await githubService.findInstallationByInstallationId(
      String(installation.id)
    );

  // Only preserve org link if the installation was ACTIVE or SUSPENDED (not UNINSTALLED)
  const shouldPreserveOrg =
    existingInstallation?.organizationId &&
    existingInstallation.status !== GitHubInstallationStatus.UNINSTALLED;

  const upsertedInstallation = await githubService.upsertInstallation(
    String(installation.id),
    {
      accountId: String(installation.account.id),
      accountLogin: installation.account.login,
      accountType: installation.target_type,
      senderLogin: sender.login,
      senderId: String(sender.id),
      // Set PENDING_CLAIM if not preserving org link
      status: shouldPreserveOrg ? undefined : "PENDING_CLAIM",
      permissions: installation.permissions,
      events: installation.events,
      repositorySelection: installation.repository_selection,
      // Preserve organizationId only if installation wasn't explicitly disconnected
      organizationId: shouldPreserveOrg
        ? (existingInstallation.organizationId ?? undefined)
        : undefined,
    }
  );

  // Sync repositories
  if (repositories.length > 0) {
    const repositoryInputs = repositories.map((repo) =>
      toRepositoryInput(repo, installation.account.login, {
        observation,
      })
    );

    await githubService.syncRepositories(
      upsertedInstallation.id,
      repositoryInputs
    );
  }
}

/**
 * Handle GitHub App installation deleted event.
 * Updates the installation status to UNINSTALLED.
 */
export async function handleInstallationDeleted(
  event: InstallationDeletedEvent
): Promise<void> {
  const { installation } = event;

  const existingInstallation =
    await githubService.findInstallationByInstallationId(
      String(installation.id)
    );

  if (!existingInstallation) {
    log.warn("[handleInstallationDeleted] Installation not found", {
      installationId: installation.id,
    });
    return;
  }

  // Preserve organizationId so a subsequent same-account reconnect can reuse
  // this row in-place (see reconnectByAccount). Different-account reconnect
  // explicitly clears it after admin confirmation (see cleanupForDifferentAccount).
  await withDb((db) =>
    db.gitHubInstallation.update({
      where: { id: existingInstallation.id },
      data: {
        status: GitHubInstallationStatus.UNINSTALLED,
      },
      select: { id: true },
    })
  );
}

/**
 * Handle GitHub App installation suspended event.
 * Updates the installation status to SUSPENDED and sets suspendedAt/suspendedBy fields.
 */
export async function handleInstallationSuspended(
  event: InstallationSuspendEvent
): Promise<void> {
  const { installation, sender } = event;

  const existingInstallation =
    await githubService.findInstallationByInstallationId(
      String(installation.id)
    );

  if (!existingInstallation) {
    log.warn("[handleInstallationSuspended] Installation not found", {
      installationId: installation.id,
    });
    return;
  }

  await githubService.updateInstallationStatus(
    existingInstallation.id,
    GitHubInstallationStatus.SUSPENDED,
    {
      suspendedAt: new Date(),
      suspendedBy: sender.login,
    }
  );
}

/**
 * Handle GitHub App installation unsuspended event.
 * Determines new status based on current state and clears suspension fields.
 */
export async function handleInstallationUnsuspended(
  event: InstallationUnsuspendEvent
): Promise<void> {
  const { installation } = event;

  const existingInstallation =
    await githubService.findInstallationByInstallationId(
      String(installation.id)
    );

  if (!existingInstallation) {
    log.warn("[handleInstallationUnsuspended] Installation not found", {
      installationId: installation.id,
    });
    return;
  }

  // Determine the new status:
  // - UNINSTALLED stays UNINSTALLED (user explicitly disconnected)
  // - Unclaimed installations go to PENDING_CLAIM
  // - Claimed installations go to ACTIVE
  let newStatus: GitHubInstallationStatus;
  if (existingInstallation.status === GitHubInstallationStatus.UNINSTALLED) {
    newStatus = GitHubInstallationStatus.UNINSTALLED;
  } else if (existingInstallation.organizationId === null) {
    newStatus = GitHubInstallationStatus.PENDING_CLAIM;
  } else {
    newStatus = GitHubInstallationStatus.ACTIVE;
  }

  await githubService.updateInstallationStatus(
    existingInstallation.id,
    newStatus,
    {
      suspendedAt: null,
      suspendedBy: null,
    }
  );
}

/**
 * Main handler for installation events.
 * Routes to the appropriate handler based on the event action.
 */
export async function handleInstallation(
  event: {
    action: string;
  },
  observation?: GitHubWebhookObservationContext
): Promise<Response> {
  switch (event.action) {
    case "created":
      await handleInstallationCreated(
        event as unknown as InstallationCreatedEvent,
        observation
      );
      return NextResponse.json({
        message: "Installation created successfully",
        ok: true,
      });
    case "deleted":
      await handleInstallationDeleted(
        event as unknown as InstallationDeletedEvent
      );
      return NextResponse.json({
        message: "Installation deleted successfully",
        ok: true,
      });
    case "suspend":
      await handleInstallationSuspended(
        event as unknown as InstallationSuspendEvent
      );
      return NextResponse.json({
        message: "Installation suspended successfully",
        ok: true,
      });
    case "unsuspend":
      await handleInstallationUnsuspended(
        event as unknown as InstallationUnsuspendEvent
      );
      return NextResponse.json({
        message: "Installation unsuspended successfully",
        ok: true,
      });
    default:
      return NextResponse.json({
        message: `Installation action '${event.action}' acknowledged`,
        ok: true,
      });
  }
}
