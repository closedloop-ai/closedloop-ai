import type { PullRequestEvent } from "@octokit/webhooks-types";
import { withDb } from "@repo/database";
import { verifyWebhookSignature } from "@repo/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { handleInstallation } from "./handlers/installation-handler";
import { handleInstallationRepositories } from "./handlers/installation-repositories-handler";
import { handleWorkflowRun } from "./handlers/workflow-run-handler";
import type { WorkflowRunEvent } from "./types";
import {
  isGitHubConfigured,
  isS3Configured,
  validateRequest,
} from "./webhook-service";

export async function POST(request: Request): Promise<Response> {
  log.info("[webhook/github] Received webhook request");

  if (!isGitHubConfigured()) {
    log.warn("[webhook/github] GitHub not configured, rejecting request");
    return NextResponse.json({ message: "GitHub not configured", ok: false });
  }

  const s3Configured = isS3Configured();

  try {
    const { body, signature, eventType } = await validateRequest(request);
    log.info("[webhook/github] Validating request", { eventType });

    if (!signature) {
      log.warn("[webhook/github] Missing signature header, rejecting");
      return NextResponse.json(
        { message: "Missing signature", ok: false },
        { status: 401 }
      );
    }

    if (!verifyWebhookSignature(body, signature)) {
      log.warn("[webhook/github] Invalid signature, rejecting");
      return NextResponse.json(
        { message: "Invalid signature", ok: false },
        { status: 401 }
      );
    }

    const parsedBody = JSON.parse(body) as { action?: string };

    switch (eventType) {
      case "workflow_run":
        return await handleWorkflowRun(
          parsedBody as WorkflowRunEvent,
          s3Configured
        );

      case "installation":
        return await handleInstallation(parsedBody as { action: string });

      case "installation_repositories":
        return await handleInstallationRepositories(
          parsedBody as { action: string }
        );

      case "pull_request": {
        const prEvent = parsedBody as PullRequestEvent;
        if (prEvent.action === "closed" && prEvent.pull_request.merged) {
          await withDb(async (db) => {
            const pr = await db.gitHubPullRequest.findFirst({
              where: { githubId: prEvent.pull_request.id },
            });
            if (pr?.workstreamId) {
              // Update PR state to MERGED
              await db.gitHubPullRequest.update({
                where: { id: pr.id },
                data: {
                  state: "MERGED",
                  mergedAt: prEvent.pull_request.merged_at
                    ? new Date(prEvent.pull_request.merged_at)
                    : null,
                },
              });

              // Query artifact to get documentSlug for event
              const artifact = pr.artifactId
                ? await db.artifact.findUnique({
                    where: { id: pr.artifactId },
                    select: { documentSlug: true },
                  })
                : null;

              await db.workstreamEvent.create({
                data: {
                  workstreamId: pr.workstreamId,
                  type: "GITHUB_PR_MERGED",
                  actorType: "system",
                  data: {
                    prTitle: prEvent.pull_request.title,
                    prUrl: prEvent.pull_request.html_url,
                    artifactId: pr.artifactId,
                    documentSlug: artifact?.documentSlug,
                    prNumber: prEvent.pull_request.number,
                  },
                },
              });
            }
          });
        }
        return NextResponse.json({
          message: "Pull request event processed",
          ok: true,
        });
      }

      default: {
        log.info("[webhook/github] Ignoring unsupported event type", {
          eventType,
          reason: "Event type not supported",
        });
        return NextResponse.json({
          message: `Ignoring event type: ${eventType}`,
          ok: true,
        });
      }
    }
  } catch (error) {
    const message = parseError(error);
    log.error("[webhook/github] Unhandled error processing webhook", {
      error: message,
    });
    return NextResponse.json(
      { message: "Something went wrong", ok: false },
      { status: 500 }
    );
  }
}
