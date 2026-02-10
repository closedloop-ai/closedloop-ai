import type {
  InstallationRepositoriesAddedEvent,
  InstallationRepositoriesRemovedEvent,
} from "@octokit/webhooks-types";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { githubService } from "@/app/integrations/github/service";
import { toRepositoryInput } from "./installation-handler";

/**
 * Handle GitHub App installation_repositories added event.
 * Syncs the added repositories to the database.
 */
export async function handleInstallationRepositoriesAdded(
  event: InstallationRepositoriesAddedEvent
): Promise<void> {
  const { installation, repositories_added } = event;

  log.info(
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
    await githubService.findInstallationByInstallationId(installation.id);

  if (!existingInstallation) {
    log.warn("[handleInstallationRepositoriesAdded] Installation not found", {
      installationId: installation.id,
    });
    return;
  }

  const repositoryInputs = repositories_added.map((repo) =>
    toRepositoryInput(repo, installation.account.login)
  );

  await githubService.addRepositories(
    existingInstallation.id,
    repositoryInputs
  );
}

/**
 * Handle GitHub App installation_repositories removed event.
 * Removes the specified repositories from the database.
 */
export async function handleInstallationRepositoriesRemoved(
  event: InstallationRepositoriesRemovedEvent
): Promise<void> {
  const { installation, repositories_removed } = event;

  log.info(
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
    await githubService.findInstallationByInstallationId(installation.id);

  if (!existingInstallation) {
    log.warn("[handleInstallationRepositoriesRemoved] Installation not found", {
      installationId: installation.id,
    });
    return;
  }

  const githubRepoIds = repositories_removed.map((repo) => repo.id);
  await githubService.removeRepositories(
    existingInstallation.id,
    githubRepoIds
  );
}

/**
 * Main handler for installation_repositories events.
 * Routes to the appropriate handler based on the event action.
 */
export async function handleInstallationRepositories(event: {
  action: string;
}): Promise<Response> {
  log.info("[webhook/github] Received installation_repositories event", {
    action: event.action,
  });

  switch (event.action) {
    case "added":
      await handleInstallationRepositoriesAdded(
        event as unknown as InstallationRepositoriesAddedEvent
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
