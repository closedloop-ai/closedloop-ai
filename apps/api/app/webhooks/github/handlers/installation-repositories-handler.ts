import type {
  InstallationRepositoriesAddedEvent,
  InstallationRepositoriesRemovedEvent,
} from "@octokit/webhooks-types";
import {
  GitHubDirtyScopeKind,
  GitHubDirtyTrigger,
} from "@repo/api/src/types/github-dirty-scope";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import { z } from "zod";
import { githubService } from "@/app/integrations/github/service";
import { mapWithDbConcurrency } from "@/lib/db-fanout";
import { reconcileOrgRepoSyncStatesBestEffort } from "@/lib/github/github-repo-sync-state";
import type { GitHubWebhookObservationContext } from "@/lib/github/github-webhook-observation";
import { publishGitHubDirtyScopes } from "./dirty-scope-publisher";
import { toRepositoryInput } from "./installation-handler";

const installationRepositoriesValidator = z
  .object({
    repositories: z
      .array(
        z.object({
          id: z.string(),
          githubRepoId: z.string(),
          fullName: z.string(),
        })
      )
      .optional(),
  })
  .passthrough();

/**
 * Handle GitHub App installation_repositories added event.
 * Syncs the added repositories to the database.
 */
export async function handleInstallationRepositoriesAdded(
  event: InstallationRepositoriesAddedEvent,
  observation?: GitHubWebhookObservationContext
): Promise<void> {
  const { installation, repositories_added } = event;

  log.debug(
    "[handleInstallationRepositoriesAdded] Processing repositories added",
    {
      installationId: installation.id,
      repositoryCount: repositories_added.length,
    }
  );

  if (repositories_added.length === 0) {
    return;
  }

  const existingInstallation =
    await githubService.findInstallationByInstallationId(
      String(installation.id)
    );

  if (!existingInstallation) {
    log.warn("[handleInstallationRepositoriesAdded] Installation not found", {
      installationId: installation.id,
    });
    return;
  }

  const repositoryInputs = repositories_added.map((repo) =>
    toRepositoryInput(repo, installation.account.login, {
      observation,
    })
  );

  const addedRepositories = await githubService.addRepositories(
    existingInstallation.id,
    repositoryInputs
  );
  const organizationId = existingInstallation.organizationId;
  if (organizationId) {
    // Bounded: `repositories_added` is whatever GitHub sends — granting an app
    // access to "all repositories" on a large org yields one webhook with
    // hundreds of entries — and each publish opens several pooled connections
    // plus a transaction per eligible target. Unbounded, one grant change could
    // drain the pool and starve every other route (FEA-3299 / PRD-528).
    await mapWithDbConcurrency(addedRepositories, (repo) =>
      publishGitHubDirtyScopes({
        organizationId,
        repositoryId: repo.id,
        repositoryFullName: repo.fullName,
        scopes: [
          {
            kind: GitHubDirtyScopeKind.Repository,
            repositoryId: repo.id,
            repositoryFullName: repo.fullName,
          },
        ],
        triggers: [GitHubDirtyTrigger.InstallationRepositories],
      })
    );
    // PLN-1535 M1: added repos gain installation coverage → re-evaluate this
    // org's per-repo sync tiers. Scheduled off the response path (waitUntil):
    // the reconcile is org-wide and unbounded by payload size, so awaiting it
    // could push the webhook past GitHub's delivery timeout. Best-effort —
    // self-heals on the next reconciler tick if it never runs.
    waitUntil(reconcileOrgRepoSyncStatesBestEffort(organizationId));
  }
}

/**
 * Handle GitHub App installation_repositories removed event.
 * Removes the specified repositories from the database.
 */
export async function handleInstallationRepositoriesRemoved(
  event: InstallationRepositoriesRemovedEvent
): Promise<void> {
  const { installation, repositories_removed } = event;

  log.debug(
    "[handleInstallationRepositoriesRemoved] Processing repositories removed",
    {
      installationId: installation.id,
      repositoryCount: repositories_removed.length,
    }
  );

  if (repositories_removed.length === 0) {
    return;
  }

  const existingInstallation =
    await githubService.findInstallationByInstallationId(
      String(installation.id)
    );

  if (!existingInstallation) {
    log.warn("[handleInstallationRepositoriesRemoved] Installation not found", {
      installationId: installation.id,
    });
    return;
  }

  const githubRepoIds = repositories_removed.map((repo) => String(repo.id));
  const removedRepositories = getInstallationRepositories(
    existingInstallation
  ).filter((repo) => githubRepoIds.includes(repo.githubRepoId));
  await githubService.removeRepositories(
    existingInstallation.id,
    githubRepoIds
  );
  const organizationId = existingInstallation.organizationId;
  if (organizationId) {
    // Bounded for the same reason as the added path above (FEA-3299).
    await mapWithDbConcurrency(removedRepositories, (repo) =>
      publishGitHubDirtyScopes({
        organizationId,
        repositoryId: repo.id,
        repositoryFullName: repo.fullName,
        scopes: [
          {
            kind: GitHubDirtyScopeKind.Repository,
            repositoryId: repo.id,
            repositoryFullName: repo.fullName,
          },
        ],
        triggers: [GitHubDirtyTrigger.InstallationRepositories],
      })
    );
    // PLN-1535 M1: removed repos lose installation coverage → re-evaluate this
    // org's per-repo sync tiers (they drop to tier-2 or tier-3). Scheduled off
    // the response path (waitUntil), same webhook-timeout rationale as above.
    waitUntil(reconcileOrgRepoSyncStatesBestEffort(organizationId));
  }
}

function getInstallationRepositories(installation: unknown): Array<{
  id: string;
  githubRepoId: string;
  fullName: string;
}> {
  const parsed = installationRepositoriesValidator.safeParse(installation);
  return parsed.success ? (parsed.data.repositories ?? []) : [];
}

/**
 * Main handler for installation_repositories events.
 * Routes to the appropriate handler based on the event action.
 */
export async function handleInstallationRepositories(
  event: {
    action: string;
  },
  observation?: GitHubWebhookObservationContext
): Promise<Response> {
  log.debug("[webhook/github] Received installation_repositories event", {
    action: event.action,
  });

  switch (event.action) {
    case "added":
      await handleInstallationRepositoriesAdded(
        event as unknown as InstallationRepositoriesAddedEvent,
        observation
      );
      return NextResponse.json({
        message: "Repositories added successfully",
        ok: true,
      });
    case "removed":
      await handleInstallationRepositoriesRemoved(
        event as unknown as InstallationRepositoriesRemovedEvent
      );
      return NextResponse.json({
        message: "Repositories removed successfully",
        ok: true,
      });
    default:
      return NextResponse.json({
        message: `Installation repositories action '${event.action}' acknowledged`,
        ok: true,
      });
  }
}
