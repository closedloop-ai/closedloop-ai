import type { PushEvent } from "@octokit/webhooks-types";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";

/**
 * Handle GitHub push webhook events.
 *
 * Updates lastPushedAt timestamp for the repository and logs push metadata.
 * Silently skips if no matching installation repository found.
 *
 * Security: Scopes updates to the specific installation to prevent updating
 * repositories across multiple installations with the same githubRepoId.
 */
export async function handlePush(event: PushEvent): Promise<Response> {
  const { ref, repository, before, after, commits, installation } = event;

  const installationId = installation?.id;

  log.info("[handlePush] Processing push event", {
    repositoryFullName: repository.full_name,
    githubRepoId: repository.id,
    installationId,
    ref,
    commitsCount: commits.length,
    beforeSha: before,
    afterSha: after,
  });

  // Update lastPushedAt in a single query — no separate lookup needed.
  // updateMany returns { count } so we know if a matching repo existed.
  // Security: Scope to installationId if available to prevent cross-tenant updates.
  // The installationId from the event is GitHub's installation ID (number),
  // which we filter via the nested relation to GitHubInstallation.
  const whereClause = installationId
    ? {
        githubRepoId: repository.id,
        installation: { installationId },
      }
    : {
        githubRepoId: repository.id,
      };

  const { count } = await withDb((db) =>
    db.gitHubInstallationRepository.updateMany({
      where: whereClause,
      data: { lastPushedAt: new Date() },
    })
  );

  if (count === 0) {
    log.debug("[handlePush] Repository not found in database, skipping", {
      githubRepoId: repository.id,
      repositoryFullName: repository.full_name,
    });
    return NextResponse.json({
      message: "Repository not tracked, ignoring push event",
      ok: true,
    });
  }

  log.info("[handlePush] Updated lastPushedAt timestamp", {
    githubRepoId: repository.id,
    updatedCount: count,
  });

  return NextResponse.json({
    message: "Push event processed successfully",
    ok: true,
  });
}
