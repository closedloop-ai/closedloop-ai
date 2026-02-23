import { log } from "@repo/observability/log";
import type { WorkflowHandler } from "./types";

/**
 * Handles failed workflow runs.
 *
 * IMPORTANT: Never overwrites artifact content with error messages.
 * Errors are tracked via GitHubActionRun status and workstream events.
 * The UI surfaces failures via the status banner.
 *
 * Uses the outer transaction (`tx`) so the workstream event and
 * gitHubActionRun status update are atomic.
 *
 * `bag` is always empty for failure paths — no artifacts are downloaded.
 * `ctx.htmlUrl` carries the GitHub Actions run URL for the event record.
 */
export const workflowFailureHandler: WorkflowHandler = {
  async handle(tx, ctx, _bag): Promise<void> {
    const { correlationId, artifactId, workstreamId, runId, command, htmlUrl } =
      ctx;

    await tx.workstreamEvent.create({
      data: {
        workstreamId,
        type: "GITHUB_ACTION_COMPLETED",
        actorType: "system",
        data: {
          correlationId,
          artifactId,
          runId,
          command,
          conclusion: "failure",
          htmlUrl,
        },
      },
    });

    log.error(`Workflow run ${runId} failed for correlation ${correlationId}`, {
      htmlUrl,
      artifactId,
      command,
    });
  },
};
