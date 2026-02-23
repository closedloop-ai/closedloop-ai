import { SymphonyCommand } from "@repo/api/src/types/artifact";
import { log } from "@repo/observability/log";
import { artifactVersionService } from "@/app/artifacts/artifact-version-service";
import { CONTENT_KEYS } from "../../extractors/keys";
import { CONTENT_TRANSACTION_HANDLERS } from "./content-handlers/registry";
import { makeContentDispatcher } from "./content-handlers/types";
import type { WorkflowHandler } from "./types";

const dispatchContentHandlers = makeContentDispatcher(
  CONTENT_TRANSACTION_HANDLERS
);

/**
 * Handles successful plan, chat, and request_changes workflow runs.
 *
 * Updates the artifact content and status, persists judges reports and
 * perf summary, and creates a workstream event — all within the outer
 * transaction (`tx`) so artifact content and gitHubActionRun status
 * update are committed atomically. This prevents the frontend from
 * seeing SUCCESS status before content is ready.
 *
 * Performance data is only produced by plan-generation runs; execute runs
 * do not emit perf.jsonl, so the perf summary is intentionally absent there.
 *
 * Content-key-driven upserts (judges reports, perf summary) are handled by
 * CONTENT_TRANSACTION_HANDLERS via makeContentDispatcher. To persist a new
 * content type, add a ContentTransactionHandler to that registry — this
 * handler is closed for modification.
 */
export const planSuccessHandler: WorkflowHandler = {
  async handle(tx, ctx, bag): Promise<void> {
    const { correlationId, artifactId, workstreamId, runId, command } = ctx;

    const planContent = bag.get(CONTENT_KEYS.planContent);
    const questionsContent = bag.get(CONTENT_KEYS.questionsContent);

    // TODO: Handle questionsContent with needs_answers status in future.
    // For now, if we have questions but no plan, include them in the content.
    const finalContent = planContent ?? questionsContent;

    log.info("[planSuccessHandler] Updating artifact", {
      artifactId,
      hasContent: !!finalContent,
      contentLength: finalContent?.length ?? 0,
      command,
    });

    if (!artifactId) {
      log.error(
        "[planSuccessHandler] No artifactId in context — cannot update artifact",
        {
          correlationId,
          workstreamId,
          command,
        }
      );
      return;
    }

    const workstream = await tx.workstream.findUnique({
      where: { id: workstreamId },
      select: { organizationId: true },
    });

    if (!workstream) {
      throw new Error(
        `Workstream ${workstreamId} not found — cannot update artifact`
      );
    }

    const existingArtifact = await tx.artifact.findUnique({
      where: { id: artifactId, organizationId: workstream.organizationId },
      select: { id: true, organizationId: true, latestVersion: true },
    });

    if (!existingArtifact) {
      throw new Error(
        `Artifact ${artifactId} not found in organization — cannot update with workflow results`
      );
    }

    log.info("[planSuccessHandler] Found existing artifact", {
      artifactId,
      latestVersion: existingArtifact.latestVersion,
    });

    // Store content via ArtifactVersion instead of directly on Artifact
    if (finalContent) {
      await artifactVersionService.createVersion(
        artifactId,
        null,
        finalContent
      );
    }

    await tx.artifact.update({
      where: {
        id: artifactId,
        organizationId: existingArtifact.organizationId,
      },
      data: {
        status: "DRAFT",
      },
    });

    log.info("[planSuccessHandler] Artifact updated successfully", {
      artifactId,
      newContentLength: finalContent?.length ?? 0,
    });

    const artifactKeys = bag.keys();

    await tx.workstreamEvent.create({
      data: {
        workstreamId,
        type: "GITHUB_ACTION_COMPLETED",
        actorType: "system",
        data: {
          correlationId,
          artifactId,
          runId,
          conclusion: "success",
          artifactKeys,
        },
      },
    });

    await dispatchContentHandlers(tx, ctx, bag);

    log.info(
      `Successfully processed workflow run ${runId} for correlation ${correlationId}`
    );
  },
};

/** Commands handled by this handler — used by the registry to build the map. */
export const PLAN_HANDLER_COMMANDS = [
  SymphonyCommand.Plan,
  SymphonyCommand.Chat,
  SymphonyCommand.RequestChanges,
] as const;
